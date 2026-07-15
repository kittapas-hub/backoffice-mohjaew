import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  stopWithTimeout,
  readClusterPid,
  forceTerminateCluster,
  removeDirWithRetry,
} from "./pg-cleanup.ts";

test("stopWithTimeout: graceful stop resolves before the timeout", async () => {
  const result = await stopWithTimeout(async () => {}, 200);
  assert.deepEqual(result, { outcome: "graceful" });
});

test("stopWithTimeout: a hanging stop() times out instead of hanging the caller", async () => {
  const result = await stopWithTimeout(() => new Promise(() => {}), 50);
  assert.deepEqual(result, { outcome: "timeout" });
});

test("stopWithTimeout: a throwing stop() reports error, not graceful", async () => {
  const boom = new Error("stop exploded");
  const result = await stopWithTimeout(async () => {
    throw boom;
  }, 200);
  assert.equal(result.outcome, "error");
  assert.equal((result as { error: unknown }).error, boom);
});

test("readClusterPid: parses the pid from postmaster.pid's first line", () => {
  const pid = readClusterPid("/fake/data-dir", () => "12345\n/fake/data-dir\n1700000000\n55433\n");
  assert.equal(pid, 12345);
});

test("readClusterPid: returns null when the file is missing or malformed", () => {
  assert.equal(
    readClusterPid("/fake/data-dir", () => {
      throw new Error("ENOENT");
    }),
    null,
  );
  assert.equal(readClusterPid("/fake/data-dir", () => "not-a-pid\n"), null);
  for (const value of [
    " 123\n",
    "123 \n",
    "123\r\n",
    "+123\n",
    "-123\n",
    "1e3\n",
    "0x1234\n",
    "1.23\n",
    "0\n",
    "2147483648\n",
    "9007199254740992\n",
  ]) {
    assert.equal(readClusterPid("/fake/data-dir", () => value), null, `rejected ${JSON.stringify(value)}`);
  }
});

test("forceTerminateCluster: kills only the pid recorded in this cluster's own data dir", () => {
  const killed: number[] = [];
  const result = forceTerminateCluster(join(tmpdir(), "mohjaew-pg-test-abc"), {
    readFile: () => "999\n/fake/mohjaew-pg-test-abc\n",
    platform: "win32",
    killWindows: (pid) => killed.push(pid),
    killPosix: () => {
      throw new Error("should not be called on win32");
    },
    listDescendants: () => [],
    isAlive: () => false,
    terminationTimeoutMs: 0,
  });
  return result.then((actual) => {
    assert.deepEqual(actual, { attempted: true, pid: 999, terminated: true });
    assert.deepEqual(killed, [999]);
  });
});

test("forceTerminateCluster: never fabricates a pid for an unrelated/unreadable data dir", async () => {
  const killed: number[] = [];
  const result = forceTerminateCluster("/some/other/dir", {
    readFile: () => {
      throw new Error("ENOENT: no postmaster.pid here");
    },
    platform: "win32",
    killWindows: (pid) => killed.push(pid),
    killPosix: (pid) => killed.push(pid),
    listDescendants: () => [],
  });
  assert.deepEqual(await result, { attempted: false, pid: null, terminated: false });
  assert.deepEqual(killed, [], "no process of any kind should be targeted without a pid from this cluster's own dir");
});

test("forceTerminateCluster: a valid pid outside the disposable temp tree is never targeted", async () => {
  const killed: number[] = [];
  const result = await forceTerminateCluster("/some/other/mohjaew-pg-test-abc", {
    readFile: () => "999\n",
    platform: "linux",
    listDescendants: () => [],
    killPosix: (pid) => killed.push(pid),
    isAlive: () => false,
    killWindows: () => {},
  });
  assert.deepEqual(result, { attempted: false, pid: null, terminated: false });
  assert.deepEqual(killed, []);
});

