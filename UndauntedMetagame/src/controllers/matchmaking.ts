import { logger } from "../logger";
import crypto from "node:crypto";
import {
    ClearPartyCandidate, GetPartyOf, LAST_CANDIDATE_REJOIN_MS, MarkPartyCandidateReady, MarkPartyCandidateServed, Party, PartyCandidate,
    PartyForMatchmaking, PartyNow, RemoveFromPartyCandidate, SetCandidateLeaveHook, SetPartyCandidate, TouchPlayer
} from "./party";

const MATCHMAKING_MODE = process.env.MATCHMAKING_MODE;
const DEPLOYSERVER_URL = process.env.DEPLOYSERVER_URL;
const DEPLOYSERVER_MATCHMAKING_PATH = "/api/matchmaker/handle-matchmaking-for-player";

// A party's join waits this long at most for the deploy server, so the leader's first status
// poll (sent right after the join) can already travel; the rest is picked up by later polls
const PARTY_JOIN_WAIT_MS = 2500;
// A player who joins the hunt their party is already on (the client sends a second join
// while it loads into the island) gets MATCHING for this long and nothing new is started;
// if they are still asking after it, they are sent to the party's server again
export const REJOIN_PARK_MS = 20 * 1000;
// A hunt queue goes to the deploy server this long after its last join (checked when a queued
// player polls), or at once when it reaches QUEUE_FULL_PLAYERS
const QUEUE_WAIT_MS = 20 * 1000;
const QUEUE_FULL_PLAYERS = 4;
// Capacity is not an endless queue. End the attempt promptly when the host stays full.
export const CAPACITY_WAIT_MS = 60 * 1000;

type MatchmakingQueueData = {
    RetryAfter?: number,
    CapacityDeadline?: number,
    Players: string[],         // distinct account ids, in join order: a player is in at most one queue
    LastPlayerAddedTime: number, // PartyNow(), the clock the rest of matchmaking uses
    Resolved: boolean
};

export type MatchmakingResult = {
    Ready: boolean,
    HuntId: string,
    CandidateId: string,
    Host: string,
    Port: number,
    Failed?: boolean,          // no game server could be started: the status poll answers FAILED
    PartyCandidate?: boolean,  // part of a party's candidate (no per-hunt queue behind it)
    PartyMemberIds?: string[], // the candidate's members, for the status reply's playerStates
    ParkedAt?: number          // a re-join after being sent (see REJOIN_PARK_MS)
};

type LaunchResult = {
    capacity?: boolean,
    succeeded: boolean,
    readyNow: boolean,
    host: string,
    port: number
};

let MatchmakingQueueMap: Map<string, MatchmakingQueueData> = new Map<string, MatchmakingQueueData>(); // Key is HuntID
let MatchmakingResultMap: Map<string, MatchmakingResult> = new Map<string, MatchmakingResult>(); // Key is PlayerID
// The server each player was last told to travel to (the status poll's IN_PROGRESS)
const LastSentMap = new Map<string, { Host: string, Port: number, HuntId: string, At: number }>();

type CapacityWait = { next: number, deadline: number, busy: boolean, retry: () => Promise<boolean> };
const CapacityWaits = new Map<string, CapacityWait>();
function ParkCapacity(CandidateId: string, retry: () => Promise<boolean>) {
    // No background launches: only an active candidate's status poll can retry.
    for (const [id, wait] of CapacityWaits) {
        const entries = [...MatchmakingResultMap.entries()].filter(([, entry]) => entry.CandidateId === id && !entry.Failed && !entry.Ready);
        if (wait.deadline < PartyNow()) for (const [player, entry] of entries) {
            entry.Failed = true;
            const party = GetPartyOf(player);
            if (party) ClearPartyCandidate(party, id, 'capacity wait expired');
        }
        if (wait.deadline < PartyNow() || entries.length === 0) CapacityWaits.delete(id);
    }
    if (CapacityWaits.size >= 1000) return false;
    CapacityWaits.set(CandidateId, {next: PartyNow() + 10000, deadline: PartyNow() + CAPACITY_WAIT_MS, busy: false, retry});
    return true;
}

function HuntIdRequiresMatchmaking(HuntId: string){
    return !HuntId.includes("Ramsgate") && !HuntId.includes("Dojo");
    //return HuntId.includes("CR19") || HuntId.includes("11A") || HuntId.includes("Story");
}

// Each account once, in first-seen order. A hunt server waits for every expected player, so a
// player listed twice keeps it waiting for someone who never comes: on 22 September 2026 the
// list was V, V, O and the airship countdown froze with both real players ready.
export function DistinctPlayers(PlayerIds: string[]): string[] {
    return [...new Set(PlayerIds)];
}

