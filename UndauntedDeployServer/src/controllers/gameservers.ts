import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { setTimeout } from "node:timers/promises";

import crypto from "node:crypto";

import PlayerHuntTable from "../vendor/player_hunts_table.json";
import MatchmakerHuntTable from "../vendor/matchmaker_hunts_table.json";
import TrialsHardHuntTable from "../vendor/trials_hard_table.json";
import TrialsEliteHuntTable from "../vendor/trials_elite_table.json";
import { kill } from "node:process";
import { logger } from "../logger";
import { CapacityUnavailable, memoryAdmission } from './capacity';

const RAMSGATE_MAP_PATH = "/Game/Maps/ramsgate/ramsgate_01_persistent";
const TRAINING_DOJO_MAP_PATH = "/Game/Maps/islands/dojo/training_dojo_persistent";
const TRIALS_MAP_PATH = "/Game/Maps/islands/arenas/arena_ramsgate_00";

export type Gameserver = {
    id: string,
    port: number,
    map: string,
    behemoth: string | undefined,
    matchmakerHuntId: string | undefined,
    expectedPlayers: ExpectedPlayer[] | undefined,
    isRamsgate: boolean,
    isTrainingDojo: boolean,
    processId: number,
    startTime: Date
};

type ExpectedPlayer = {
    playerUid: string,
    playerHuntId: string
};

export let Gameservers: Gameserver[] = [];
let FreePorts: number[] = [];

let RamsgateServer : Gameserver | undefined;
let TrainingDojoServer : Gameserver | undefined;

// How game processes are started and checked. Tests swap in stand-ins (UseProcessFunctionsForTests);
// nothing else changes them.
type SpawnFunction = (Command: string, Args: string[], Options: SpawnOptions) => ChildProcess;
let SpawnProcess: SpawnFunction = spawn;
let ProcessIsAlive: (ProcessId: number) => boolean = (ProcessId) => IsProcessAlive(ProcessId);

const PORT_RANGE_BEGIN = Number(process.env.PORT_RANGE_BEGIN!);
const PORT_RANGE_END = Number(process.env.PORT_RANGE_END!);
const RAMSGATE_PORT = PORT_RANGE_END;
const TRAINING_DOJO_PORT = PORT_RANGE_END - 1;
const GAMESERVER_BINARY_PATH = process.env.GAMESERVER_BINARY_PATH!;
const STANDARD_GAMESERVER_ARGS = ["-EpicPortal", "-server", "-nullrhi"];
const METAGAME_API_KEY = process.env.METAGAME_API_KEY!;
const MY_IP = process.env.MY_IP!;
const SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP = Number(process.env.SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP!);

function GameserverStartupGraceMs(){
    const Raw = process.env.GAMESERVER_STARTUP_GRACE_MS;
    if(Raw === undefined){
        return 5000;
    }

    const Value = Number(Raw);

    if(!/^\d+$/.test(Raw) || !Number.isSafeInteger(Value) || Value < 0 || Value > 60000){
        throw new Error("Invalid GAMESERVER_STARTUP_GRACE_MS");
    }

    return Value;
}

function TrainingDojoStartupGraceMs(){
    const Raw = process.env.TRAINING_DOJO_STARTUP_GRACE_MS;
    if(Raw === undefined){
        return 30000;
    }

    const Value = Number(Raw);

    if(!/^\d+$/.test(Raw) || !Number.isSafeInteger(Value) || Value < 0 || Value > 120000){
        throw new Error("Invalid TRAINING_DOJO_STARTUP_GRACE_MS");
    }

    return Value;
}

async function WaitForServerStartup(Child: ChildProcess, Port: number, IsHunt: boolean, IsTrainingDojo: boolean){
    if(!IsHunt && !IsTrainingDojo){
        return;
    }

    const GraceMs = IsTrainingDojo
        ? TrainingDojoStartupGraceMs()
        : GameserverStartupGraceMs();

    if(GraceMs === 0){
        return;
    }

    let OnExit!: (Code: number | null, Signal: NodeJS.Signals | null) => void;
    let OnError!: (error: Error) => void;
    const Failed = new Promise<never>((_Resolve, Reject) => {
        OnExit = (Code, Signal) => Reject(new Error(`Game server on port ${Port} exited during startup (${Signal ?? Code ?? "unknown"})`));
        OnError = (error) => Reject(new Error(`Game server on port ${Port} failed during startup: ${error.message}`));
        Child.once("exit", OnExit);
        Child.once("error", OnError);
    });

    try{
        await Promise.race([setTimeout(GraceMs), Failed]);
    }
    finally{
        Child.off("exit", OnExit);
        Child.off("error", OnError);
    }

    if(Child.pid === undefined || !ProcessIsAlive(Child.pid)){
        throw new Error(`Game server on port ${Port} did not survive startup`);
    }
}