test("forceTerminateCluster: a kill that throws after exit is reported as terminated", async () => {
  const result = await forceTerminateCluster(join(tmpdir(), "mohjaew-pg-test-abc"), {
    readFile: () => "999\n",
    platform: "linux",
    killPosix: () => {
      throw new Error("ESRCH: no such process");
    },
    isAlive: () => false,
    killWindows: () => {},
    listDescendants: () => [],
    terminationTimeoutMs: 0,
  });
  assert.deepEqual(result, { attempted: true, pid: 999, terminated: true });
});

test("forceTerminateCluster: a failed kill is reported when the target remains alive", async () => {
  const result = await forceTerminateCluster(join(tmpdir(), "mohjaew-pg-test-abc"), {
    readFile: () => "999\n",
    platform: "linux",
    killPosix: () => {
      throw new Error("EPERM: permission denied");
    },
    isAlive: () => true,
    killWindows: () => {},
    listDescendants: () => [],
    terminationTimeoutMs: 0,
  });
  assert.deepEqual(result, { attempted: true, pid: 999, terminated: false });
});

test("forceTerminateCluster: a successful but ineffective kill is reported when the target remains alive", async () => {
  const result = await forceTerminateCluster(join(tmpdir(), "mohjaew-pg-test-abc"), {
    readFile: () => "999\n",
    platform: "linux",
    killPosix: () => {},
    isAlive: () => true,
    killWindows: () => {},
    listDescendants: () => [],
    terminationTimeoutMs: 0,
  });
  assert.deepEqual(result, { attempted: true, pid: 999, terminated: false });
});

test("forceTerminateCluster: POSIX targets only verified descendants and the recorded postmaster", async () => {
  const killed: number[] = [];
  const result = await forceTerminateCluster(join(tmpdir(), "mohjaew-pg-test-abc"), {
    readFile: () => "999\n",
    platform: "linux",
    listDescendants: () => [1001, 1002],
    killPosix: (pid) => killed.push(pid),
    isAlive: () => false,
    killWindows: () => {},
    terminationTimeoutMs: 0,
  });
  assert.deepEqual(result, { attempted: true, pid: 999, terminated: true });
  assert.deepEqual(killed, [1001, 1002, 999]);
  assert.equal(killed.includes(1003), false, "unrelated PIDs must never be targeted");
});

test("forceTerminateCluster: liveness-check errors are cleanup failures", async () => {
  const result = await forceTerminateCluster(join(tmpdir(), "mohjaew-pg-test-abc"), {
    readFile: () => "999\n",
    platform: "linux",
    listDescendants: () => [],
    killPosix: () => {},
    isAlive: () => {
      throw new Error("tasklist/ps unavailable");
    },
    killWindows: () => {},
    terminationTimeoutMs: 0,
  });
  assert.deepEqual(result, { attempted: true, pid: 999, terminated: false });
});

test("removeDirWithRetry: succeeds immediately when rm works on the first try", async () => {
  let rmCalls = 0;
  const ok = await removeDirWithRetry(
    "/fake/dir",
    5,
    0,
    () => {
      rmCalls++;
    },
    () => false,
    async () => {},
  );
  assert.equal(ok, true);
  assert.equal(rmCalls, 1);
});

test("removeDirWithRetry: retries past a Windows file-lock (EBUSY) until the dir is gone", async () => {
  let existsCallCount = 0;
  const sleeps: number[] = [];
  const ok = await removeDirWithRetry(
    "/fake/dir",
    5,
    10,
    () => {
      // rm is a no-op stand-in for a locked-file failure; the dir "exists"
      // check below is what actually simulates the lock releasing.
    },
    () => {
      existsCallCount++;
      return existsCallCount < 3; // "still there" for the first 2 checks
    },
    async (ms) => {
      sleeps.push(ms);
    },
  );
  assert.equal(ok, true);
  assert.equal(existsCallCount, 3);
  assert.deepEqual(sleeps, [10, 10]);
});

test("removeDirWithRetry: gives up and reports failure after exhausting attempts", async () => {
  const ok = await removeDirWithRetry(
    "/fake/dir",
    3,
    0,
    () => {},
    () => true, // never goes away
    async () => {},
  );
  assert.equal(ok, false);
});