// Never throws: an unreachable deploy server or an unusable answer is a failed launch
async function LaunchGameOnDeployserver(GameMode: string, GameArgs: string, HuntId: string, AskedPlayers: string[] | undefined): Promise<LaunchResult> {
    const ExpectedPlayers = AskedPlayers === undefined ? undefined : DistinctPlayers(AskedPlayers);

    if(AskedPlayers !== undefined && ExpectedPlayers!.length !== AskedPlayers.length){
        logger.warn(`mm: ${HuntId}: ${AskedPlayers.length - ExpectedPlayers!.length} repeated expected player(s) dropped (${AskedPlayers.join(",")})`);
    }

    logger.info(`Querying DeployServer for GameMode: ${GameMode} HuntId ${HuntId} with ${ExpectedPlayers?.length} Expected Players!`);

    const URL = "http://" + DEPLOYSERVER_URL + DEPLOYSERVER_MATCHMAKING_PATH;
    const Failed: LaunchResult = { succeeded: false, readyNow: false, host: "", port: 0 };

    let MatchmakingResult: Response;

    try{
        MatchmakingResult = await fetch(URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                GameMode: GameMode,
                GameArgs: GameArgs,
                HuntId: HuntId,
                ExpectedPlayers: ExpectedPlayers!
            })
        });
    }
    catch(error){
        logger.error(`DeployServer could not be reached: ${(error as Error)?.message}`);

        return Failed;
    }

    if (MatchmakingResult.status === 503) {
        try {
            const body = await MatchmakingResult.json();
            if (body?.error === 'capacity_unavailable' && ['memory', 'ports'].includes(body.reason)) {
                logger.warn({reason: body.reason, huntId: HuntId, capacityWaitMs: CAPACITY_WAIT_MS}, 'mm: allocation waiting for capacity');
                return {...Failed, capacity: true};
            }
        } catch {}
        return Failed;
    }
    if(MatchmakingResult.status === 200){
        let MatchmakingData: any;

        try{
            MatchmakingData = await MatchmakingResult.json();
        }
        catch{
            logger.error(`DeployServer answered 200 without a JSON body`);

            return Failed;
        }

        const Host = MatchmakingData?.host;
        const Port = MatchmakingData?.port;

        // The client needs a non-empty host and a numeric port, or it polls forever or refuses the session
        if(typeof Host !== "string" || Host.length === 0 || !Number.isInteger(Port) || Port <= 0 || Port > 65535){
            logger.error(`DeployServer returned no usable game server`);

            return Failed;
        }

        logger.info(`DeployServer returned gameserver ${Host}:${Port}`);

        return {
            succeeded: true,
            readyNow: true,
            host: Host,
            port: Port
        }
    }
    else{
        logger.error(`DeployServer returned status ${MatchmakingResult.status}`);

        try{ await MatchmakingResult.body?.cancel(); } catch {}

        return Failed;
    }
}

async function PopQueue(HuntId: string){
    const MatchmakingQueue = MatchmakingQueueMap.get(HuntId);

    if(MatchmakingQueue == undefined || MatchmakingQueue.Resolved || (MatchmakingQueue.RetryAfter ?? 0) > PartyNow()){
        return;
    }

    MatchmakingQueue.Resolved = true;

    const GameOnDeployServer: LaunchResult = MatchmakingQueue.CapacityDeadline !== undefined && PartyNow() >= MatchmakingQueue.CapacityDeadline
        ? {succeeded: false, readyNow: false, host: '', port: 0}
        : await LaunchGameOnDeployserver("ISLAND", "", HuntId, MatchmakingQueue.Players);

    if (GameOnDeployServer.capacity) {
        MatchmakingQueue.CapacityDeadline ??= PartyNow() + CAPACITY_WAIT_MS;
        if (PartyNow() < MatchmakingQueue.CapacityDeadline) {
            MatchmakingQueue.Resolved = false;
            MatchmakingQueue.RetryAfter = PartyNow() + 10000;
            return;
        }
    }

    for(const Player of MatchmakingQueue.Players){
        const PlayerMatchmakingResultToUpdate = MatchmakingResultMap.get(Player);

        // Only the entry this queue made: not a newer join, and not a party candidate that took the player since
        if(PlayerMatchmakingResultToUpdate != undefined && !PlayerMatchmakingResultToUpdate.Ready && !PlayerMatchmakingResultToUpdate.PartyCandidate && PlayerMatchmakingResultToUpdate.HuntId === HuntId){
            if(GameOnDeployServer.succeeded){
                PlayerMatchmakingResultToUpdate.Host = GameOnDeployServer.host;
                PlayerMatchmakingResultToUpdate.Port = GameOnDeployServer.port;
                PlayerMatchmakingResultToUpdate.Ready = true;
            }
            else{
                PlayerMatchmakingResultToUpdate.Failed = true;
            }
        }
    }

    if(!GameOnDeployServer.succeeded){
        logger.warn(`mm: the ${HuntId} queue (${MatchmakingQueue.Players.join(",")}) got no game server; their status polls answer FAILED`);
    }

    if(MatchmakingQueueMap.get(HuntId) === MatchmakingQueue){
        MatchmakingQueueMap.delete(HuntId);
    }
}

