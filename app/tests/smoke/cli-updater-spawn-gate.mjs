// Codex CLI auto-update S2 — the updater's three touch points on the REAL
// RuntimeController, driven end to end against a fake CLI on PATH.
//
//   1. `spawnDecision()` is consulted PER SPAWN and reaches the codex argv.
//   2. A codex spawn waits on `whenIdle()` first; a Claude spawn never does.
//   3. The last codex session ending fires `runCycle("pty-exit")`.
//
// Every one of these fails SILENTLY if it is wired wrong — the flag simply
// never appears, no spawn ever waits, no cycle ever fires — so the fence drives
// the actual controller rather than a copy of its logic. Same harness shape as
// codex-approval-injection.mjs: a no-op `codex`/`claude` on PATH, so no real CLI
// and no network are involved and the argv is captured at spawn.
//
// Expected stderr noise: the fake CLIs exit instantly, so a `closeTask` that
// writes a teardown sequence hits a dead pty and node-pty logs its own caught
// `EIO` ("Unhandled pty write error"). It is an artifact of a CLI that exits in
// zero milliseconds, not a failure — in production the CLI is alive when the
// close is written.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cli-updater-spawn-"));
// Isolate every Sonata-owned path AND the Codex profile home — never touch the
// real ~/.sonata or ~/.codex.
process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");

const binDir = path.join(tempRoot, "bin");
fs.mkdirSync(binDir, { recursive: true });
for (const cli of ["codex", "claude"]) {
  const fake = path.join(binDir, cli);
  fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.chmodSync(fake, 0o755);
}
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

const workspace = path.join(tempRoot, "workspace");
fs.mkdirSync(workspace, { recursive: true });

const { RuntimeController } = require("../../dist/main/runtime-controller");
const { ProjectsStore } = require("../../dist/main/projects-store");
const { TagsStore } = require("../../dist/main/tags-store");
const {
  ResumeSettingsStore,
  ClaudeSettingsStore,
  CodexSettingsStore,
  SonataSettingsStore,
} = require("../../dist/main/settings-store");

const results = {};
const FLAG = "check_for_update_on_startup=false";
const hasFlag = (argv) => argv.some((token, i) => token === "-c" && argv[i + 1] === FLAG);

/** A recording stand-in for the CliUpdater — the `CodexSpawnGate` surface only. */
function fakeGate({ suppress = true } = {}) {
  const calls = { spawnDecision: 0, whenIdle: 0, cycles: [] };
  let idleResolvers = [];
  return {
    calls,
    /** Make the next whenIdle() hang until `release()` — the "an update is
     *  running right now" case. */
    holdIdle: false,
    release() {
      for (const resolve of idleResolvers) {
        resolve("idle");
      }
      idleResolvers = [];
    },
    setSuppress(value) {
      suppress = value;
    },
    spawnDecision() {
      calls.spawnDecision += 1;
      return { suppressNativePrompt: suppress };
    },
    whenIdle() {
      calls.whenIdle += 1;
      if (!this.holdIdle) {
        return Promise.resolve("idle");
      }
      return new Promise((resolve) => idleResolvers.push(resolve));
    },
    runCycle(reason) {
      calls.cycles.push(reason);
      return Promise.resolve();
    },
  };
}

function makeController(gate, seq) {
  const root = path.join(tempRoot, `ctl-${seq}`);
  fs.mkdirSync(root, { recursive: true });
  return new RuntimeController({
    sendEvent: () => {},
    projectsStore: new ProjectsStore(path.join(root, "projects.json")),
    tagsStore: new TagsStore(path.join(root, "tags.json")),
    resumeSettingsStore: new ResumeSettingsStore(path.join(root, "resume.json")),
    claudeSettingsStore: new ClaudeSettingsStore(path.join(root, "claude.json")),
    codexSettingsStore: new CodexSettingsStore(path.join(root, "codex.json")),
    sonataSettingsStore: new SonataSettingsStore(path.join(root, "sonata.json")),
    cliUpdater: gate,
  });
}

// 1) Ownership reaches the argv — and it is asked PER SPAWN, never cached.
{
  const gate = fakeGate({ suppress: true });
  const controller = makeController(gate, "own");
  try {
    const owned = await controller.createTask({ provider: "codex", cwd: workspace });
    assert.equal(hasFlag(owned.runtime.args), true, "Sonata owns → codex's prompt is suppressed");
    assert.equal(gate.calls.spawnDecision, 1, "asked once for that spawn");

    // Ownership is derived, so it can flip between two spawns of the same
    // controller — e.g. a hard failure recorded seconds ago. A cached decision
    // would keep suppressing a prompt Sonata has already handed back.
    gate.setSuppress(false);
    const handedBack = await controller.createTask({ provider: "codex", cwd: workspace });
    assert.equal(hasFlag(handedBack.runtime.args), false, "handed back → codex prompts again");
    assert.equal(gate.calls.spawnDecision, 2, "asked AGAIN for the second spawn (not cached)");

    results.perSpawnDecision = { spawns: 2, decisions: gate.calls.spawnDecision };
  } finally {
    controller.dispose();
  }
}

