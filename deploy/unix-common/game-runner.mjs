import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function executable(file) {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(names, env = process.env) {
  for (const name of names) {
    if (name.includes("/")) {
      if (executable(name)) return path.resolve(name);
      continue;
    }
    for (const dir of (env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, name);
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

function directories(parent) {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parent, entry.name));
  } catch {
    return [];
  }
}

function protonCandidates(home) {
  const roots = [
    path.join(home, ".local", "share", "Steam"),
    path.join(home, ".steam", "root"),
    path.join(home, ".steam", "steam"),
  ];
  const out = [];
  for (const root of roots) {
    for (const dir of directories(path.join(root, "compatibilitytools.d"))) out.push(path.join(dir, "proton"));
    for (const dir of directories(path.join(root, "steamapps", "common"))) {
      if (/^(?:proton|ge-proton)/i.test(path.basename(dir))) out.push(path.join(dir, "proton"));
    }
  }
  return out.filter(executable).sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
}

function steamRootFor(proton) {
  let current = path.dirname(proton);
  for (let i = 0; i < 8; i++) {
    if (path.basename(current) === "compatibilitytools.d") return path.dirname(current);
    if (path.basename(current) === "common" && path.basename(path.dirname(current)) === "steamapps") return path.dirname(path.dirname(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function dllOverrides(existing) {
  const parts = (existing ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^dxgi=/i.test(part));
  parts.push("dxgi=n,b");
  return parts.join(";");
}

export function buildWineLaunch(args, env = process.env) {
  const gameExe = env.DR_GAME_EXE;
  if (!gameExe || !path.isAbsolute(gameExe) || !existsSync(gameExe)) {
    throw new Error("DR_GAME_EXE must be an existing absolute path to Dauntless-Win64-Shipping.exe");
  }
  const home = env.HOME ?? os.homedir();
  const explicitProton = env.DR_PROTON_BINARY ? findOnPath([env.DR_PROTON_BINARY], env) : null;
  const explicitWine = env.DR_WINE_BINARY ? findOnPath([env.DR_WINE_BINARY], env) : null;
  const proton = explicitProton ?? (explicitWine ? null : protonCandidates(home)[0] ?? null);
  const cwd = path.dirname(gameExe);
  let command;
  let gameArgs;
  let launchEnv;
  let runtime;
  if (proton) {
    const compatData = path.resolve(env.DR_INSTANCE_WINEPREFIX ?? env.DR_PROTON_COMPAT_DATA ?? path.join(home, ".local", "share", "dauntless-revived", "proton"));
    mkdirSync(compatData, { recursive: true });
    const steamRoot = steamRootFor(proton);
    command = proton;
    gameArgs = ["run", gameExe, ...args];
    launchEnv = {
      ...env,
      STEAM_COMPAT_DATA_PATH: compatData,
      ...(steamRoot ? { STEAM_COMPAT_CLIENT_INSTALL_PATH: steamRoot } : {}),
      STEAM_COMPAT_APP_ID: "0",
      PROTON_LOG: "0",
      WINEDLLOVERRIDES: dllOverrides(env.WINEDLLOVERRIDES),
    };
    runtime = "Proton (" + path.basename(path.dirname(proton)) + ")";
  } else {
    const wine = explicitWine ?? findOnPath(["wine64", "wine"], env);
    if (!wine) throw new Error("Proton or Wine was not found; set DR_PROTON_BINARY/DR_WINE_BINARY or install a runtime");
    const prefix = path.resolve(env.DR_INSTANCE_WINEPREFIX ?? env.DR_WINEPREFIX ?? path.join(home, ".local", "share", "dauntless-revived", "wineprefix"));
    mkdirSync(prefix, { recursive: true });
    command = wine;
    gameArgs = [gameExe, ...args];
    launchEnv = {
      ...env,
      WINEPREFIX: prefix,
      WINEDEBUG: env.WINEDEBUG ?? "-all",
      WINEDLLOVERRIDES: dllOverrides(env.WINEDLLOVERRIDES),
    };
    runtime = "Wine";
  }
  const noDisplay = !(launchEnv.DISPLAY ?? "").trim();
  const wantXvfb = env.DR_XVFB !== "0" && noDisplay;
  if (wantXvfb) {
    const xvfb = env.DR_XVFB_RUN ? findOnPath([env.DR_XVFB_RUN], env) : findOnPath(["xvfb-run"], env);
    if (!xvfb) throw new Error("no DISPLAY and xvfb-run was not found; install Xvfb/xvfb-run or set DR_XVFB=0");
    return {
      command: xvfb,
      args: ["-a", "-s", "-screen 0 1280x720x24", command, ...gameArgs],
      cwd,
      env: launchEnv,
      runtime: runtime + " via " + path.basename(xvfb),
    };
  }
  return { command, args: gameArgs, cwd, env: launchEnv, runtime };
}

function attachToGameCgroup(env) {
  const cgroup = env.DR_GAMESERVER_CGROUP_PATH;
  if (!cgroup) return;

  const procs = path.join(cgroup, "cgroup.procs");
  if (!existsSync(procs)) {
    throw new Error("game cgroup does not exist: " + cgroup);
  }

  // Join before spawning Wine/Proton: all descendants inherit this cgroup.
  writeFileSync(procs, String(process.pid));
}

export async function runWineGame(args, env = process.env) {
  attachToGameCgroup(env);
  const spec = buildWineLaunch(args, env);
  return await new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "inherit", windowsHide: false });
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      resolve(Number.isInteger(code) ? code : 1);
    };
    child.once("error", (error) => {
      process.stderr.write("dauntless game worker: " + error.message + "\n");
      finish(127);
    });
    child.once("exit", (code, signal) => {
      if (signal) process.stderr.write("dauntless game worker: runtime exited on " + signal + "\n");
      finish(code ?? 1);
    });
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      process.on(signal, () => {
        if (!child.killed) {
          try { child.kill(signal); } catch {}
        }
      });
    }
  });
}

export function decodeWorkerPayload(value) {
  if (typeof value !== "string" || value.length < 2 || value.length > 65536 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid worker payload");
  }
  const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!Array.isArray(decoded) || decoded.length < 8 || decoded.length > 64) throw new Error("invalid worker arguments");
  if (!decoded.every((v) => typeof v === "string" && v.length <= 4096 && !v.includes("\0"))) throw new Error("invalid worker arguments");
  return decoded;
}