export async function CheckAndUpdateQueueStatus(PlayerId: string){
    const PlayerMatchmakingResult = MatchmakingResultMap.get(PlayerId);

    if(PlayerMatchmakingResult == undefined){
        return undefined;
    }

    const waiting = CapacityWaits.get(PlayerMatchmakingResult.CandidateId);
    if (waiting) {
        if (PartyNow() >= waiting.deadline) {
            CapacityWaits.delete(PlayerMatchmakingResult.CandidateId);
            for (const entry of MatchmakingResultMap.values()) if (entry.CandidateId === PlayerMatchmakingResult.CandidateId) entry.Failed = true;
            const party = GetPartyOf(PlayerId);
            if (party) ClearPartyCandidate(party, PlayerMatchmakingResult.CandidateId, 'capacity wait expired');
        } else if (!waiting.busy && PartyNow() >= waiting.next) {
            waiting.busy = true;
            waiting.next = PartyNow() + 10000;
            try { if (await waiting.retry()) CapacityWaits.delete(PlayerMatchmakingResult.CandidateId); }
            finally { waiting.busy = false; }
        }
        return PlayerMatchmakingResult;
    }

    // Party candidates have no queue: the leader's join started their server already
    if(!PlayerMatchmakingResult.Ready && !PlayerMatchmakingResult.Failed && !PlayerMatchmakingResult.PartyCandidate){
        const MatchmakingQueue = MatchmakingQueueMap.get(PlayerMatchmakingResult.HuntId);

        if(MatchmakingQueue == undefined){
            logger.warn(`mm: ${PlayerId} waits for ${PlayerMatchmakingResult.HuntId} but no queue holds them; answering FAILED`);
            PlayerMatchmakingResult.Failed = true;

            return PlayerMatchmakingResult;
        }

        if(PartyNow() - MatchmakingQueue.LastPlayerAddedTime > QUEUE_WAIT_MS || (MatchmakingQueue.RetryAfter !== undefined && PartyNow() >= MatchmakingQueue.RetryAfter)){
            await PopQueue(PlayerMatchmakingResult.HuntId);
        }
    }

    return PlayerMatchmakingResult;
}

// TODO: This can fail if the previous party is waiting for the deployserver, and a new party is joining in.
// Right now we handle this by failing all new players until the old party is cleared out
// This can be MUCH better in the future
async function QueuePlayer(HuntId: string, PlayerId: string){
    const ExistingQueue = MatchmakingQueueMap.get(HuntId);
    if(ExistingQueue?.Resolved || (ExistingQueue && ExistingQueue.Players.length >= QUEUE_FULL_PLAYERS && !ExistingQueue.Players.includes(PlayerId))){
        return false;
    }

    // A player has at most one queued join: this one replaces any older one still waiting, in this
    // hunt's queue or another's. Before, a join the player had made earlier (never matched, and its
    // cancel is ignored on purpose, see routes/matchmaking.ts) stayed in the queue, the new join was
    // added next to it, and the hunt server was told to expect the player twice.
    LeaveWaitingQueues(PlayerId, "their new join replaces it");

    // Looked up again: the player's older join may have been the only one in this hunt's queue
    const Queue = MatchmakingQueueMap.get(HuntId);

    MatchmakingResultMap.set(PlayerId, {
        Ready: false,
        CandidateId: crypto.randomUUID(),
        HuntId: HuntId,
        Host: "",
        Port: 0
    });

    if(Queue === undefined){
        MatchmakingQueueMap.set(HuntId, {
            Players: [PlayerId],
            LastPlayerAddedTime: PartyNow(),
            Resolved: false
        });

        return true;
    }

    Queue.Players.push(PlayerId);
    Queue.LastPlayerAddedTime = PartyNow();

    if(Queue.Players.length >= QUEUE_FULL_PLAYERS){
        await PopQueue(HuntId);
    }

    return true;
}

