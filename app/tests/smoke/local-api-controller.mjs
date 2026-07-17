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
const { ProjectsStore } = require("../../dist/main/projects-store");
const {
  ResumeSettingsStore,
  ClaudeSettingsStore,
  CodexSettingsStore,
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
