// A codex spawn never boots into an in-flight codex auto-update (X5 b) — on the
// REAL RuntimeController, with a fake CodexSpawnGate standing in for the updater.
//
// Woody's report: "Codex 新建 session 发第一条信息有时发不过去，消息不见了".
// MEASURED (spikes/upstream-sync-2026-09/codex/q44-first-message-live.*): the
// spawn waited for a running update at most 15 s, then spawned while `brew
// upgrade` was still relinking the binary (a real cycle ran 13:17:39 → 13:20:21);
// the pty died before its prompt and the first message was lost. Pinned here:
//
//   1. the wait covers the WHOLE update: the gate is asked with the long bound
//      (10 min, WHEN_IDLE_TIMEOUT_MS) — not 15 s;
//   2. an update that finishes inside the bound → the spawn proceeds after it,
//      and the renderer was told `codex-update:waiting` true, then false;
//   3. an update that OUTLASTS the bound → createTask REJECTS loudly, nothing is
//      spawned or persisted (the caller's draft is untouched), and the waiting
//      state is retracted;
//   4. no update running → no wait, no event;
//   5. claude never waits (the gate is not asked).
//
// Fixture provenance: the gate is COMPOSED to the `CodexSpawnGate` contract
// (whenIdle(timeoutMs) → "idle" | "timeout"); the "update" is a timer. The
// codex/claude binaries are no-op scripts on PATH (the harness of
// cli-updater-spawn-gate.mjs). Expected stderr noise: node-pty's caught EIO when
// a teardown writes to a fake CLI that has already exited.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-update-wait-"));
process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
// HOME too: a claude spawn pre-writes folder trust into `~/.claude.json`.
process.env.HOME = path.join(tempRoot, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });
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
const { WHEN_IDLE_TIMEOUT_MS } = require("../../dist/main/cli-updater/cli-updater");
const { INERT_CLI_READINESS_SOURCE } = require("../../dist/main/cli-readiness/session-start-diagnosis");
const { ProjectsStore } = require("../../dist/main/projects-store");
const { TagsStore } = require("../../dist/main/tags-store");
const {
  ResumeSettingsStore,
  ClaudeSettingsStore,
  CodexSettingsStore,
  SonataSettingsStore,
} = require("../../dist/main/settings-store");

const results = {};

/** A CodexSpawnGate whose "update" runs for `updateMs` (0 = none running). */
function fakeGate(updateMs) {
  const calls = { whenIdle: [] };
  return {
    calls,
    spawnDecision: () => ({ suppressNativePrompt: true }),
    whenIdle(timeoutMs) {
      calls.whenIdle.push(timeoutMs);
      if (updateMs === 0) {
        return Promise.resolve("idle");
      }
      return new Promise((resolve) => {
        setTimeout(() => resolve(updateMs <= timeoutMs ? "idle" : "timeout"), Math.min(updateMs, timeoutMs));
      });
    },
    runCycle: () => Promise.resolve(),
  };
}

function makeController(gate, seq, waitMs) {
  const root = path.join(tempRoot, `ctl-${seq}`);
  fs.mkdirSync(root, { recursive: true });
  const events = [];
  const controller = new RuntimeController({
    sendEvent: (event) => events.push(event),
    projectsStore: new ProjectsStore(path.join(root, "projects.json")),
    tagsStore: new TagsStore(path.join(root, "tags.json")),
    resumeSettingsStore: new ResumeSettingsStore(path.join(root, "resume.json")),
    claudeSettingsStore: new ClaudeSettingsStore(path.join(root, "claude.json")),
    codexSettingsStore: new CodexSettingsStore(path.join(root, "codex.json")),
    sonataSettingsStore: new SonataSettingsStore(path.join(root, "sonata.json")),
    cliUpdater: gate,
    cliReadiness: INERT_CLI_READINESS_SOURCE,
    ...(waitMs === undefined ? {} : { codexUpdateWaitMs: waitMs }),
  });
  const waitingTrail = () =>
    events.filter((event) => event.type === "codex-update:waiting").map((event) => event.payload.waiting);
  return { controller, events, waitingTrail };
}

const projectRecords = () => {
  const dir = path.join(process.env.SONATA_DATA_DIR, "data", "projects");
  return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
};

// 1) The production bound is the whole update, not 15 s.
{
  assert.equal(WHEN_IDLE_TIMEOUT_MS, 10 * 60_000, "the production wait is 10 minutes");
  const gate = fakeGate(0);
  const { controller } = makeController(gate, "bound");
  try {
    await controller.createTask({ provider: "codex", cwd: workspace });
    assert.deepEqual(gate.calls.whenIdle, [WHEN_IDLE_TIMEOUT_MS], "the gate is asked with the long bound");
    results.bound = WHEN_IDLE_TIMEOUT_MS;
  } finally {
    controller.dispose();
  }
}

// 2) An update that finishes inside the bound: wait, say so, then spawn.
{
  const gate = fakeGate(300);
  const { controller, events, waitingTrail } = makeController(gate, "finishes", 5_000);
  try {
    const response = await controller.createTask({ provider: "codex", cwd: workspace });
    assert.ok(response.runtime.pid > 0, "spawned after the update");
    assert.deepEqual(waitingTrail(), [true, false], "the renderer heard: waiting, then done");
    const lastWaitAt = events.findLastIndex((event) => event.type === "codex-update:waiting");
    const startedAt = events.findIndex((event) => event.type === "task:started");
    assert.ok(startedAt === -1 || startedAt > lastWaitAt, "no spawn before the wait ended");
    results.finishes = "waited, then spawned";
  } finally {
    controller.dispose();
  }
}

// 3) An update that outlasts the bound: fail loudly, spawn nothing.
{
  const gate = fakeGate(60_000);
  const { controller, events, waitingTrail } = makeController(gate, "outlasts", 300);
  const recordsBefore = projectRecords();
  try {
    let error = null;
    try {
      await controller.createTask({ provider: "codex", cwd: workspace });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, "createTask rejects instead of spawning into the update");
    assert.match(String(error?.message), /Codex is still updating/, "…with a message the composer can show");
    assert.equal(controller.listTasks().length, 0, "no live runtime");
    assert.equal(events.some((event) => event.type === "task:started"), false, "no pty was spawned");
    assert.equal(projectRecords(), recordsBefore, "nothing was persisted (the draft stays the user's)");
    assert.deepEqual(waitingTrail(), [true, false], "the waiting state is retracted on failure");
    results.outlasts = String(error.message);
  } finally {
    controller.dispose();
  }
}

// 4) No update running: no wait, no event.
{
  const gate = fakeGate(0);
  const { controller, waitingTrail } = makeController(gate, "none", 5_000);
  try {
    await controller.createTask({ provider: "codex", cwd: workspace });
    assert.deepEqual(waitingTrail(), [], "nothing to say when nothing is updating");
    results.none = "no event";
  } finally {
    controller.dispose();
  }
}

// 5) Claude never waits on a codex update.
{
  const gate = fakeGate(60_000);
  const { controller, waitingTrail } = makeController(gate, "claude", 300);
  try {
    await controller.createTask({ provider: "claude", cwd: workspace });
    assert.equal(gate.calls.whenIdle.length, 0, "the gate is not asked");
    assert.deepEqual(waitingTrail(), [], "and nothing is said");
    results.claude = "never waits";
  } finally {
    controller.dispose();
  }
}

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(JSON.stringify({ success: true, results }, null, 2));