function TransformExpectedPlayerArgs(ExpectedPlayers: ExpectedPlayer[]){
    let ToReturn = "";

    for(const Player of ExpectedPlayers){
        ToReturn = ToReturn + Player.playerUid + ":" + Player.playerHuntId + ",";
    }

    if(ToReturn.length > 0){
        ToReturn = ToReturn.slice(0, -1); // Remove trailing ','
    }

    return ToReturn;
}

// Called by the watchdog for a server whose process has exited. Ramsgate and the Dojo are started
// again (through the same shared launch as a player's request, so the two never start two processes
// on one port); a hunt's port goes back to the pool.
export async function CleanupServer(ServerToShutdown: Gameserver){
    if (!Gameservers.includes(ServerToShutdown)) return; // exit event and watchdog may race
    Gameservers = Gameservers.filter(Server => Server !== ServerToShutdown);

    if(ServerToShutdown.isRamsgate){
        await EnsurePersistentWorld("ramsgate", "RAMSGATE HAS FALLEN! Restarting!");
    }
    else if(ServerToShutdown.isTrainingDojo){
        await EnsurePersistentWorld("dojo", "Training Dojo Crashed! Restarting!");
    }
    else{
        FreePorts.push(ServerToShutdown.port);
    }
}

// Ramsgate and the Training Dojo: one process each, on a fixed port
type PersistentWorld = "ramsgate" | "dojo";

// The launch of a persistent world that is under way. The watchdog, CITY and SHARED requests and the
// Dojo's first start all wait for this one launch instead of starting their own.
const PersistentWorldLaunches = new Map<PersistentWorld, Promise<Gameserver>>();

function CurrentPersistentWorld(World: PersistentWorld){
    return World === "ramsgate" ? RamsgateServer : TrainingDojoServer;
}

// The record of a restarted world is stored here, so the next check looks at the new process.
// (Upstream's watchdog restart kept the old record, whose process had exited.)
function EnsurePersistentWorld(World: PersistentWorld, Why?: string, Level: "info" | "warn" = "warn"): Promise<Gameserver> {
    const Launching = PersistentWorldLaunches.get(World);

    if(Launching !== undefined){
        return Launching;
    }

    const Current = CurrentPersistentWorld(World);

    if(Current !== undefined && ProcessIsAlive(Current.processId)){
        return Promise.resolve(Current);
    }

    if(Current !== undefined){
        Gameservers = Gameservers.filter(Server => Server !== Current);
    }

    if(Why !== undefined){
        logger[Level](Why);
    }

    const IsRamsgate = World === "ramsgate";
    const DojoHuntId = IsRamsgate ? undefined : TRAINING_DOJO_MATCHMAKER_HUNT_ID;
    const WorldMap = IsRamsgate ? RAMSGATE_MAP_PATH
        : `${TRAINING_DOJO_MAP_PATH}?game=${GetGameModeOverrideFromMatchmakerHuntId(DojoHuntId!)}?MaxPlayers=${MaxPlayersFromTables(DojoHuntId!)}`;
    // Shared worlds have no fixed roster, but Training Grounds still needs its hunt rules and mode.
    const Launch = StartServer(WorldMap, undefined, DojoHuntId, undefined, IsRamsgate, !IsRamsgate)
        .then((Started) => {
            if(IsRamsgate){
                RamsgateServer = Started;
            }
            else{
                TrainingDojoServer = Started;
            }

            return Started;
        })
        .finally(() => { PersistentWorldLaunches.delete(World); });

    PersistentWorldLaunches.set(World, Launch);

    return Launch;
}

