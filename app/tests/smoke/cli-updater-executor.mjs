// Codex CLI auto-update S1 — the executor's record, and its ordering.
//
// The `lastAttempt` row is simultaneously the outcome, the cross-restart mutex
// and the failure's version scope, so WHEN it is written is as load-bearing as
// what it contains. The ordering claim under test: the record is persisted in
// the same tick as the spawn, strictly before the exit listener is registered —
// so no interleaving exists in which an exit patch races a missing record.
//
// The spawn seam is a five-line fake; nothing here mocks node:child_process.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const { executeUpdate } = require(path.join(distRoot, "main/cli-updater/executor"));

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cli-updater-exec-"));
const results = {};

const NOW = new Date("2026-08-05T12:00:01.000Z");

/** In-memory facts store that records the order of its writes. */
function fakeStore(initial = { lastCheck: null, lastAttempt: null }, trace = []) {
  let doc = initial;
  return {
    read: () => doc,
    write: (next) => {
      trace.push("store.write");
      doc = next;
      return next;
    },
    current: () => doc,
  };
}

/**
 * A stand-in for the detached `codex update`. Writes to the fd it is handed —
 * which is how we prove the executor opened a real, appendable log and passed it
 * through — and hands back the exit/error listeners for the test to fire.
 */
function fakeChild({ pid = 9001, trace = [], childOutput = "" } = {}) {
  const handle = { pid, exitListener: null, errorListener: null, unreffed: false, fd: null };
  handle.spawn = (input) => {
    trace.push("spawn");
    handle.fd = input.logFd;
    if (childOutput) {
      fs.writeSync(input.logFd, childOutput);
    }
    return {
      pid,
      onExit: (listener) => {
        trace.push("onExit");
        handle.exitListener = listener;
      },
      onError: (listener) => {
        trace.push("onError");
        handle.errorListener = listener;
      },
      unref: () => {
        trace.push("unref");
        handle.unreffed = true;
      },
    };
  };
  return handle;
}

// 1) Write-ahead ordering + the shape of the record.
{
  const logsDir = path.join(workspace, "logs-ordering");
  const trace = [];
  const store = fakeStore({ lastCheck: null, lastAttempt: null }, trace);
  // MEASURED — `codex update`'s real success banner on this machine (brew cask,
  // 2026-08-05): it prints this and exits 0 EVEN when brew declines the upgrade,
  // which is why exit 0 is not read as success anywhere in this design (G3).
  const child = fakeChild({ pid: 9001, trace, childOutput: "🎉 Update ran successfully!\n" });

  const attempt = executeUpdate({
    store,
    forVersion: "0.147.0",
    now: () => NOW,
    logsDir,
    spawnUpdate: child.spawn,
  });

  assert.ok(attempt, "an attempt record is returned");
  assert.equal(attempt.forVersion, "0.147.0", "records the version it was reaching for");
  assert.equal(attempt.startedAt, NOW.toISOString(), "records the spawn time");
  assert.equal(attempt.pid, 9001, "records the child's pid");
  assert.equal(attempt.exitCode, null, "written unreaped — the mutex is held");

  // THE ordering assertion. The error listener must be registered first (an
  // unhandled `error` on a real ChildProcess is fatal), the record must be
  // written before the exit listener exists, and both must follow the spawn.
  assert.deepEqual(
    trace,
    ["spawn", "onError", "unref", "store.write", "onExit"],
    "spawn → error listener → unref → PERSIST → exit listener",
  );
  assert.ok(
    trace.indexOf("store.write") < trace.indexOf("onExit"),
    "the record exists before anything can observe an exit",
  );
  assert.equal(child.unreffed, true, "the child is unref'd — it must outlive Sonata");
  assert.deepEqual(store.current().lastAttempt, attempt, "persisted verbatim");

  // The log: under the given logs dir, named for the attempt, carrying a
  // write-ahead header, and genuinely writable by the child.
  assert.equal(path.dirname(attempt.logFile), logsDir, "log lands under the logs dir");
  assert.equal(
    path.basename(attempt.logFile),
    "codex-update-2026-08-05T12-00-01-000Z.log",
    "log is named for this attempt (fs-safe stamp)",
  );
  const logText = fs.readFileSync(attempt.logFile, "utf8");
  assert.match(logText, /^--- sonata: codex update -> 0\.147\.0 at /m, "write-ahead header line");
  assert.match(logText, /Update ran successfully/, "the child's own output lands in the log");
  results.ordering = trace;
  results.logFile = path.basename(attempt.logFile);

  // 2) Exit capture patches the SAME record in place.
  child.exitListener(0);
  assert.equal(store.current().lastAttempt.exitCode, 0, "exit 0 is captured");
  assert.equal(store.current().lastAttempt.pid, 9001, "the rest of the record is untouched");
  results.exitCapture = 0;
}