// 2) Claude never carries the flag and never waits. Claude Code self-updates;
//    Sonata does nothing there by explicit decision, and this fence is what
//    keeps a codex-shaped option from leaking across the provider boundary.
{
  const gate = fakeGate({ suppress: true });
  const controller = makeController(gate, "claude");
  try {
    const claude = await controller.createTask({ provider: "claude", cwd: workspace });
    assert.equal(hasFlag(claude.runtime.args), false, "no codex update flag on a claude spawn");
    assert.equal(
      claude.runtime.args.some((token) => token.includes("check_for_update_on_startup")),
      false,
      "…under any spelling",
    );
    assert.equal(gate.calls.whenIdle, 0, "a claude spawn never waits on a codex update");
    assert.equal(gate.calls.spawnDecision, 0, "and never asks who owns the codex prompt");
    results.claudeUntouched = "no flag, no wait, no ask";
  } finally {
    controller.dispose();
  }
}

// 3) The mutex: a codex spawn holds until the running update finishes (D5).
//    Codex re-execs itself through arg0 symlinks to current_exe(), so booting
//    while a package manager swaps that binary is the G1 hazard.
{
  const gate = fakeGate({ suppress: true });
  const controller = makeController(gate, "mutex");
  try {
    gate.holdIdle = true;
    let spawned = false;
    const pending = controller.createTask({ provider: "codex", cwd: workspace }).then((response) => {
      spawned = true;
      return response;
    });

    // Give the microtask queue every chance to run the spawn early.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(gate.calls.whenIdle, 1, "the spawn asked to wait");
    assert.equal(spawned, false, "and is genuinely held — no pty yet");

    gate.release();
    const response = await pending;
    assert.equal(spawned, true, "released once the update finished");
    assert.equal(hasFlag(response.runtime.args), true, "and then spawns normally");
    results.mutex = "held, then released";
  } finally {
    controller.dispose();
  }
}

// 4) The third trigger: the LAST codex session ending. Not the first, not a
//    claude one — and the count is read after the retirement, so it is accurate.
{
  const gate = fakeGate({ suppress: true });
  const controller = makeController(gate, "trigger");
  try {
    assert.equal(controller.liveCodexPtyCount(), 0, "no sessions yet");

    const first = await controller.createTask({ provider: "codex", cwd: workspace });
    const second = await controller.createTask({ provider: "codex", cwd: workspace });
    const claude = await controller.createTask({ provider: "claude", cwd: workspace });
    assert.equal(controller.liveCodexPtyCount(), 2, "two codex sessions; the claude one is not counted");
    assert.deepEqual(gate.calls.cycles, [], "spawning fires no cycle");

    controller.closeTask(claude.task.id);
    assert.equal(controller.liveCodexPtyCount(), 2, "closing the claude session changes nothing");
    assert.deepEqual(gate.calls.cycles, [], "and fires no cycle");

    controller.closeTask(first.task.id);
    assert.equal(controller.liveCodexPtyCount(), 1, "one codex session left");
    assert.deepEqual(gate.calls.cycles, [], "not the LAST one, so no cycle yet");

    controller.closeTask(second.task.id);
    assert.equal(controller.liveCodexPtyCount(), 0, "the last codex session is gone");
    assert.deepEqual(gate.calls.cycles, ["pty-exit"], "NOW the cycle fires, exactly once");

    results.lastSessionTrigger = gate.calls.cycles;
  } finally {
    controller.dispose();
  }
}

// 5) Teardown is not a user finishing a session. `dispose()` retires every
//    runtime in a loop, which drives the codex count to zero — that must not be
//    read as "now is a good time to update", right as the app is closing.
{
  const gate = fakeGate({ suppress: true });
  const controller = makeController(gate, "dispose");
  await controller.createTask({ provider: "codex", cwd: workspace });
  assert.equal(controller.liveCodexPtyCount(), 1, "one live codex session");
  controller.dispose();
  assert.equal(controller.liveCodexPtyCount(), 0, "disposed");
  assert.deepEqual(gate.calls.cycles, [], "quitting fires no cycle");
  results.disposeIsNotAnExit = "no cycle on teardown";
}

