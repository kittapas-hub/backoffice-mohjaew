// Cleanup helpers for the disposable embedded-postgres test cluster,
// extracted from test-pg-embedded.ts so they're unit-testable without
// spawning a real Postgres process.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

export type StopResult =
  | { outcome: "graceful" }
  | { outcome: "timeout" }
  | { outcome: "error"; error: unknown };

export type ForceTerminateResult =
  | { attempted: false; pid: null; terminated: false }
  | { attempted: true; pid: number; terminated: boolean };

const MAX_OS_PID = 0x7fffffff;
const TERMINATION_TIMEOUT_MS = 5_000;
const TERMINATION_POLL_INTERVAL_MS = 100;
const STRICT_PID_RE = /^[1-9][0-9]*$/;
const DISPOSABLE_DIR_RE = /^mohjaew-pg-test-[A-Za-z0-9_-]+$/;

function parseStrictPid(raw: string): number | null {
  if (!STRICT_PID_RE.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid <= MAX_OS_PID ? pid : null;
}

export async function stopWithTimeout(
  stopFn: () => Promise<void>,
  timeoutMs: number,
): Promise<StopResult> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<StopResult>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "timeout" }), timeoutMs);
  });
  const attempt = (async (): Promise<StopResult> => {
    try {
      await stopFn();
      return { outcome: "graceful" };
    } catch (error) {
      return { outcome: "error", error };
    }
  })();
  const result = await Promise.race([attempt, timeout]);
  clearTimeout(timer);
  return result;
}

// ponytail: the only pid ever targeted is the one recorded in THIS
// disposable cluster's own data dir (postmaster.pid) — never a pid found by
// scanning the wider process list — so unrelated postgres processes can't
// be hit even if force-termination fires.
export function readClusterPid(
  dataDir: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): number | null {
  const pidFile = join(dataDir, "postmaster.pid");
  try {
    const first = readFile(pidFile).split("\n")[0];
    return parseStrictPid(first);
  } catch {
    return null;
  }
}

type ProcessRow = { pid: number; ppid: number };

function parseProcessId(raw: unknown, allowZero: boolean): number | null {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) return null;
  if (allowZero ? raw < 0 : raw <= 0) return null;
  return raw <= MAX_OS_PID ? raw : null;
}

function descendantsFromRows(rootPid: number, rows: ProcessRow[]): number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row.pid);
    children.set(row.ppid, siblings);
  }

  const seen = new Set<number>([rootPid]);
  const descendants: number[] = [];
  const visit = (parentPid: number): void => {
    for (const childPid of children.get(parentPid) ?? []) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      // Kill deepest descendants first so no child is left behind when its
      // parent is terminated.
      visit(childPid);
      descendants.push(childPid);
    }
  };
  visit(rootPid);
  return descendants;
}

function parsePosixProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*([0-9]+)\s+([0-9]+)\s*$/.exec(line);
    if (!match) throw new Error("unexpected ps process-table output");
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const parsedPid = parseProcessId(pid, false);
    const parsedPpid = parseProcessId(ppid, true);
    if (parsedPid === null || parsedPpid === null) {
      throw new Error("invalid ps process-table PID");
    }
    rows.push({ pid: parsedPid, ppid: parsedPpid });
  }
  return rows;
}

function listPosixDescendants(rootPid: number): number[] {
  const output = execFileSync("ps", ["-eo", "pid=,ppid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return descendantsFromRows(rootPid, parsePosixProcessTable(String(output)));
}

export interface KillDeps {
  killWindows: (pid: number) => void;
  killPosix: (pid: number) => void;
  isAlive: (pid: number) => boolean;
  listDescendants: (pid: number) => number[];
  sleep: (ms: number) => Promise<void>;
  terminationTimeoutMs: number;
  pollIntervalMs: number;
  platform: NodeJS.Platform;
}

const defaultKillDeps: KillDeps = {
  killWindows: (pid) => {
    let commandSucceeded = false;
    let firstError: unknown;
    try {
      // /T is the tree-scoped Windows equivalent of the verified POSIX
      // descendant list below.
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      commandSucceeded = true;
    } catch (error) {
      firstError = error;
    }

    // Some embedded-postgres Windows launches do not terminate promptly from
    // taskkill alone. This fallback still targets only the already validated
    // postmaster PID; the final liveness poll remains authoritative.
    try {
      execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "& { param($processId); Stop-Process -Id $processId -Force -ErrorAction Stop }",
          String(pid),
        ],
        { stdio: "ignore" },
      );
      commandSucceeded = true;
    } catch (error) {
      if (!firstError) firstError = error;
    }

    try {
      process.kill(pid, "SIGKILL");
      commandSucceeded = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && !firstError) firstError = error;
    }

    if (!commandSucceeded && firstError) {
      throw firstError;
    }
  },
  killPosix: (pid) => {
    process.kill(pid, "SIGKILL");
  },
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      throw error;
    }
  },
  listDescendants: (pid) =>
    process.platform === "win32" ? [] : listPosixDescendants(pid),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  terminationTimeoutMs: TERMINATION_TIMEOUT_MS,
  pollIntervalMs: TERMINATION_POLL_INTERVAL_MS,
  platform: process.platform,
};

