// Codex CLI auto-update S3 — the machine with no Codex installed.
//
// Sonata runs the user's OWN CLIs, and plenty of installs have only Claude
// Code. Every part of this subsystem therefore has to be a clean no-op when
// `codex` is not on PATH — and "clean" is a stronger claim than "doesn't
// crash", so this file drives the REAL stack and pins each part of it:
//
//   • the real `checkCodex` (real execFile, real ENOENT — not a fake),
//   • the real `CliUpdater` cycle, on a real facts file,
//   • the real executor (which must never be reached),
//   • `spawnDecision()` and `whenIdle()`, the two spawn-path entry points.
//
// It makes NO network request, and that is asserted rather than assumed: with
// codex absent there is nothing an npm lookup could tell us, so the checker
// must not make one. A machine that only ever runs Claude Code should not be
// querying a registry on Sonata's behalf every twelve hours.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-absent-"));

// A PATH with genuinely no `codex` on it. The login-shell merge is disabled
// too, or a real ~/.zprofile would helpfully hand the real codex back and the
// test would silently stop testing anything.
const emptyBin = path.join(workspace, "bin");
fs.mkdirSync(emptyBin, { recursive: true });
process.env.PATH = emptyBin;
process.env.SONATA_DISABLE_LOGIN_SHELL_PATH = "1";
// Point the real executor's sonataLogsDir() into the workspace, so the
// "no update log was ever opened" assertion below watches the directory the
// code under test would actually write to.
process.env.SONATA_DATA_DIR = workspace;

const { checkCodex } = require(path.join(distRoot, "main/cli-updater/checker"));
const { CliUpdater } = require(path.join(distRoot, "main/cli-updater/cli-updater"));
const { CliUpdaterStateStore } = require(path.join(distRoot, "main/cli-updater/state"));
const { updatePending, sonataOwnsPrompt, shouldExecute, classifyAttempt } = require(
  path.join(distRoot, "main/cli-updater/policy"),
);

const results = {};

// Guard the guard: if `codex` were somehow still resolvable, every assertion
// below would pass for the wrong reason.
{
  const onPath = fs.existsSync(path.join(emptyBin, "codex"));
  assert.equal(onPath, false, "the harness PATH really has no codex");
}

// 1) The real checker: a clean fact, never a throw — and no network.
{
  let fetched = false;
  const fact = await checkCodex({
    fetchDistTags: async () => {
      fetched = true;
      return '{"latest":"0.147.0"}';
    },
  });

  assert.equal(fact.ok, false, "nothing comparable is known");
  assert.equal(fact.installed, null, "no installed version");
  assert.equal(fact.latest, null, "and no latest version was even looked up");
  assert.ok(fact.at, "still a timestamped fact");
  assert.doesNotThrow(() => new Date(fact.at).toISOString(), "with a real instant");
  assert.equal(fetched, false, "NO registry request was made");
  results.check = fact;
}

// 2) The policy over that fact: nothing pending, nothing to execute — and
//    ownership STAYS with Sonata, which is the honest answer rather than an
//    oversight. `sonataOwnsPrompt` hands back only on a demonstrated hard
//    failure against the current latest; "we could not find codex" is not a
//    failure to update codex, so there is nothing to hand back TO. With no
//    codex installed there is also no session that could show a prompt, so the
//    flag is vacuous either way.
{
  const facts = {
    lastCheck: { at: new Date().toISOString(), ok: false, installed: null, latest: null },
    lastAttempt: null,
  };
  const attemptState = classifyAttempt(facts.lastAttempt, { pidAlive: false, nowMs: Date.now() });
  assert.equal(updatePending(facts), false, "an unknown pair is never pending");
  assert.equal(sonataOwnsPrompt({ setting: true, facts, attemptState }), true, "Sonata keeps the prompt");
  for (const reason of ["first-check", "interval", "pty-exit", "manual"]) {
    assert.equal(
      shouldExecute({ setting: true, facts, attemptState, livePtyCount: 0, reason }),
      false,
      `no execution on any trigger (${reason})`,
    );
  }
  results.policy = { pending: false, owns: true, executes: false };
}

// 3) The full cycle on a real facts file, with the REAL executor wired in. A
//    single `codex update` reaching a machine without codex would be the whole
//    failure this slice is about, so the executor is left real and its logs
//    directory is watched.
{
  const statePath = path.join(workspace, "cli-updater-state.json");
  const logsDir = path.join(workspace, "logs");
  const store = new CliUpdaterStateStore(statePath);
  const logs = [];

  const updater = new CliUpdater({
    livePtyCount: () => 0,
    isEnabled: () => true,
    store,
    // No `check` and no `execute` override: both are the real thing.
    log: (message) => logs.push(message),
  });

  for (const reason of ["first-check", "interval", "pty-exit"]) {
    await updater.runCycle(reason); // must not reject
  }

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persisted.lastCheck.ok, false, "the persisted fact says nothing is known");
  assert.equal(persisted.lastCheck.installed, null, "no installed version on disk");
  assert.equal(persisted.lastAttempt, null, "NO attempt was ever recorded");
  assert.equal(fs.existsSync(logsDir), false, "and no update log was ever opened");
  assert.equal(updater.attemptState(), "none", "the attempt state stays empty");
  assert.equal(
    logs.some((line) => line.includes("failed")),
    false,
    `no cycle reported a failure (${JSON.stringify(logs)})`,
  );
  results.cycles = { ran: 3, attempts: 0, logsDirCreated: false };

  // 4) The spawn path: both entry points answer instantly and neither throws.
  //    A Claude-only user must never notice this subsystem exists.
  const decision = updater.spawnDecision();
  assert.equal(typeof decision.suppressNativePrompt, "boolean", "a real decision");
  assert.equal(decision.suppressNativePrompt, true, "Sonata owns a prompt nothing will ever show");

  const startedAt = Date.now();
  assert.equal(await updater.whenIdle(5_000), "idle", "the spawn mutex is open");
  assert.ok(Date.now() - startedAt < 200, "…and did not wait");

  // With the setting off, it is even quieter: no check at all.
  const offLogs = [];
  const offUpdater = new CliUpdater({
    livePtyCount: () => 0,
    isEnabled: () => false,
    store,
    log: (message) => offLogs.push(message),
  });
  await offUpdater.runCycle("interval");
  assert.equal(offUpdater.spawnDecision().suppressNativePrompt, false, "setting off → codex owns");
  assert.ok(
    offLogs.some((line) => line.includes("off")),
    "and the cycle skipped outright",
  );

  updater.dispose();
  offUpdater.dispose();
  results.spawnPath = { suppressNativePrompt: true, whenIdle: "idle", settingOff: "codex owns" };
}

// 5) Reconcile across a restart is equally quiet — nothing was left behind to
//    adopt, so a fresh controller over the same file starts from "none".
{
  const store = new CliUpdaterStateStore(path.join(workspace, "cli-updater-state.json"));
  const restarted = new CliUpdater({ livePtyCount: () => 0, isEnabled: () => true, store, log: () => {} });
  assert.equal(restarted.reconcile(), "none", "nothing to reconcile");
  restarted.dispose();
  results.reconcile = "none";
}

fs.rmSync(workspace, { recursive: true, force: true });
console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