// 6) The MUTUAL wiring, with the real CliUpdater — the exact shape main.ts
//    builds. The controller asks the updater who owns the prompt; the updater
//    asks the controller how many Codex sessions are live. Neither side is
//    tested by the fakes above, and a mis-wired `livePtyCount` would silently
//    undo the G1 guarantee: an update launched under a live session.
{
  const { CliUpdater } = require("../../dist/main/cli-updater/cli-updater");

  let controller = null;
  const executed = [];
  let doc = {
    lastCheck: { at: new Date().toISOString(), ok: true, installed: "0.146.0", latest: "0.147.0" },
    lastAttempt: null,
  };
  // main.ts's exact seam: `runtimeController?.liveCodexPtyCount() ?? 0`. The
  // optional hop is honest — before the controller exists there really are zero
  // live sessions.
  const updater = new CliUpdater({
    livePtyCount: () => controller?.liveCodexPtyCount() ?? 0,
    isEnabled: () => true,
    store: { read: () => doc, write: (next) => ((doc = next), doc) },
    check: async () => ({
      at: new Date().toISOString(),
      ok: true,
      installed: "0.146.0",
      latest: "0.147.0",
    }),
    // Records an attempt the way the real executor does — which is what makes
    // the O1 gate observable below.
    execute: (forVersion) => {
      executed.push(forVersion);
      const attempt = {
        forVersion,
        startedAt: new Date().toISOString(),
        pid: 4242,
        exitCode: 0,
        logFile: "/tmp/codex-update.log",
      };
      doc = { ...doc, lastAttempt: attempt };
      return attempt;
    },
    isPidAlive: () => false,
    log: () => {},
  });

  controller = makeController(updater, "mutual");
  try {
    // Zero sessions → free to run.
    await updater.runCycle("interval");
    assert.deepEqual(executed, ["0.147.0"], "zero live codex sessions → the update runs");

    // THE assertion this block exists for. A live Codex session must block it:
    // codex re-execs itself through arg0 symlinks to current_exe(), so swapping
    // the binary underneath dangles them or silently mixes versions (G1). A
    // mis-wired livePtyCount would undo that guarantee invisibly.
    const live = await controller.createTask({ provider: "codex", cwd: workspace });
    assert.equal(controller.liveCodexPtyCount(), 1, "one live codex session");
    await updater.runCycle("interval");
    assert.deepEqual(executed, ["0.147.0"], "a live codex session blocks the update");

    // Closing it fires the real trigger through the real controller. O1 declines
    // it (an attempt already exists for 0.147.0), which is also what makes this
    // deterministic — the fired cycle cannot race the assertions below.
    const claude = await controller.createTask({ provider: "claude", cwd: workspace });
    controller.closeTask(live.task.id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(controller.liveCodexPtyCount(), 0, "a live claude session is not counted");
    assert.deepEqual(executed, ["0.147.0"], "the churn trigger fired, and O1 declined it");

    // …and a scheduled tick, with only a Claude session live, still retries.
    await updater.runCycle("interval");
    assert.deepEqual(executed, ["0.147.0", "0.147.0"], "a claude session never blocks the update");

    controller.closeTask(claude.task.id);
    results.mutualWiring = {
      runs: executed.length,
      gate: "live codex blocks; claude does not; churn declined by O1",
    };
  } finally {
    controller.dispose();
    updater.dispose();
  }
}

// 7) Teardown ACROSS the suspension point. The idle gate can hold a spawn for
//    up to 15s, and on macOS `window-all-closed` disposes the controller while
//    the process lives on — so a spawn can resume into a controller that no
//    longer exists. Assembling anyway would spawn a PTY that
//    `noteRuntimeRetired` (fenced by the same flag) can never retire: a leaked
//    process with no owner. Both entry points re-check after the await.
{
  // createTask
  {
    const gate = fakeGate({ suppress: true });
    const controller = makeController(gate, "teardown-create");
    gate.holdIdle = true;
    const pending = controller.createTask({ provider: "codex", cwd: workspace });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(gate.calls.whenIdle, 1, "the spawn is suspended on the gate");

    controller.dispose(); // the user closed the last window
    gate.release(); // …and only then does the update finish

    const outcome = await pending.then(
      () => null,
      (error) => error,
    );
    assert.ok(outcome instanceof Error, "the resumed createTask rejects rather than assembling");
    assert.match(outcome.message, /disposed/i, `message names the cause (${outcome?.message})`);
    assert.equal(controller.liveCodexPtyCount(), 0, "and no orphan runtime was registered");
  }

  // openTask — same guard, and it must survive the pre-await validation that
  // already passed.
  {
    const gate = fakeGate({ suppress: true });
    const controller = makeController(gate, "teardown-open");
    const seed = await controller.createTask({ provider: "codex", cwd: workspace });
    controller.closeTask(seed.task.id); // retired, but the manifest persists
    assert.equal(controller.liveCodexPtyCount(), 0, "seeded task is dormant");

    gate.holdIdle = true;
    const pending = controller.openTask({ taskId: seed.task.id, resume: false });
    await new Promise((resolve) => setTimeout(resolve, 40));

    controller.dispose();
    gate.release();

    const outcome = await pending.then(
      () => null,
      (error) => error,
    );
    assert.ok(outcome instanceof Error, "the resumed openTask rejects too");
    assert.match(outcome.message, /disposed/i, `message names the cause (${outcome?.message})`);
    assert.equal(controller.liveCodexPtyCount(), 0, "no orphan runtime");
  }
  results.teardownAcrossSuspension = "both entry points reject, no orphan PTY";
}

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