// The liveness check, the stored record of a restarted world and the error and exit listeners below
// follow Harmonic's fork (github.com/Harmonicrain/Undaunted 895f7c7), rebuilt around one shared launch.
//
// On (the default) unless PERSISTENT_WORLD_LIVENESS=0: before Ramsgate or the Dojo is handed to a
// player, its process must still be running, or it is started again first. Without the check a dead
// Ramsgate went unnoticed until the watchdog's next round (up to 60 s), and every player sent there in
// the meantime travelled to a port nothing listened on. 0 leaves restarts to the watchdog, as before.
export function IsPersistentWorldLivenessOn(){
    return process.env.PERSISTENT_WORLD_LIVENESS !== "0";
}

let ServerLaunchQueue: Promise<unknown> = Promise.resolve();
let NextServerLaunchAt = 0;

function StartServer(Map: string, Behemoth: string | undefined, MatchmakerHuntId: string | undefined, ExpectedPlayers: ExpectedPlayer[] | undefined, IsRamsgate: boolean, IsTrainingDojo: boolean){
    const Launch = ServerLaunchQueue.catch(() => {}).then(async () => {
        if (!IsRamsgate && !IsTrainingDojo && FreePorts.length === 0) throw new CapacityUnavailable('ports');
        const Wait = NextServerLaunchAt - Date.now();
        if (Wait > 0) await setTimeout(Wait);
        const Server = await StartServerNow(Map, Behemoth, MatchmakerHuntId, ExpectedPlayers, IsRamsgate, IsTrainingDojo);
        // Failed attempts must not add another cooldown to the queue.
        NextServerLaunchAt = Date.now() + SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP * 1000;
        return Server;
    });
    ServerLaunchQueue = Launch;
    return Launch;
}

async function StartServerNow(Map: string, Behemoth: string | undefined, MatchmakerHuntId: string | undefined, ExpectedPlayers: ExpectedPlayer[] | undefined, IsRamsgate: boolean, IsTrainingDojo: boolean){

    if (!IsRamsgate && !IsTrainingDojo && FreePorts.length === 0) throw new CapacityUnavailable('ports');
    const ReleaseReservation = memoryAdmission.reserve(!IsRamsgate && !IsTrainingDojo);
    
    let Port;

    if(IsRamsgate){
        Port = RAMSGATE_PORT;
    }
    else if(IsTrainingDojo){
        Port = TRAINING_DOJO_PORT;
    }
    else{
        Port = FreePorts.pop();
    }

    const Id = crypto.randomUUID();

    if(Port == undefined){
        ReleaseReservation();
        throw new CapacityUnavailable('ports');
    }

    const IsHunt = !IsRamsgate && !IsTrainingDojo;
    let Child: ChildProcess;

    try{
        Child = SpawnProcess(GAMESERVER_BINARY_PATH, [
            METAGAME_API_KEY,
            Port.toString(),
            Map,
            Behemoth != undefined ? Behemoth : "NO_BEHEMOTH",
            MatchmakerHuntId != undefined ? MatchmakerHuntId : "NO_MM_HUNTID",
            ExpectedPlayers != undefined ? TransformExpectedPlayerArgs(ExpectedPlayers) : "NO_EXPECTED_PLAYERS",
            MY_IP + ":" + Port.toString(),
            ...STANDARD_GAMESERVER_ARGS
        ], {
            // Keep the long-running Ramsgate and Dojo diagnostic windows visible,
            // but do not flash a new command window for every temporary hunt.
            windowsHide: IsHunt,
            stdio: "inherit"
        });
    }
    catch(error){
        ReleaseReservation();
        if(IsHunt){
            FreePorts.push(Port);
        }

        logger.error(`Could not start a game server on port ${Port}: ${(error as Error)?.message}`);
        throw new Error(`Could not start a game server on port ${Port}`);
    }

    // A process that cannot be started (a wrong GAMESERVER_BINARY_PATH, a missing file) reports it
    // as an "error" event. Without a listener that event took the whole deploy server down.
    Child.on("error", (error) => { ReleaseReservation(); logger.error(`Game server on port ${Port} failed: ${error.message} (GAMESERVER_BINARY_PATH is ${GAMESERVER_BINARY_PATH})`); });
    Child.on("exit", (Code, Signal) => {
        ReleaseReservation();
        // Release hunt ports immediately instead of waiting up to 60s for the watchdog.
        if (IsHunt) {
            const Finished = Gameservers.find(Server => Server.id === Id);
            if (Finished) void CleanupServer(Finished);
        }
        const Line = `Game server on port ${Port} (pid ${Child.pid}) exited ${Signal != null ? `on ${Signal}` : `with code ${Code}`}`;

        if(Code === 0){
            logger.info(Line);
        }
        else{
            logger.warn(Line);
        }
    });

    Child.unref();

    // No process id: the start failed and the "error" event follows. Nothing runs on the port, so a
    // hunt's port goes back to the pool and the caller (the matchmaking call) gets an error, which the
    // metagame reports to the player as FAILED instead of an address nothing listens on.
    if(Child.pid === undefined){
        ReleaseReservation();
        if(IsHunt){
            FreePorts.push(Port);
        }

        throw new Error(`Could not start a game server on port ${Port}`);
    }

    try{
        await WaitForServerStartup(Child, Port, IsHunt, IsTrainingDojo);
    }
    catch(error){
        if(IsHunt && !FreePorts.includes(Port)){
            FreePorts.push(Port);
        }

        throw error;
    }

    const NewGameserver: Gameserver = {
        id: Id,
        port: Port,
        map: Map,
        behemoth: Behemoth,
        matchmakerHuntId: MatchmakerHuntId,
        expectedPlayers: ExpectedPlayers,
        isRamsgate: IsRamsgate,
        isTrainingDojo: IsTrainingDojo,
        processId: Child.pid,
        startTime: new Date()
    };

    Gameservers.push(NewGameserver);

    return NewGameserver;
}