// A player follows one candidate at a time (their entry in MatchmakingResultMap). Whatever replaces
// it takes them out of every queue still waiting, so no hunt server is told to expect a player who
// went elsewhere, or the same player twice. A queue already asking the deploy server is left alone.
function LeaveWaitingQueues(PlayerId: string, Why: string){
    for(const [HuntId, Queue] of [...MatchmakingQueueMap.entries()]){
        if(!Queue.Resolved && Queue.Players.includes(PlayerId)){
            Queue.Players = Queue.Players.filter((Player) => Player !== PlayerId);

            if(Queue.Players.length === 0){
                MatchmakingQueueMap.delete(HuntId);
            }

            logger.info(`mm: ${PlayerId} taken out of the ${HuntId} queue: ${Why}`);
        }
    }
}

// A player going somewhere on their own no longer counts in their party's candidate
function ForgetPartyCandidateEntry(PlayerId: string){
    const Entry = MatchmakingResultMap.get(PlayerId);

    if(Entry?.PartyCandidate){
        RemoveFromPartyCandidate(PlayerId, Entry.CandidateId);
    }
}

// DELETE /candidate, only with MATCHMAKING_CANCEL=1 (see routes/matchmaking.ts). Upstream
// had no route, so a cancel failed and the queue popped ~20 s later anyway. Takes the
// player out of an unresolved queue (dropping it when empty) and forgets their result,
// so /candidate/status can no longer answer IN_PROGRESS for them. A party leader's cancel
// clears the party's candidate and the members' entries that were not sent yet; another
// member's cancel only takes that member out of it.
export function CancelMatchmaking(PlayerId: string){
    const PlayerMatchmakingResult = MatchmakingResultMap.get(PlayerId);

    if(PlayerMatchmakingResult == undefined){
        return undefined;
    }

    if(PlayerMatchmakingResult.PartyCandidate){
        const TheParty = GetPartyOf(PlayerId);
        const CandidateId = PlayerMatchmakingResult.CandidateId;

        if(TheParty !== undefined && TheParty.LeaderId === PlayerId && TheParty.Candidate?.CandidateId === CandidateId){
            let Dropped = 0;

            for(const Member of TheParty.Candidate.MemberIds){
                const Entry = MatchmakingResultMap.get(Member);

                if(Member !== PlayerId && Entry !== undefined && Entry.CandidateId === CandidateId && !Entry.Ready){
                    MatchmakingResultMap.delete(Member);
                    Dropped++;
                }
            }

            ClearPartyCandidate(TheParty, CandidateId, `cancelled by the leader ${PlayerId}`);
            logger.info(`mm: cancel by=${PlayerId} party P=${TheParty.PartyId} candidate ${CandidateId}: ${Dropped} member entr${Dropped === 1 ? "y" : "ies"} not yet sent dropped`);
        }
        else{
            RemoveFromPartyCandidate(PlayerId, CandidateId);
            logger.info(`mm: cancel by=${PlayerId} candidate ${CandidateId}: left the party's candidate`);
        }

        MatchmakingResultMap.delete(PlayerId);

        return PlayerMatchmakingResult;
    }

    const MatchmakingQueue = MatchmakingQueueMap.get(PlayerMatchmakingResult.HuntId);

    if(MatchmakingQueue != undefined && !MatchmakingQueue.Resolved){
        MatchmakingQueue.Players = MatchmakingQueue.Players.filter((Player) => Player !== PlayerId);

        if(MatchmakingQueue.Players.length === 0){
            MatchmakingQueueMap.delete(PlayerMatchmakingResult.HuntId);
        }
    }

    MatchmakingResultMap.delete(PlayerId);

    return PlayerMatchmakingResult;
}

// DELETE /candidate/leave, also only with MATCHMAKING_CANCEL=1: the caller alone leaves
// their candidate (a party leader's candidate goes on for the others)
export function LeaveCandidate(PlayerId: string){
    const PlayerMatchmakingResult = MatchmakingResultMap.get(PlayerId);

    if(PlayerMatchmakingResult == undefined || !PlayerMatchmakingResult.PartyCandidate){
        return CancelMatchmaking(PlayerId);
    }

    RemoveFromPartyCandidate(PlayerId, PlayerMatchmakingResult.CandidateId);
    MatchmakingResultMap.delete(PlayerId);
    logger.info(`mm: leave by=${PlayerId} candidate ${PlayerMatchmakingResult.CandidateId}`);

    return PlayerMatchmakingResult;
}

// A member who leaves the party while its candidate is still starting does not go along
SetCandidateLeaveHook((UserId, CandidateId) => {
    const Entry = MatchmakingResultMap.get(UserId);

    if(Entry !== undefined && Entry.PartyCandidate && Entry.CandidateId === CandidateId && !Entry.Ready){
        MatchmakingResultMap.delete(UserId);
        logger.info(`mm: ${UserId} left the party before candidate ${CandidateId} got its server; they stay behind`);
    }
});

