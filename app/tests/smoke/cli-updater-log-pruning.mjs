// Codex CLI auto-update S3 (O2) — update-log retention.
//
// Every attempt writes its own `codex-update-<stamp>.log`, so without a ceiling
// the logs directory grows for the life of the install. Pruning is a DELETE loop
// in a directory Sonata does not exclusively own, running on the same call that
// launches an update — which makes two properties non-negotiable, and this file
// exists to hold them:
//
//   1. It never touches a file that is not one of ours. The match is the full
//      name against the exact shape the executor writes, not a loose prefix.
//   2. It never costs an update. It runs after the child is already spawned and
//      its record persisted, and it swallows its own failures.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const { executeUpdate, pruneUpdateLogs, KEEP_UPDATE_LOGS } = require(
  path.join(distRoot, "main/cli-updater/executor"),
);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cli-updater-prune-"));
const results = {};

const logName = (iso) => `codex-update-${iso.replace(/[:.]/g, "-")}.log`;
const listing = (dir) => fs.readdirSync(dir).sort();

/** A logs dir seeded with `count` update logs, oldest first. */
function seedLogs(dir, count, extras = []) {
  fs.mkdirSync(dir, { recursive: true });
  const names = [];
  for (let i = 0; i < count; i += 1) {
    // Distinct, ordered instants — minutes apart so the stamps sort unambiguously.
    const iso = new Date(Date.UTC(2026, 7, 5, 0, i, 0)).toISOString();
    const name = logName(iso);
    fs.writeFileSync(path.join(dir, name), `attempt ${i}\n`, "utf8");
    names.push(name);
  }
  for (const extra of extras) {
    fs.writeFileSync(path.join(dir, extra), "not ours\n", "utf8");
  }
  return names;
}

// 1) Under the ceiling: nothing is removed.
{
  const dir = path.join(workspace, "under");
  const names = seedLogs(dir, 5);
  pruneUpdateLogs(dir, 20);
  assert.deepEqual(listing(dir), [...names].sort(), "5 logs under a ceiling of 20 are untouched");
  results.underCeiling = 5;
}

// 2) Over the ceiling: the NEWEST `keep` survive, the oldest go. The stamp
//    format makes the name a valid clock, so this is a name sort — no stat, no
//    mtime race.
{
  const dir = path.join(workspace, "over");
  const names = seedLogs(dir, 30);
  pruneUpdateLogs(dir, 10);
  const remaining = listing(dir);
  assert.equal(remaining.length, 10, "exactly `keep` survive");
  assert.deepEqual(remaining, names.slice(-10).sort(), "…and they are the ten NEWEST");
  assert.equal(remaining.includes(names[0]), false, "the oldest is gone");
  assert.equal(remaining.includes(names[29]), true, "the newest is kept");
  results.overCeiling = { seeded: 30, kept: remaining.length };
}

// 3) Exactly at the ceiling: an off-by-one here would delete a log the user is
//    about to need.
{
  const dir = path.join(workspace, "exact");
  const names = seedLogs(dir, 10);
  pruneUpdateLogs(dir, 10);
  assert.deepEqual(listing(dir), [...names].sort(), "N logs with a ceiling of N are all kept");
  results.atCeiling = 10;
}

// 4) THE safety property: nothing that is not ours is ever deleted. The
//    near-misses matter more than the obvious ones — a loose prefix match would
//    eat most of this list.
{
  const dir = path.join(workspace, "foreign");
  const foreign = [
    "codex-update.log", // no stamp
    "codex-update-.log", // empty stamp
    "codex-update-latest.log", // word where the stamp goes
    "codex-update-2026-08-05T00-00-00-000Z.log.bak", // trailing extension
    "codex-update-2026-08-05T00-00-00-000Z.txt", // wrong suffix
    "old-codex-update-2026-08-05T00-00-00-000Z.log", // prefixed
    "renderer.log",
    "main.log",
    "notes.md",
  ];
  const names = seedLogs(dir, 30, foreign);
  pruneUpdateLogs(dir, 5);
  const remaining = listing(dir);
  for (const name of foreign) {
    assert.equal(remaining.includes(name), true, `left alone: ${name}`);
  }
  assert.equal(
    remaining.filter((name) => names.includes(name)).length,
    5,
    "only our own logs were collected",
  );
  results.foreignFilesUntouched = foreign.length;
}