export async function GetRamsgateConnectionDetails(){
    let Server = RamsgateServer;

    if(Server === undefined || IsPersistentWorldLivenessOn()){
        Server = await EnsurePersistentWorld("ramsgate", Server === undefined ? "Ramsgate is not running: starting it" : "Ramsgate is not running any more: starting it again before sending anyone there");
    }

    return {
        host: MY_IP,
        port: Server.port
    };
}

// The Dojo is started on demand the first time someone is matchmade into it,
// rather than at boot. It is a full game process that most sessions never
// visit, and on a single home PC that memory matters. Concurrent first
// requests share one launch instead of racing to start two.
export async function GetTrainingDojoConnectionDetails(){
    let Server = TrainingDojoServer;

    if(Server === undefined){
        Server = await EnsurePersistentWorld("dojo", "Starting the Training Dojo on demand", "info");
    }
    else if(IsPersistentWorldLivenessOn()){
        Server = await EnsurePersistentWorld("dojo", "The Training Dojo is not running any more: starting it again before sending anyone there");
    }

    return {
        host: MY_IP,
        port: Server.port
    };
}

export async function StartupGameserverWithArgs(GameArgs: string){
    const Map = GameArgs.split("?")[0];
    const Behemoth = GameArgs.split("?")[2].split("=")[1];

    const GameServerToReturn = await StartServer(Map, Behemoth, undefined, undefined, false, false);

    return {
        host: MY_IP,
        port: GameServerToReturn.port
    };
}

function GetMatchmakerHuntIdFromPlayerHuntId(PlayerHuntId: string){
    const MatchmakerHuntIDs = (PlayerHuntTable[0].Rows as any)[PlayerHuntId].MatchmakerHuntIDs;

    let MatchmakerHuntObject;

    if(MatchmakerHuntIDs.length !== 0){
        MatchmakerHuntObject = MatchmakerHuntIDs[crypto.randomInt(0, MatchmakerHuntIDs.length)];
    }

    return MatchmakerHuntObject?.RowName;
}

function GetBehemothPathFromMatchmakerHuntId(MatchmakerHuntId: string): string{
    const MatchmakerHuntObject = (MatchmakerHuntTable[0].Rows as any)[MatchmakerHuntId];

    return MatchmakerHuntObject.SpecificBehemoth.BehemothAsset.AssetPathName;
}