// Read-only, for /undaunted/api/ServerStatus: the game server a player was last sent to.
// In memory like the rest of matchmaking, so it is empty after a metagame restart.
export function GetLastMatchmakingResult(PlayerId: string){
    const Result = MatchmakingResultMap.get(PlayerId);

    return Result == undefined ? undefined : {Ready: Result.Ready, HuntId: Result.HuntId, Port: Result.Port};
}

// GET /candidate/status: what to answer, with the bookkeeping of a player being sent
export type CandidateStatusDecision =
    | { Kind: "unknown" }
    | { Kind: "failed" | "matching" | "travel", Entry: MatchmakingResult, Parked?: boolean };

export async function DecideCandidateStatus(PlayerId: string): Promise<CandidateStatusDecision> {
    const Entry = await CheckAndUpdateQueueStatus(PlayerId);

    if(Entry == undefined){
        return { Kind: "unknown" };
    }

    // A player polling for their party's candidate is still there
    if(Entry.PartyCandidate){
        TouchPlayer(PlayerId);
    }

    if(Entry.Failed){
        return { Kind: "failed", Entry: Entry };
    }

    if(!Entry.Ready){
        return { Kind: "matching", Entry: Entry };
    }

    if(Entry.ParkedAt !== undefined){
        if(PartyNow() - Entry.ParkedAt < REJOIN_PARK_MS){
            return { Kind: "matching", Entry: Entry, Parked: true };
        }

        Entry.ParkedAt = undefined;
        logger.info(`mm: ${PlayerId} still asking ${REJOIN_PARK_MS / 1000} s after joining candidate ${Entry.CandidateId} again: sending them to ${Entry.Host}:${Entry.Port} again`);
    }

    LastSentMap.set(PlayerId, { Host: Entry.Host, Port: Entry.Port, HuntId: Entry.HuntId, At: PartyNow() });

    if(Entry.PartyCandidate){
        MarkPartyCandidateServed(PlayerId, Entry.CandidateId);
    }

    return { Kind: "travel", Entry: Entry };
}

// What a client may send to /candidate/join. Its input ends up on a game server's command
// line: the deploy server passes the map and the behemoth from the client's own game args
// (the tutorial), and the hunt id inside the expected-player list. So only the shapes the
// client really sends are let through; the deploy server checks the same again.
// Keep in sync with UndauntedDeployServer/src/controllers/matchmakinginput.ts.
const HUNT_ID = /^[A-Za-z0-9_+]{1,128}$/; // e.g. CR19_PlayerHunt_FTUE_Pursuit_Beta_LeRawr, ..._Patrol_Heroic+_Gem
const GAME_ARGS_CHARACTERS = /^[A-Za-z0-9_/.?=+-]{1,2048}$/;
const GAME_MAP_PATH = /^\/Game(\/[A-Za-z0-9_]+)+(\.[A-Za-z0-9_]+)?$/; // /Game/Maps/islands/1705/dia_moss_triforce
const GAME_ASSET_PATH = /^\/Game(\/[A-Za-z0-9_]+)+\.[A-Za-z0-9_]+$/; // /Game/Monsters/mcrollin/mcbeaver_tutorial_bp.mcbeaver_tutorial_bp_C

// undefined when the input is acceptable, else what is wrong with it
export function CheckMatchmakingInput(GameMode: unknown, GameArgs: unknown, HuntId: unknown): string | undefined {
    if(HuntId != undefined && !(typeof HuntId === "string" && (HuntId.length === 0 || HUNT_ID.test(HuntId)))){
        return "the hunt id is not a hunt id";
    }

    if(GameArgs != undefined && typeof GameArgs !== "string"){
        return "the game args are not a string";
    }

    // Used only for ISLAND: map ? option ? MonsterClass=<behemoth> ? ... (deploy server's StartupGameserverWithArgs)
    if(GameMode === "ISLAND" && typeof GameArgs === "string" && GameArgs.trim().length > 0){
        const Parts = GameArgs.split("?");
        const Behemoth = Parts[2]?.split("=")[1];

        if(!GAME_ARGS_CHARACTERS.test(GameArgs) || !GAME_MAP_PATH.test(Parts[0]) || Behemoth === undefined || (Behemoth.length > 0 && !GAME_ASSET_PATH.test(Behemoth))){
            return "the game args are not a map and behemoth the deploy server can start";
        }
    }

    return undefined;
}

// ---- Parties (roadmap 1.9, parties plan section 4): the whole party on one server ----
//
// Only the leader starts the party's hunts. Its join makes one candidate for all members
// and asks the deploy server once, with every member expected (their objectives and
// rewards need that). The members never join: they see the candidate in their POST /party
// poll and then poll GET /candidate/status, which answers each of them from their own entry
// here. Going back to Ramsgate (CITY) or the Dojo (SHARED) takes the members who are on the
// leader's current server along. A party of one, and the tutorial, use the solo code above.

