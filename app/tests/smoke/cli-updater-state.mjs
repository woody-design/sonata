// Codex CLI auto-update S1 — the facts file.
//
// The whole design rests on two persisted records, so this fence is about what
// a BAD file may do: a half-written, hand-edited or truncated facts file must
// never be able to fabricate a fact. Losing a fact costs one re-check; trusting
// a malformed one could suppress the user's update prompt or wedge the mutex on
// a pid that was never ours.
//
// Also asserts what is NOT in the schema: no stored ownership/mode field.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const { CliUpdaterStateStore, normalizeCliUpdaterState, EMPTY_CLI_UPDATER_STATE } = require(
  path.join(distRoot, "main/cli-updater/state"),
);
const { cliUpdaterStatePath } = require(path.join(distRoot, "main/settings-store"));

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cli-updater-state-"));
const filePath = path.join(workspace, "cli-updater-state.json");
const store = new CliUpdaterStateStore(filePath);
const results = {};

// COMPOSED — a complete, well-formed facts document. Version numbers echo the
// real 0.146.0 → 0.147.0 line; the pid, timestamps and log path are invented.
const FULL = {
  lastCheck: {
    at: "2026-08-05T12:00:00.000Z",
    ok: true,
    installed: "0.146.0",
    latest: "0.147.0",
  },
  lastAttempt: {
    forVersion: "0.147.0",
    startedAt: "2026-08-05T12:00:01.000Z",
    pid: 4242,
    exitCode: null,
    logFile: "/Users/x/.sonata/logs/codex-update-2026-08-05T12-00-01-000Z.log",
  },
};

// 1) A missing file reads as empty facts — the first launch, and the only
//    starting point the policy is ever given.
{
  assert.deepEqual(store.read(), EMPTY_CLI_UPDATER_STATE, "missing file → empty facts");
  assert.equal(fs.existsSync(filePath), false, "reading does not create the file");
  results.missingFile = "empty";
}

// 2) Full round-trip through the real atomic write.
{
  assert.deepEqual(store.write(FULL), FULL, "write returns the normalized document");
  assert.deepEqual(store.read(), FULL, "round-trips through disk");
  const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(onDisk, FULL, "on-disk bytes match");
  assert.deepEqual(
    Object.keys(onDisk).sort(),
    ["lastAttempt", "lastCheck"],
    "the file holds facts and NOTHING else — no stored ownership/mode field (D8)",
  );
  results.roundTrip = "ok";
}

// 3) The exit-code patch — the one in-place mutation the executor performs.
{
  const patched = store.write({
    ...FULL,
    lastAttempt: { ...FULL.lastAttempt, exitCode: 0 },
  });
  assert.equal(patched.lastAttempt.exitCode, 0, "exitCode 0 persists");
  assert.equal(store.read().lastAttempt.exitCode, 0, "patched code round-trips");
  assert.equal(store.write({ ...FULL, lastAttempt: { ...FULL.lastAttempt, exitCode: 1 } })
    .lastAttempt.exitCode, 1, "non-zero exitCode persists");
  results.exitPatch = "ok";
}