// 5) A directory that does not exist, or cannot be read, is a no-op — not a
//    throw. This runs on the update path; housekeeping must never be able to
//    take an update (or the main process) down with it.
{
  pruneUpdateLogs(path.join(workspace, "does-not-exist"), 5);

  const notADir = path.join(workspace, "a-file");
  fs.writeFileSync(notADir, "not a directory", "utf8");
  const logs = [];
  pruneUpdateLogs(notADir, 5, (message) => logs.push(message));
  assert.ok(logs.length > 0, "the failure is reported…");
  assert.match(logs[0], /could not prune/, "…with a legible message");

  // Degenerate ceilings must not become "delete everything".
  const dir = path.join(workspace, "zero-keep");
  seedLogs(dir, 3);
  pruneUpdateLogs(dir, 0);
  assert.equal(listing(dir).length, 0, "keep=0 empties our logs (and only ours)");
  const negative = path.join(workspace, "negative-keep");
  const names = seedLogs(negative, 3);
  pruneUpdateLogs(negative, -5);
  assert.equal(listing(negative).length, 0, "a negative ceiling clamps to 0, never a slice wrap");
  assert.equal(names.length, 3, "…from a seeded directory of 3");
  results.failureModes = "no throw; degenerate ceilings clamp";
}

// 6) End to end through the REAL executor: launching an update prunes, and the
//    log this attempt just opened is always among the survivors.
{
  const dir = path.join(workspace, "e2e");
  const seeded = seedLogs(dir, 8);
  let doc = { lastCheck: null, lastAttempt: null };
  const store = { read: () => doc, write: (next) => ((doc = next), doc) };

  const attempt = executeUpdate({
    store,
    forVersion: "0.147.0",
    logsDir: dir,
    keepLogs: 3,
    now: () => new Date("2026-08-05T23:59:00.000Z"), // newest of all
    spawnUpdate: ({ logFd }) => {
      fs.writeSync(logFd, "running\n");
      return { pid: 9001, onExit: () => {}, onError: () => {}, unref: () => {} };
    },
  });

  assert.ok(attempt, "the update launched");
  const remaining = listing(dir);
  assert.equal(remaining.length, 3, "pruned to the ceiling");
  assert.equal(
    remaining.includes(path.basename(attempt.logFile)),
    true,
    "THIS attempt's log survives — the child still holds it open",
  );
  assert.equal(fs.existsSync(attempt.logFile), true, "and it is readable");
  assert.match(fs.readFileSync(attempt.logFile, "utf8"), /running/, "with the child's output");
  assert.equal(remaining.includes(seeded[0]), false, "the oldest seeded log was collected");
  // The record still points at a file that exists — a pruned-away logFile would
  // make the facts lie.
  assert.equal(doc.lastAttempt.logFile, attempt.logFile, "the record names the surviving log");
  results.throughExecutor = { seeded: 8, kept: remaining.length };
}

// 7) …and a prune that cannot run must not stop the update. The spawn happens
//    first by construction; this pins that ordering from the outside.
{
  const dir = path.join(workspace, "prune-cannot-run");
  fs.mkdirSync(dir, { recursive: true });
  let doc = { lastCheck: null, lastAttempt: null };
  const store = { read: () => doc, write: (next) => ((doc = next), doc) };
  let spawned = false;

  const attempt = executeUpdate({
    store,
    forVersion: "0.147.0",
    logsDir: dir,
    // A ceiling that is not a number at all — the arithmetic degrades, the
    // update must not.
    keepLogs: Number.NaN,
    spawnUpdate: ({ logFd }) => {
      spawned = true;
      fs.writeSync(logFd, "running\n");
      return { pid: 9002, onExit: () => {}, onError: () => {}, unref: () => {} };
    },
  });

  assert.equal(spawned, true, "the update still spawned");
  assert.ok(attempt, "and was still recorded");
  assert.equal(doc.lastAttempt.pid, 9002, "with its pid");
  // …and the nonsense ceiling fell back to the default rather than being read
  // as "delete everything" — which would have removed the log the running child
  // holds open and left the facts pointing at a file that no longer exists.
  assert.equal(fs.existsSync(attempt.logFile), true, "this attempt's log survived");
  results.pruneNeverBlocksTheUpdate = "spawned, recorded, log intact";
}

// 8) The shipped default is the documented one.
{
  assert.equal(KEEP_UPDATE_LOGS, 20, "keep-last-20 by default");
  results.shippedCeiling = KEEP_UPDATE_LOGS;
}

fs.rmSync(workspace, { recursive: true, force: true });
console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