async function FinishPartyCandidate(TheParty: Party, CandidateId: string, Members: string[], Game: LaunchResult){
    let Updated = 0;

    for(const Member of Members){
        const Entry = MatchmakingResultMap.get(Member);

        if(Entry === undefined || Entry.CandidateId !== CandidateId){
            continue;
        }

        if(Game.succeeded){
            Entry.Host = Game.host;
            Entry.Port = Game.port;
            Entry.Ready = true;
        }
        else{
            Entry.Failed = true;
        }

        Updated++;
    }

    if(Game.succeeded){
        MarkPartyCandidateReady(TheParty, CandidateId, Game.host, Game.port);
        logger.info(`mm: party P=${TheParty.PartyId} candidate ${CandidateId} ready at ${Game.host}:${Game.port} for ${Updated} member(s)`);
    }
    else{
        ClearPartyCandidate(TheParty, CandidateId, "no game server could be started");
        logger.warn(`mm: party P=${TheParty.PartyId} candidate ${CandidateId} got no game server; ${Updated} member(s) will see FAILED`);
    }
}

async function StartPartyCandidate(TheParty: Party, GameMode: string, HuntId: string, Members: string[], LeaderId: string){
    const CandidateId = crypto.randomUUID();

    for(const Member of Members){
        LeaveWaitingQueues(Member, "their party's hunt takes them");

        MatchmakingResultMap.set(Member, {
            Ready: false,
            CandidateId: CandidateId,
            HuntId: HuntId,
            Host: "",
            Port: 0,
            PartyCandidate: true,
            PartyMemberIds: [...Members]
        });
    }

    SetPartyCandidate(TheParty, {
        CandidateId: CandidateId,
        State: "MATCHING",
        GameMode: GameMode,
        HuntId: HuntId,
        MemberIds: [...Members],
        Served: new Set<string>(),
        CreatedAt: PartyNow()
    });

    logger.info(`mm: party P=${TheParty.PartyId} candidate ${CandidateId} mode=${GameMode} hunt=${HuntId} members=${Members.join(",")} by=${LeaderId}`);

    const TryLaunch = async () => {
        const Active = Members.filter(member => MatchmakingResultMap.get(member)?.CandidateId === CandidateId && TheParty.Members.includes(member));
        if (TheParty.Candidate?.CandidateId !== CandidateId || Active.length === 0) return true;
        const Game = await LaunchGameOnDeployserver(GameMode, '', HuntId, GameMode === 'ISLAND' ? Active : undefined);
        if (Game.capacity) return false;
        await FinishPartyCandidate(TheParty, CandidateId, Active, Game);
        return true;
    };
    const Launch = TryLaunch()
        .then(async done => { if (!done && !ParkCapacity(CandidateId, TryLaunch)) await FinishPartyCandidate(TheParty, CandidateId, Members, {succeeded: false, readyNow: false, host: '', port: 0}); })
        .catch((error) => logger.error(`mm: party candidate ${CandidateId} launch failed: ${(error as Error)?.message}`));

    let Timer: NodeJS.Timeout | undefined;

    await Promise.race([Launch, new Promise<void>((Resolve) => { Timer = setTimeout(Resolve, PARTY_JOIN_WAIT_MS); })]);
    clearTimeout(Timer);
}

function FindRejoinCandidate(TheParty: Party, PlayerId: string, GameMode: string, HuntId: string, IsLeader: boolean){
    const Matches = (Candidate: PartyCandidate | null): Candidate is PartyCandidate =>
        Candidate != null && Candidate.GameMode === GameMode && Candidate.HuntId === HuntId && Candidate.MemberIds.includes(PlayerId);

    if(Matches(TheParty.Candidate)){
        return TheParty.Candidate;
    }

    const Last = TheParty.LastCandidate;

    if(!IsLeader && Matches(Last) && Last.State === "IN_PROGRESS" && PartyNow() - Last.CreatedAt <= LAST_CANDIDATE_REJOIN_MS){
        return Last;
    }

    return undefined;
}