function GetMapPathFromMatchmakerHuntId(MatchmakerHuntId: string): string{
    const MatchmakerHuntObject = (MatchmakerHuntTable[0].Rows as any)[MatchmakerHuntId];

    const MapList = MatchmakerHuntObject.MapList;

    return MapList[crypto.randomInt(0, MapList.length)].MapAssetName.split(".")[0];
}

function GetGameModeOverrideFromMatchmakerHuntId(MatchmakerHuntId: string): string{
    const MatchmakerHuntObject = (MatchmakerHuntTable[0].Rows as any)[MatchmakerHuntId];

    return MatchmakerHuntObject.GameModeOverride.replaceAll("Archon/Content", "/Game");
}

type TrialsData = {
    Behemoth: string;
    TrialsHuntId: string;
}

function RandomlyGenTrialsData(IsElite: boolean): TrialsData{
    const RandomTrialNum = String(crypto.randomInt(1, 89)).padStart(3, "0");

    const Difficulty = IsElite ? "Elite" : "Hard";

    const TrialsHuntId = `Arena_MatchmakerHunt_${Difficulty}_${RandomTrialNum}`;

    const Row = IsElite ? (TrialsEliteHuntTable[0].Rows as any)[TrialsHuntId] : (TrialsHardHuntTable[0].Rows as any)[TrialsHuntId];

    const Behemoth = Row.SpecificBehemoth.BehemothAsset.AssetPathName;

    return {
        Behemoth: Behemoth,
        TrialsHuntId: TrialsHuntId
    };
}

export async function StartupGameserverWithHuntIdAndPlayers(HuntId: string, ExpectedPlayers: string[]){
    const TrialsData = HuntId.includes("Arena") ? RandomlyGenTrialsData(HuntId.includes("Elite")) : undefined;
    const MatchmakerHuntId = TrialsData == undefined ? GetMatchmakerHuntIdFromPlayerHuntId(HuntId) : TrialsData.TrialsHuntId;
    let BehemothPath = TrialsData == undefined ? GetBehemothPathFromMatchmakerHuntId(MatchmakerHuntId!) : TrialsData.Behemoth;
    let MapPath = TrialsData == undefined ? GetMapPathFromMatchmakerHuntId(MatchmakerHuntId!) : TRIALS_MAP_PATH;

    if(MatchmakerHuntId != undefined && !MatchmakerHuntId.includes("Arena")){
        const OverrideGameMode = GetGameModeOverrideFromMatchmakerHuntId(MatchmakerHuntId);

        if(OverrideGameMode != undefined && OverrideGameMode.includes("_C")){
            logger.info(`Overriding gamemode to ${OverrideGameMode}`);
            MapPath = `${MapPath}?game=${OverrideGameMode}`;
        }
    }

    const GameServerToReturn = await StartServer(MapPath, BehemothPath, MatchmakerHuntId, ExpectedPlayers.map((PlayerId) => {
        return {
            playerUid: PlayerId,
            playerHuntId: HuntId
        };
    }), false, false);

    return {
        host: MY_IP,
        port: GameServerToReturn.port
    }
}

// ---- GET /gameservers: what runs now, for the metagame's /undaunted/api/ServerStatus ----

export type GameserverKind = "city" | "hunt" | "dojo" | "tutorial";

// The tutorial is started from the client's own game args: the tutorial Gnasher on
// dia_moss_triforce (regular hunts use dia_moss_triforce_2, hence the exact match)
const TUTORIAL_MAP = /\/dia_moss_triforce(?:$|[.?])/i;
const TRAINING_DOJO_MATCHMAKER_HUNT_ID = "CR19_MatchmakerHunt_ShatteredIsles_TrainingDojo";

export function KindOfGameserver(Server: Gameserver): GameserverKind {
    if(Server.isRamsgate){
        return "city";
    }

    if(Server.isTrainingDojo){
        return "dojo";
    }

    if(/_tutorial_bp/i.test(Server.behemoth ?? "") || TUTORIAL_MAP.test(Server.map)){
        return "tutorial";
    }

    return "hunt";
}

function MaxPlayersFromTables(MatchmakerHuntId: string){
    const Row = (MatchmakerHuntTable[0].Rows as any)[MatchmakerHuntId]
        ?? (TrialsHardHuntTable[0].Rows as any)[MatchmakerHuntId]
        ?? (TrialsEliteHuntTable[0].Rows as any)[MatchmakerHuntId];

    return Number.isInteger(Row?.MaxPlayers) ? Row.MaxPlayers as number : null;
}

