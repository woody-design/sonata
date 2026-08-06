// Layer-1 smoke — the RuntimeController tells a DORMANT task apart from a
// task that never existed, so the Local API can map the two to distinct wire
// codes (taskNotLive -32002 vs taskNotFound -32001).
//
// This fences the CONTROLLER half of H2: `submitPrompt` on a persisted-but-not-
// live session throws TaskNotLiveError, while a truly-unknown id keeps throwing
// TaskNotFoundError with its original message (so the renderer, which only ever
// submits to live tasks, sees byte-identical behavior). It drives the REAL
// RuntimeController — not a copy of requireLiveTaskRuntime's logic — against a
// manifest written straight to disk, so it needs no PTY and no provider install:
// the discrimination is taskRuntimes.get() (empty) + persistedSessionRecord()
// (disk read), both reachable before anything spawns.
//
// The plain-node `local-api.mjs` suite fences the SERVER half (typed error →
// wire code) with a fake facade; RuntimeController pulls in Electron, so this
// half runs under `ELECTRON_RUN_AS_NODE=1 electron`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-local-api-ctrl-"));
// Isolate every Sonata-owned path to temp — NEVER touch the real ~/.sonata.
process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");

const { RuntimeController } = require("../../dist/main/runtime-controller");
// A bare controller has no Codex auto-updater: it never suppresses codex's own
// boot prompt, never waits on an update, never schedules a cycle.
const { INERT_CODEX_SPAWN_GATE } = require("../../dist/main/cli-updater/cli-updater");
const { INERT_CLI_READINESS_SOURCE } = require("../../dist/main/cli-readiness/session-start-diagnosis");
const { ProjectsStore } = require("../../dist/main/projects-store");
const {
  ResumeSettingsStore,
  ClaudeSettingsStore,
  CodexSettingsStore,
  SonataSettingsStore,
} = require("../../dist/main/settings-store");
const { projectRecordRoot } = require("../../dist/main/sonata-paths");
const { freshTaskManifestV1 } = require("../../dist/shared/schemas/task-manifest");
const { TaskNotFoundError, TaskNotLiveError } = require("../../dist/main/errors");

const failures = [];
const assert = (cond, label) => {
  if (!cond) failures.push(label);
};

// A dormant session: a valid persisted manifest on disk, with NO live runtime
// (the controller is fresh — taskRuntimes is empty).
const dormantId = "dormant-1";
const now = new Date().toISOString();
const dormantTask = {
  id: dormantId,
  title: "Dormant session",
  provider: "claude",
  model: null,
  reasoningEffort: null,
  speedMode: null,
  sandbox: null,
  approval: null,
  permissionMode: null,
  runtimeSessionId: null,
  providerSessionRef: null,
  providerCwd: path.join(tempRoot, "workspace"),
  workingDirectory: path.join(tempRoot, "workspace"),
  status: "idle",
  createdAt: now,
  updatedAt: now,
};
const recordRoot = projectRecordRoot(dormantId);
fs.mkdirSync(recordRoot, { recursive: true });
fs.writeFileSync(
  path.join(recordRoot, "task.json"),
  `${JSON.stringify(freshTaskManifestV1(dormantTask), null, 2)}\n`,
);

const controller = new RuntimeController({
  sendEvent: () => {},
  projectsStore: new ProjectsStore(path.join(tempRoot, "projects.json")),
  resumeSettingsStore: new ResumeSettingsStore(path.join(tempRoot, "resume-settings.json")),
  claudeSettingsStore: new ClaudeSettingsStore(path.join(tempRoot, "claude-settings.json")),
  codexSettingsStore: new CodexSettingsStore(path.join(tempRoot, "codex-settings.json")),
  sonataSettingsStore: new SonataSettingsStore(path.join(tempRoot, "sonata-settings.json")),
  cliUpdater: INERT_CODEX_SPAWN_GATE,
  cliReadiness: INERT_CLI_READINESS_SOURCE,
});