// The join is for the candidate the player is already part of: nothing new is started
function RejoinPartyCandidate(TheParty: Party, Candidate: PartyCandidate, PlayerId: string){
    const Entry = MatchmakingResultMap.get(PlayerId);
    const Where = `candidate ${Candidate.CandidateId} of P=${TheParty.PartyId} (${Candidate.HuntId})`;

    if(Entry !== undefined && Entry.PartyCandidate && Entry.CandidateId === Candidate.CandidateId && !Entry.Failed){
        if(!Entry.Ready){
            logger.info(`mm: ${PlayerId} joined again while ${Where} is still starting; nothing new started`);
        }
        else if(Candidate.Served.has(PlayerId) || Entry.ParkedAt !== undefined){
            Entry.ParkedAt = PartyNow();
            logger.info(`mm: ${PlayerId} joined again after being sent to ${Entry.Host}:${Entry.Port} for ${Where}; no second server, answering MATCHING`);
        }
        else{
            logger.info(`mm: ${PlayerId} joined again before being sent to ${Where}; nothing new started`);
        }

        return;
    }

    const Ready = Candidate.State === "IN_PROGRESS" && Candidate.Host !== undefined && Candidate.Port !== undefined;
    const Served = Candidate.Served.has(PlayerId);

    LeaveWaitingQueues(PlayerId, "their party's candidate takes them");

    MatchmakingResultMap.set(PlayerId, {
        Ready: Ready,
        CandidateId: Candidate.CandidateId,
        HuntId: Candidate.HuntId,
        Host: Ready ? Candidate.Host! : "",
        Port: Ready ? Candidate.Port! : 0,
        PartyCandidate: true,
        PartyMemberIds: [...Candidate.MemberIds],
        ParkedAt: Ready && Served ? PartyNow() : undefined
    });

    logger.info(`mm: ${PlayerId} joined ${Where} again; ${Ready ? (Served ? "already sent there once, answering MATCHING" : "its server is up") : "still starting"}; no second server`);
}

// POST /candidate/join/:candidateId. The 1.4.4 client can join a given candidate ("CandidateJoin",
// "/candidate/join/" in the exe); a party member's client may follow the leader's candidate this
// way rather than only polling. Answered for a member of that candidate like their own join of
// it; anyone else gets undefined (404, as before the route existed).
export function JoinPartyCandidateById(PlayerId: string, CandidateId: string): PartyCandidate | undefined {
    const TheParty = PartyForMatchmaking(PlayerId);

    if(TheParty === undefined){
        return undefined;
    }

    const Current = TheParty.Candidate;
    const Last = TheParty.LastCandidate;
    let Candidate: PartyCandidate | undefined;

    if(Current != null && Current.CandidateId === CandidateId){
        Candidate = Current;
    }
    else if(Last != null && Last.CandidateId === CandidateId && Last.State === "IN_PROGRESS" && PartyNow() - Last.CreatedAt <= LAST_CANDIDATE_REJOIN_MS){
        Candidate = Last;
    }

    if(Candidate === undefined || !Candidate.MemberIds.includes(PlayerId)){
        return undefined;
    }

    RejoinPartyCandidate(TheParty, Candidate, PlayerId);

    return Candidate;
}

// "solo": not a party matter, use the solo code; true: handled; false: refused (400)
async function HandlePartyMatchmaking(GameMode: unknown, GameArgs: unknown, HuntId: unknown, PlayerId: string): Promise<"solo" | boolean> {
    const TheParty = PartyForMatchmaking(PlayerId);

    if(TheParty === undefined || TheParty.Members.length < 2){
        return "solo";
    }

    const Mode = typeof GameMode === "string" ? GameMode : "";
    const Hunt = typeof HuntId === "string" ? HuntId : "";
    const IsLeader = TheParty.LeaderId === PlayerId;

    if(Mode === "ISLAND" && typeof GameArgs === "string" && GameArgs.trim().length > 0){
        logger.info(`mm: ${PlayerId} (party P=${TheParty.PartyId}) starts a game from its own game args (the tutorial): alone`);
        return "solo";
    }

    const Rejoin = FindRejoinCandidate(TheParty, PlayerId, Mode, Hunt, IsLeader);

    if(Rejoin !== undefined){
        RejoinPartyCandidate(TheParty, Rejoin, PlayerId);
        return true;
    }

    if(!IsLeader){
        if(Mode === "CITY" || Mode === "SHARED"){
            logger.info(`mm: ${PlayerId} is not the leader of P=${TheParty.PartyId}; goes to ${Hunt || Mode} alone`);
            return "solo";
        }

        logger.warn(`mm: refusing ${Mode} ${Hunt} for ${PlayerId}: only the leader of P=${TheParty.PartyId} (${TheParty.LeaderId}) starts the party's hunts`);
        return false;
    }

    let Members: string[];

    if(Mode === "ISLAND"){
        if(Hunt.trim().length === 0 || !HuntIdRequiresMatchmaking(Hunt)){
            return "solo";
        }

        Members = [...TheParty.Members];
    }
    else if(Mode === "CITY" || Mode === "SHARED"){
        const LeaderWas = LastSentMap.get(PlayerId);

        Members = TheParty.Members.filter((Member) => {
            const MemberWas = LastSentMap.get(Member);

            return Member === PlayerId || (LeaderWas !== undefined && MemberWas !== undefined && MemberWas.Host === LeaderWas.Host && MemberWas.Port === LeaderWas.Port);
        });

        if(Members.length < 2){
            logger.info(`mm: party leader ${PlayerId} goes to ${Hunt || Mode} alone: no member of P=${TheParty.PartyId} is on the leader's server`);
            return "solo";
        }
    }
    else{
        return "solo";
    }

    await StartPartyCandidate(TheParty, Mode, Hunt, Members, PlayerId);

    return true;
}