// 4) Malformed documents normalize to null FACTS, never to invented ones.
{
  // COMPOSED — one row per way a file can lie.
  const bad = [
    ["not JSON at all", "{ this is not json"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"hello"'],
    ["null document", "null"],
    ["empty object", "{}"],
    ["truncated write", '{"lastCheck":{"at":"2026-08-05T12:00:00.000Z","ok":tr'],
  ];
  for (const [label, raw] of bad) {
    fs.writeFileSync(filePath, raw, "utf8");
    assert.deepEqual(store.read(), EMPTY_CLI_UPDATER_STATE, `${label} → empty facts`);
  }
  results.malformedDocuments = bad.length;
}

// 5) Field-level normalize: a partial record is dropped whole, not patched with
//    defaults. Half a fact is not a fact.
{
  const cases = [
    ["lastCheck without `at`", { lastCheck: { ok: true, installed: "1.0.0", latest: "1.0.1" } }, "lastCheck"],
    ["lastCheck with a non-boolean ok", { lastCheck: { at: "x", ok: "yes" } }, "lastCheck"],
    ["lastCheck as a string", { lastCheck: "0.147.0" }, "lastCheck"],
    ["lastAttempt without a pid", { lastAttempt: { forVersion: "1.0.1", startedAt: "x", logFile: "y" } }, "lastAttempt"],
    ["lastAttempt with pid 0", { lastAttempt: { ...FULL.lastAttempt, pid: 0 } }, "lastAttempt"],
    ["lastAttempt with a string pid", { lastAttempt: { ...FULL.lastAttempt, pid: "4242" } }, "lastAttempt"],
    ["lastAttempt with a fractional pid", { lastAttempt: { ...FULL.lastAttempt, pid: 42.5 } }, "lastAttempt"],
    ["lastAttempt without a logFile", { lastAttempt: { ...FULL.lastAttempt, logFile: "" } }, "lastAttempt"],
    ["lastAttempt without forVersion", { lastAttempt: { ...FULL.lastAttempt, forVersion: null } }, "lastAttempt"],
  ];
  for (const [label, doc, slot] of cases) {
    assert.equal(normalizeCliUpdaterState(doc)[slot], null, `${label} → ${slot} dropped`);
  }
  results.partialRecords = cases.length;
}

// 6) `ok` can only narrow on read. A document claiming a comparable pair while
//    missing a version is incoherent; the coherent reading is "not comparable",
//    and it is the one that cannot cause a spurious update.
{
  assert.equal(
    normalizeCliUpdaterState({ lastCheck: { at: "x", ok: true, installed: "1.0.0", latest: null } })
      .lastCheck.ok,
    false,
    "ok=true with no latest narrows to false",
  );
  assert.equal(
    normalizeCliUpdaterState({ lastCheck: { at: "x", ok: true, installed: null, latest: "1.0.1" } })
      .lastCheck.ok,
    false,
    "ok=true with no installed narrows to false",
  );
  assert.equal(
    normalizeCliUpdaterState({
      lastCheck: { at: "x", ok: false, installed: "1.0.0", latest: "1.0.1" },
    }).lastCheck.ok,
    false,
    "ok=false is never widened",
  );
  results.okNarrows = "ok";
}

// 7) A non-integer exitCode reads as "not observed" — the slot that keeps a
//    record OUT of hard-failed, so a corrupt field can never trigger handback.
{
  for (const exitCode of ["1", 1.5, {}, true, undefined]) {
    const normalized = normalizeCliUpdaterState({
      lastAttempt: { ...FULL.lastAttempt, exitCode },
    });
    assert.equal(
      normalized.lastAttempt.exitCode,
      null,
      `exitCode ${JSON.stringify(exitCode)} → null (never a fabricated failure)`,
    );
  }
  results.exitCodeFallSafe = "ok";
}

// 8) The path helper joins the settings-store family (and honours the same
//    SONATA_SETTINGS_DIR override every sibling uses).
{
  const saved = process.env.SONATA_SETTINGS_DIR;
  try {
    process.env.SONATA_SETTINGS_DIR = "/tmp/sonata-cli-updater-probe";
    assert.equal(
      cliUpdaterStatePath(),
      "/tmp/sonata-cli-updater-probe/cli-updater-state.json",
      "SONATA_SETTINGS_DIR override wins",
    );
  } finally {
    if (saved === undefined) {
      delete process.env.SONATA_SETTINGS_DIR;
    } else {
      process.env.SONATA_SETTINGS_DIR = saved;
    }
  }
  assert.equal(path.basename(cliUpdaterStatePath()), "cli-updater-state.json", "stable filename");
  results.pathHelper = "ok";
}

fs.rmSync(workspace, { recursive: true, force: true });
console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