// null where the tables don't say (Ramsgate): the metagame fills in its default
function MaxPlayersOf(Server: Gameserver, Kind: GameserverKind): number | null {
    switch(Kind){
        case "tutorial":
            return 1;
        case "dojo":
            return MaxPlayersFromTables(TRAINING_DOJO_MATCHMAKER_HUNT_ID);
        case "hunt":
            return Server.matchmakerHuntId != undefined ? MaxPlayersFromTables(Server.matchmakerHuntId) : null;
        default:
            return null;
    }
}

export function IsProcessAlive(ProcessId: number){
    try{
        kill(ProcessId, 0);

        return true;
    } catch {
        return false;
    }
}

// Servers whose process has exited are left out at once (the watchdog frees them within a minute)
export function DescribeGameservers(Servers: Gameserver[] = Gameservers, IsAlive: (ProcessId: number) => boolean = IsProcessAlive){
    return Servers.filter((Server) => IsAlive(Server.processId)).map((Server) => {
        const Kind = KindOfGameserver(Server);
        const [MapPath, ...Options] = Server.map.split("?");
        const GameMode = Options.find((Option) => Option.startsWith("game="))?.slice("game=".length);

        return {
            id: Server.id,
            port: Server.port,
            kind: Kind,
            map: MapPath,
            gameMode: GameMode != undefined && GameMode.length > 0 ? GameMode : null,
            behemoth: Server.behemoth != undefined && Server.behemoth.length > 0 && Server.behemoth !== "NO_BEHEMOTH" ? Server.behemoth : null,
            huntId: Server.expectedPlayers?.[0]?.playerHuntId ?? null,
            matchmakerHuntId: Server.matchmakerHuntId ?? null,
            expectedPlayers: (Server.expectedPlayers ?? []).map((Player) => Player.playerUid),
            maxPlayers: MaxPlayersOf(Server, Kind),
            startedAt: Server.startTime.toISOString()
        };
    });
}

// Both persistent worlds start through the shared launch, so a player's request that arrives while
// they are still starting waits for them instead of starting a second process
export async function Startup(){
    for(let i = PORT_RANGE_BEGIN; i <= PORT_RANGE_END - 2; i++){
        FreePorts.push(i);
    }

    if (process.env.HUNT_WORKER === '1') return;

    await EnsurePersistentWorld("ramsgate");

    // Upstream always started the Dojo here. Opt back in with ENABLE_DOJO=1 on
    // a machine with RAM to spare; otherwise it starts on first use.
    if (process.env.ENABLE_DOJO === "1") {
        await EnsurePersistentWorld("dojo");
    }
}

// For server.ts. A failed start (a wrong GAMESERVER_BINARY_PATH, say) is one fatal line and a
// non-zero exit code for when the process ends, instead of an unhandled rejection (the catch comes from
// github.com/Harmonicrain/Undaunted 895f7c7). The deploy server
// keeps answering: the next trip to Ramsgate tries to start it again.
export function StartupAndReportFailure(){
    return Startup().catch((error) => {
        logger.fatal(`Starting the game servers failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}

// The watchdog's check, with the same stand-in as everything else here in tests
export function IsGameserverAlive(Server: Gameserver){
    return ProcessIsAlive(Server.processId);
}

// ---- Tests only ----

export function UseProcessFunctionsForTests(Functions: { Spawn?: SpawnFunction, IsAlive?: (ProcessId: number) => boolean }){
    SpawnProcess = Functions.Spawn ?? spawn;
    ProcessIsAlive = Functions.IsAlive ?? ((ProcessId) => IsProcessAlive(ProcessId));
}

export function ResetGameserversForTests(){
    ServerLaunchQueue = Promise.resolve();
    NextServerLaunchAt = 0;
    Gameservers = [];
    FreePorts = [];
    RamsgateServer = undefined;
    TrainingDojoServer = undefined;
    PersistentWorldLaunches.clear();
}

export function GameserverStateForTests(){
    return { FreePorts: [...FreePorts], Ramsgate: RamsgateServer, Dojo: TrainingDojoServer };
}