function caught(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

try {
  // 1. Dormant-but-persisted → TaskNotLiveError (the -32002 source).
  const dormantError = caught(() => controller.submitPrompt(dormantId, "wake up"));
  assert(
    dormantError instanceof TaskNotLiveError,
    "submitPrompt on a dormant task throws TaskNotLiveError",
  );

  // 2. Never existed → TaskNotFoundError, message unchanged from requireTaskRuntime
  //    (so the renderer's live-only path is byte-identical).
  const ghostError = caught(() => controller.submitPrompt("ghost-1", "anyone home"));
  assert(
    ghostError instanceof TaskNotLiveError === false && ghostError instanceof TaskNotFoundError,
    "submitPrompt on an unknown task throws TaskNotFoundError (not TaskNotLiveError)",
  );
  assert(
    ghostError?.message === "No runtime task matches the requested taskId.",
    "unknown-task message is unchanged",
  );

  // 3. A crafted taskId whose direct path RESOLVES onto a DIFFERENT task's
  //    record dir (projectRecordRoot is a bare path.join) but whose id is not
  //    that record's id. persistedSessionRecord must NOT accept the mismatched
  //    direct record — the id-equality guard falls through to the id-matched
  //    candidates scan, which finds nothing → TaskNotFoundError (-32001), never
  //    a false taskNotLive (-32002).
  const collidingId = `foo/../${dormantId}`; // path-joins to dormant-1's dir
  assert(
    projectRecordRoot(collidingId) === projectRecordRoot(dormantId),
    "crafted id genuinely resolves onto the real record dir (guard is exercised)",
  );
  const collisionError = caught(() => controller.submitPrompt(collidingId, "impersonate"));
  assert(
    collisionError instanceof TaskNotLiveError === false &&
      collisionError instanceof TaskNotFoundError,
    "a mismatched direct record is NOT taskNotLive — it is taskNotFound",
  );

  // 4. A plain traversal-shaped id pointing at nothing → TaskNotFoundError too.
  const traversalError = caught(() => controller.submitPrompt("../ghost-xyz", "escape"));
  assert(
    traversalError instanceof TaskNotLiveError === false &&
      traversalError instanceof TaskNotFoundError,
    "a traversal-shaped nonexistent id is taskNotFound, not taskNotLive",
  );

  // 5. openTask's LOOKUP FAILURES MUST STAY SYNCHRONOUS (regression, S2).
  //
  //    `openTask` became async when the Codex update mutex landed on the spawn
  //    path. The Local API's whole error contract is built on synchronous
  //    throws: `withTask` translates the typed classes to wire codes, and
  //    `executeCommand` caches only what `run()` RETURNS — so an async
  //    rejection is invisible to both. The consequence is nastier than a wrong
  //    code: a bad taskId answers `{accepted: true}` AND caches it, replaying
  //    `{accepted: true, deduped: true}` forever for a session that never
  //    opened. `resumeTaskInBackground` is the split that keeps validation on
  //    the caller's stack; these assertions are what make that non-negotiable.
  const ghostResume = caught(() => controller.resumeTaskInBackground("ghost-1"));
  assert(ghostResume !== null, "an unknown taskId throws SYNCHRONOUSLY, not as a rejected promise");
  assert(
    ghostResume instanceof Promise === false,
    "…and the throw is a throw, not a returned promise",
  );
  // With other tasks on disk, an unmatched id resolves onto the newest record
  // and fails the id-equality guard. To the caller that IS "task not found" —
  // the typed class maps it to -32001 on the wire (Woody ruled 2026-08-05;
  // the previous plain-Error → `internal` was a misclassification).
  assert(
    ghostResume instanceof TaskNotFoundError,
    `unmatched id throws TaskNotFoundError (-32001) (got: ${ghostResume?.name}: ${ghostResume?.message})`,
  );
  const traversalResume = caught(() => controller.resumeTaskInBackground("../ghost-xyz"));
  assert(traversalResume instanceof Error, "a traversal-shaped id throws synchronously too");

  // 6. …and with NO persisted task at all, the same call is the typed
  //    TaskNotFoundError the Local API maps to -32001.
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-local-api-empty-"));
  const emptyController = new RuntimeController({
    sendEvent: () => {},
    projectsStore: new ProjectsStore(path.join(emptyRoot, "projects.json")),
    resumeSettingsStore: new ResumeSettingsStore(path.join(emptyRoot, "resume.json")),
    claudeSettingsStore: new ClaudeSettingsStore(path.join(emptyRoot, "claude.json")),
    codexSettingsStore: new CodexSettingsStore(path.join(emptyRoot, "codex.json")),
    sonataSettingsStore: new SonataSettingsStore(path.join(emptyRoot, "sonata.json")),
    cliUpdater: INERT_CODEX_SPAWN_GATE,
    cliReadiness: INERT_CLI_READINESS_SOURCE,
  });
  try {
    process.env.SONATA_DATA_DIR = path.join(emptyRoot, "sonata-data");
    const noTasks = caught(() => emptyController.resumeTaskInBackground("ghost-1"));
    assert(
      noTasks instanceof TaskNotFoundError,
      `with nothing persisted, resume throws TaskNotFoundError (-32001) (got: ${noTasks?.name})`,
    );
  } finally {
    emptyController.dispose();
    process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");
    fs.rmSync(emptyRoot, { recursive: true, force: true, maxRetries: 5 });
  }
} finally {
  controller.dispose();
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
}

const success = failures.length === 0;
console.log(JSON.stringify({ success, failures }, null, 2));
if (success) {
  console.log("local-api-controller smoke: ok");
}
process.exitCode = success ? 0 : 1;
