// Codex CLI auto-update S1 — G4 harness. REAL PROCESSES, no fakes.
//
// The whole design rests on one platform claim and one recovery claim, and
// neither is provable by reasoning about Node's docs:
//
//   (a) A child spawned with the executor's options KEEPS RUNNING after its
//       parent dies. `codex update` shells out to npm / `brew upgrade --cask` /
//       an installer, and killing a package manager mid-write can leave a
//       corrupt global install — so quitting Sonata must not kill the update.
//   (b) The next launch RECOVERS: the persisted attempt record, plus a live pid
//       probe, re-derives "an update is still running" across a restart — and
//       releases the moment that pid stops answering.
//
// If (a) were false the design would be unsafe and would need rethinking, not
// patching. Sonata is macOS-first and the claim is a macOS/launchd one, so this
// harness SKIPs elsewhere rather than asserting a platform it does not target.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

if (process.platform !== "darwin") {
  console.log(`SKIP: detached-spawn survival is a macOS claim (platform=${process.platform})`);
  process.exit(77);
}

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const { executeUpdate, detachedSpawnOptions } = require(
  path.join(distRoot, "main/cli-updater/executor"),
);
const { CliUpdater } = require(path.join(distRoot, "main/cli-updater/cli-updater"));
const { CliUpdaterStateStore } = require(path.join(distRoot, "main/cli-updater/state"));

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cli-updater-g4-"));
const results = {};
const strays = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function killQuietly(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function waitFor(predicate, { timeoutMs = 5_000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(stepMs);
  }
  return false;
}

// A stand-in for `codex update`: appends a timestamp to a beacon file every 40ms
// and echoes to stdout (so the inherited log fd is exercised too), with a hard
// self-terminate so a failed run can never leave a process behind.
const STAND_IN_SRC = `
const fs = require("node:fs");
const beacon = process.argv[1];
setInterval(() => {
  fs.appendFileSync(beacon, Date.now() + "\\n");
  process.stdout.write("tick\\n");
}, 40);
setTimeout(() => process.exit(0), 20000);
`;

// The parent: spawns the stand-in with THE EXECUTOR'S OWN options, reports the
// pid, then sits still waiting to be killed.
const PARENT_SRC = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { detachedSpawnOptions } = require(${JSON.stringify(path.join(distRoot, "main/cli-updater/executor"))});
const [beacon, logFile, childSrc] = process.argv.slice(2);
const fd = fs.openSync(logFile, "a");
const child = spawn(process.execPath, ["-e", childSrc, beacon], detachedSpawnOptions(fd));
child.unref();
fs.closeSync(fd);
process.stdout.write(JSON.stringify({ childPid: child.pid }) + "\\n");
setInterval(() => {}, 1000);
`;

// ── (a) Does a detached child outlive its parent on this macOS? ─────────────
{
  const beacon = path.join(workspace, "beacon.txt");
  const logFile = path.join(workspace, "child-stdio.log");
  fs.writeFileSync(beacon, "", "utf8");
  const parentScript = path.join(workspace, "parent.cjs");
  fs.writeFileSync(parentScript, PARENT_SRC, "utf8");

  const parent = spawn(process.execPath, [parentScript, beacon, logFile, STAND_IN_SRC], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  strays.add(parent.pid);

  let stdout = "";
  parent.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const announced = await waitFor(() => stdout.includes("\n"));
  assert.ok(announced, "the parent announced its child");
  const { childPid } = JSON.parse(stdout.trim());
  strays.add(childPid);
  assert.ok(Number.isInteger(childPid) && childPid > 0, `child pid is real (${childPid})`);

  const lines = () => fs.readFileSync(beacon, "utf8").split("\n").filter(Boolean).length;
  assert.ok(await waitFor(() => lines() >= 3), "the child is running and writing");

  let parentExited = false;
  parent.on("exit", () => {
    parentExited = true;
  });
  process.kill(parent.pid, "SIGKILL");
  assert.ok(await waitFor(() => parentExited), "the parent was killed");
  assert.equal(isAlive(parent.pid), false, "the parent is really gone");

  const atDeath = lines();
  await sleep(400);
  const afterDeath = lines();

  // THE G4 ASSERTION.
  assert.ok(
    afterDeath > atDeath,
    `the child kept writing after its parent died (${atDeath} → ${afterDeath} lines)`,
  );
  assert.equal(isAlive(childPid), true, "and the child process is still alive");
  assert.match(
    fs.readFileSync(logFile, "utf8"),
    /tick/,
    "the inherited log fd outlived the parent too",
  );

  killQuietly(childPid);
  assert.ok(await waitFor(() => !isAlive(childPid)), "the orphan can still be killed");

  results.survivesParentDeath = {
    childPid,
    linesAtParentDeath: atDeath,
    linesAfter400ms: afterDeath,
    grewBy: afterDeath - atDeath,
  };
}

// ── (b) Orphan adoption across a restart, end to end ───────────────────────
{
  const statePath = path.join(workspace, "cli-updater-state.json");
  const store = new CliUpdaterStateStore(statePath);
  const beacon = path.join(workspace, "adopt-beacon.txt");
  fs.writeFileSync(beacon, "", "utf8");

  // The REAL executor, writing the REAL facts file, over a real detached child
  // spawned with the real options — only the command is a stand-in.
  let spawned;
  const attempt = executeUpdate({
    store,
    forVersion: "0.147.0",
    logsDir: path.join(workspace, "logs"),
    spawnUpdate: ({ logFd }) => {
      const child = spawn(process.execPath, ["-e", STAND_IN_SRC, beacon], {
        ...detachedSpawnOptions(logFd),
      });
      spawned = child;
      return {
        pid: child.pid,
        onExit: (listener) => child.once("exit", (code) => listener(code)),
        onError: (listener) => child.once("error", listener),
        unref: () => child.unref(),
      };
    },
  });
  assert.ok(attempt, "an attempt was recorded");
  strays.add(attempt.pid);

  // The record on disk is the lock — it names a real, live pid.
  const onDisk = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(onDisk.lastAttempt.pid, attempt.pid, "the facts file names the real child");
  assert.equal(onDisk.lastAttempt.exitCode, null, "unreaped");
  assert.equal(isAlive(attempt.pid), true, "and that pid is genuinely alive");

  // Simulate the restart: a brand-new controller over the same file, with the
  // REAL kill(pid, 0) probe. Nothing was handed to it but the path.
  const restarted = new CliUpdater({
    livePtyCount: () => 0,
    isEnabled: () => true,
    store: new CliUpdaterStateStore(statePath),
    check: async () => ({ at: new Date().toISOString(), ok: false, installed: null, latest: null }),
    execute: () => null,
    pollIntervalMs: 25,
    log: () => {},
  });
  assert.equal(restarted.reconcile(), "running", "the orphan is adopted as RUNNING");
  assert.equal(await restarted.whenIdle(50), "timeout", "and it holds the spawn mutex");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(statePath, "utf8")),
    onDisk,
    "adoption wrote nothing — it is derived, not recorded",
  );

  // The orphan finishes. No transition fires; the same read simply classifies
  // differently, and the mutex releases.
  killQuietly(attempt.pid);
  assert.ok(await waitFor(() => !isAlive(attempt.pid)), "the orphan exited");
  assert.equal(restarted.attemptState(), "unknown", "RUNNING → UNKNOWN, with no code running");
  assert.equal(await restarted.whenIdle(2_000), "idle", "the mutex released");

  // UNKNOWN is not a failure: a died-mid-update app tells us nothing about
  // whether codex can be updated, so Sonata keeps the prompt.
  assert.equal(
    restarted.spawnDecision().suppressNativePrompt,
    true,
    "an unknown outcome never hands the prompt back",
  );

  // A record naming a pid that is already dead reads UNKNOWN from the start —
  // this is the app-quit-during-update case one launch later.
  const deadPid = spawned.pid;
  const coldStore = new CliUpdaterStateStore(path.join(workspace, "cold-state.json"));
  coldStore.write({
    lastCheck: null,
    lastAttempt: {
      forVersion: "0.147.0",
      startedAt: new Date().toISOString(),
      pid: deadPid,
      exitCode: null,
      logFile: path.join(workspace, "logs", "cold.log"),
    },
  });
  const cold = new CliUpdater({
    livePtyCount: () => 0,
    isEnabled: () => true,
    store: coldStore,
    check: async () => ({ at: new Date().toISOString(), ok: false, installed: null, latest: null }),
    execute: () => null,
    log: () => {},
  });
  assert.equal(cold.reconcile(), "unknown", "a dead pid reconciles to UNKNOWN");

  results.orphanAdoption = {
    pid: attempt.pid,
    logFile: path.basename(attempt.logFile),
    sequence: ["recorded", "adopted RUNNING across a fresh controller", "killed", "UNKNOWN", "idle"],
  };
}

// ── (c) The sanity window, against a genuinely live pid ────────────────────
//
// A pid alone is not proof: pids wrap. A record older than the window naming a
// LIVE pid must still read UNKNOWN, or one recycled pid could hold the update
// mutex forever.
{
  const statePath = path.join(workspace, "stale-state.json");
  const store = new CliUpdaterStateStore(statePath);
  // This test process is, definitionally, a live pid.
  const livePid = process.pid;
  store.write({
    lastCheck: null,
    lastAttempt: {
      forVersion: "0.147.0",
      startedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      pid: livePid,
      exitCode: null,
      logFile: "/tmp/codex-update.log",
    },
  });
  const stale = new CliUpdater({
    livePtyCount: () => 0,
    isEnabled: () => true,
    store,
    check: async () => ({ at: new Date().toISOString(), ok: false, installed: null, latest: null }),
    execute: () => null,
    log: () => {},
  });
  assert.equal(isAlive(livePid), true, "the pid really is alive");
  assert.equal(stale.reconcile(), "unknown", "but a week-old record does not get to claim it");
  assert.equal(await stale.whenIdle(50), "idle", "so the mutex is not held");
  results.pidReuseGuard = { pid: livePid, recordAgeDays: 8, state: "unknown" };
}

for (const pid of strays) {
  killQuietly(pid);
}
fs.rmSync(workspace, { recursive: true, force: true });

console.log(JSON.stringify({ success: true, platform: process.platform, results }, null, 2));
process.exitCode = 0;