export async function HandlePlayerMatchmaking(GameMode: string, GameArgs: string, HuntId: string, PlayerId: string){
    const BadInput = CheckMatchmakingInput(GameMode, GameArgs, HuntId);

    if(BadInput != undefined){
        logger.warn(`Refusing matchmaking for ${PlayerId}: ${BadInput}`);

        return false;
    }

    if(MATCHMAKING_MODE === "DISABLED"){
        logger.warn("Matchmaking is disabled, refusing MM!");

        return false;
    }
    else if(MATCHMAKING_MODE === "DEPLOYSERVER"){
        const PartyDecision = await HandlePartyMatchmaking(GameMode, GameArgs, HuntId, PlayerId);

        if(PartyDecision !== "solo"){
            return PartyDecision;
        }

        ForgetPartyCandidateEntry(PlayerId);

        if(HuntId == undefined || HuntId.trim().length == 0 || !HuntIdRequiresMatchmaking(HuntId)){
            // Ramsgate, the Dojo or the tutorial instead of a hunt the player was still queued for
            LeaveWaitingQueues(PlayerId, "their new join replaces it");

            // CITY (Ramsgate) and SHARED (Training Dojo) may need time to boot.
            // Keep the client in MATCHING while the DeployServer starts the world
            // and waits for its UDP listener. Do not block the initial join request.
            if (GameMode === "CITY" || GameMode === "SHARED") {
                const Entry: MatchmakingResult = {
                    Ready: false,
                    CandidateId: crypto.randomUUID(),
                    HuntId: HuntId,
                    Host: "",
                    Port: 0
                };

                MatchmakingResultMap.set(PlayerId, Entry);

                const TryLaunch = async (): Promise<boolean> => {
                    if (MatchmakingResultMap.get(PlayerId) !== Entry) return true;

                    const result = await LaunchGameOnDeployserver(
                        GameMode, GameArgs, HuntId, undefined
                    );

                    if (result.capacity) return false;

                    if (MatchmakingResultMap.get(PlayerId) === Entry) {
                        Object.assign(Entry, {
                            Ready: result.succeeded,
                            Host: result.host,
                            Port: result.port,
                            Failed: !result.succeeded
                        });
                    }

                    return true;
                };

                void TryLaunch()
                    .then((done) => {
                        if (!done && !ParkCapacity(Entry.CandidateId, TryLaunch)) {
                            Entry.Failed = true;
                        }
                    })
                    .catch((error) => {
                        if (MatchmakingResultMap.get(PlayerId) === Entry) {
                            Entry.Failed = true;
                        }

                        logger.error(
                            `mm: ${GameMode} ${HuntId} launch for ${PlayerId} failed: ${(error as Error)?.message}`
                        );
                    });

                return true;
            }

            const GameOnDeployServer = await LaunchGameOnDeployserver(GameMode, GameArgs, HuntId, undefined);

            const Entry: MatchmakingResult = {
                Ready: GameOnDeployServer.succeeded,
                CandidateId: crypto.randomUUID(),
                HuntId: HuntId,
                Host: GameOnDeployServer.host,
                Port: GameOnDeployServer.port,
                Failed: GameOnDeployServer.succeeded || GameOnDeployServer.capacity ? undefined : true
            };
            MatchmakingResultMap.set(PlayerId, Entry);
            if (GameOnDeployServer.capacity) {
                const parked = ParkCapacity(Entry.CandidateId, async () => {
                    if (MatchmakingResultMap.get(PlayerId) !== Entry) return true;
                    const result = await LaunchGameOnDeployserver(GameMode, GameArgs, HuntId, undefined);
                    if (result.capacity) return false;
                    if (MatchmakingResultMap.get(PlayerId) === Entry) Object.assign(Entry, {Ready: result.succeeded, Host: result.host, Port: result.port, Failed: !result.succeeded});
                    return true;
                });
                if (!parked) Entry.Failed = true;
            }

            return true;
        }
        else{
            return await QueuePlayer(HuntId, PlayerId);
        }
    }
    else{
        logger.fatal("Unsupported MATCHMAKING_MODE!");

        return false;
    }
}

// Tests only
export function ResetMatchmakingForTests(){
    CapacityWaits.clear();
    MatchmakingQueueMap.clear();
    MatchmakingResultMap.clear();
    LastSentMap.clear();
}