function removeDir(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 });
  } catch (error) {
    if (process.platform !== "win32") throw error;
    execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& { param($path); Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop }",
        p,
      ],
      { stdio: "ignore" },
    );
  }
}

export function forceTerminateCluster(
  dataDir: string,
  deps: Partial<KillDeps> & { readFile?: (p: string) => string } = {},
): Promise<ForceTerminateResult> {
  const { readFile, ...killDepsPartial } = deps;
  const platform = killDepsPartial.platform ?? process.platform;
  const killDeps: KillDeps = {
    ...defaultKillDeps,
    ...killDepsPartial,
    platform,
    listDescendants:
      killDepsPartial.listDescendants ??
      (platform === "win32" ? (() => []) : listPosixDescendants),
  };
  const resolvedDataDir = resolve(dataDir);
  const tempRelative = relative(resolve(tmpdir()), resolvedDataDir);
  if (
    !DISPOSABLE_DIR_RE.test(basename(resolvedDataDir)) ||
    !tempRelative ||
    tempRelative === ".." ||
    tempRelative.split(/[\\/]/)[0] === ".." ||
    isAbsolute(tempRelative)
  ) {
    return Promise.resolve({ attempted: false, pid: null, terminated: false });
  }
  const pid = readClusterPid(dataDir, readFile);
  if (pid === null) return Promise.resolve({ attempted: false, pid: null, terminated: false });

  return terminateProcessTree(pid, killDeps);
}

async function terminateProcessTree(pid: number, killDeps: KillDeps): Promise<ForceTerminateResult> {
  let descendants: number[];
  try {
    descendants = killDeps.listDescendants(pid).filter((childPid) => childPid !== pid);
  } catch {
    return { attempted: true, pid, terminated: false };
  }

  const targets = [...new Set([...descendants, pid])];
  if (killDeps.platform === "win32") {
    try {
      killDeps.killWindows(pid);
    } catch {
      // The target may have exited between the timeout and taskkill. Final
      // liveness confirmation below distinguishes that race from failure.
    }
  } else {
    for (const target of targets) {
      try {
        killDeps.killPosix(target);
      } catch {
        // ESRCH is a normal race; any still-running target is rejected by the
        // positive liveness confirmation below.
      }
    }
  }

  return {
    attempted: true,
    pid,
    terminated: await waitForPidsAbsent(targets, killDeps),
  };
}

async function waitForPidsAbsent(pids: number[], deps: KillDeps): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, deps.terminationTimeoutMs);
  while (true) {
    try {
      if (pids.every((pid) => !deps.isAlive(pid))) return true;
    } catch {
      // An inability to check liveness is unknown, not proof of termination.
      return false;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    try {
      await deps.sleep(Math.min(Math.max(0, deps.pollIntervalMs), remainingMs));
    } catch {
      return false;
    }
  }
}

export async function removeDirWithRetry(
  dir: string,
  attempts = 60,
  delayMs = 500,
  rm: (p: string) => void = removeDir,
  exists: (p: string) => boolean = existsSync,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  onRemoveError: (error: unknown) => void = () => {},
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      rm(dir);
    } catch (error) {
      onRemoveError(error);
      // ignore; checked via exists() below, retried on next iteration
    }
    if (!exists(dir)) return true;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return !exists(dir);
}