// 3) A non-zero exit is the ONLY real failure signal `codex update` gives (G3).
{
  const store = fakeStore();
  const child = fakeChild({ pid: 9002 });
  executeUpdate({
    store,
    forVersion: "0.147.0",
    now: () => NOW,
    logsDir: path.join(workspace, "logs-fail"),
    spawnUpdate: child.spawn,
  });
  child.exitListener(1);
  assert.equal(store.current().lastAttempt.exitCode, 1, "non-zero exit is captured");
  results.hardFail = 1;
}

// 4) A signal death leaves the record unreaped. The child was killed, not
//    failed — and a fabricated non-zero code here would hand the boot prompt
//    back to codex over something that was never codex's fault.
{
  const store = fakeStore();
  const child = fakeChild({ pid: 9003 });
  executeUpdate({
    store,
    forVersion: "0.147.0",
    now: () => NOW,
    logsDir: path.join(workspace, "logs-signal"),
    spawnUpdate: child.spawn,
  });
  child.exitListener(null);
  assert.equal(store.current().lastAttempt.exitCode, null, "signal death stays UNKNOWN");
  results.signalDeath = "unknown";
}

// 5) A spawn-level error (ENOENT — codex vanished between check and execute)
//    does not fabricate a failure either.
{
  const store = fakeStore();
  const child = fakeChild({ pid: 9004 });
  const logs = [];
  executeUpdate({
    store,
    forVersion: "0.147.0",
    now: () => NOW,
    logsDir: path.join(workspace, "logs-error"),
    spawnUpdate: child.spawn,
    log: (message) => logs.push(message),
  });
  assert.ok(child.errorListener, "an error listener is always registered");
  child.errorListener(new Error("spawn codex ENOENT"));
  assert.equal(store.current().lastAttempt.exitCode, null, "a spawn error is not a hard failure");
  assert.ok(
    logs.some((line) => line.includes("ENOENT")),
    "but it is reported",
  );
  results.spawnError = "unknown";
}

// 6) No pid means no child: record nothing rather than a row naming a pid that
//    never existed.
{
  const store = fakeStore();
  const trace = [];
  const attempt = executeUpdate({
    store,
    forVersion: "0.147.0",
    now: () => NOW,
    logsDir: path.join(workspace, "logs-nopid"),
    spawnUpdate: (input) => {
      trace.push("spawn");
      fs.writeSync(input.logFd, "");
      return { pid: undefined, onExit: () => {}, onError: () => {}, unref: () => {} };
    },
  });
  assert.equal(attempt, null, "returns null");
  assert.equal(store.current().lastAttempt, null, "nothing is recorded");
  results.noPid = "not recorded";
}

// 7) A stale exit listener must not resurrect a dead fact. The app quit, a new
//    cycle recorded a newer attempt, and only THEN does the old listener fire.
{
  const store = fakeStore();
  const child = fakeChild({ pid: 9005 });
  executeUpdate({
    store,
    forVersion: "0.147.0",
    now: () => NOW,
    logsDir: path.join(workspace, "logs-stale"),
    spawnUpdate: child.spawn,
  });
  const newer = {
    forVersion: "0.148.0",
    startedAt: "2026-08-06T12:00:00.000Z",
    pid: 9999,
    exitCode: null,
    logFile: "/tmp/newer.log",
  };
  store.write({ ...store.current(), lastAttempt: newer });
  child.exitListener(1);
  assert.deepEqual(store.current().lastAttempt, newer, "the newer attempt is left intact");
  results.staleListener = "ignored";
}

// 8) An unwritable logs dir is a clean no-op, not a throw. Nothing about a
//    background maintenance task may take down the main process.
{
  const blocked = path.join(workspace, "blocked");
  fs.writeFileSync(blocked, "not a directory", "utf8");
  const store = fakeStore();
  const logs = [];
  let spawned = false;
  const attempt = executeUpdate({
    store,
    forVersion: "0.147.0",
    now: () => NOW,
    logsDir: path.join(blocked, "logs"),
    spawnUpdate: () => {
      spawned = true;
      throw new Error("should not reach the spawn");
    },
    log: (message) => logs.push(message),
  });
  assert.equal(attempt, null, "returns null");
  assert.equal(spawned, false, "no child is spawned without a log to write to");
  assert.equal(store.current().lastAttempt, null, "nothing is recorded");
  assert.ok(logs.length > 0, "the failure is reported");
  results.unwritableLogsDir = "no-op";
}

fs.rmSync(workspace, { recursive: true, force: true });
console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
