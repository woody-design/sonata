// Slice 4 main-process fence. Runs under Electron-as-Node because the real
// RuntimeController imports Electron. It proves live rename is persist-first,
// dormant/project results are canonical, and failed atomic writes publish no
// in-memory/event success.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-rename-persistence-"));
process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");
const require = createRequire(import.meta.url);
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

const projectsPath = path.join(tempRoot, "settings", "projects.json");
const projectsStore = new ProjectsStore(projectsPath);
const events = [];
const controller = new RuntimeController({
  sendEvent: (event) => events.push(event),
  projectsStore,
  resumeSettingsStore: new ResumeSettingsStore(path.join(tempRoot, "settings", "resume.json")),
  claudeSettingsStore: new ClaudeSettingsStore(path.join(tempRoot, "settings", "claude.json")),
  codexSettingsStore: new CodexSettingsStore(path.join(tempRoot, "settings", "codex.json")),
  sonataSettingsStore: new SonataSettingsStore(path.join(tempRoot, "settings", "sonata.json")),
  cliUpdater: INERT_CODEX_SPAWN_GATE,
  cliReadiness: INERT_CLI_READINESS_SOURCE,
});

function makeTask(id, title, providerCwd = path.join(tempRoot, "workspace")) {
  const now = "2030-01-15T17:00:00.000Z";
  return {
    id,
    title,
    provider: "claude",
    model: null,
    reasoningEffort: null,
    speedMode: null,
    sandbox: null,
    approval: null,
    permissionMode: null,
    runtimeSessionId: `runtime-${id}`,
    providerSessionRef: null,
    providerCwd,
    workingDirectory: providerCwd,
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

function writeManifest(storageRoot, task) {
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(storageRoot, "task.json"),
    `${JSON.stringify(freshTaskManifestV1(task), null, 2)}\n`,
  );
}

function readTask(storageRoot) {
  return JSON.parse(fs.readFileSync(path.join(storageRoot, "task.json"), "utf8")).task;
}

function blockAtomicTarget(filePath) {
  const blocker = `${filePath}.tmp`;
  fs.rmSync(blocker, { recursive: true, force: true });
  fs.mkdirSync(blocker, { recursive: false });
  return () => fs.rmSync(blocker, { recursive: true, force: true });
}

function caught(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

try {
  // 1) Inject only the fields renameSession reads from a live runtime. The
  // test removes this seam before controller.dispose(), so no fake runtime is
  // ever sent through terminal teardown.
  const liveTask = makeTask("live-rename", "Live original");
  const liveRoot = projectRecordRoot(liveTask.id);
  writeManifest(liveRoot, liveTask);
  controller.taskRuntimes.set(liveTask.id, { task: liveTask, storageRoot: liveRoot });
  const restoreLiveWrites = blockAtomicTarget(path.join(liveRoot, "task.json"));
  const eventsBeforeFailure = events.length;
  const liveFailure = caught(() => controller.renameSession(liveTask.id, "Must not leak"));
  assert.ok(liveFailure instanceof Error, "blocked live manifest write rejects rename");
  assert.equal(controller.taskRuntimes.get(liveTask.id).task.title, "Live original");
  assert.equal(readTask(liveRoot).title, "Live original");
  assert.equal(readTask(liveRoot).titleOrigin, undefined, "failed rename does not leak ownership");
  assert.equal(events.length, eventsBeforeFailure, "failed live rename emits no success event");

  restoreLiveWrites();
  const liveResponse = controller.renameSession(liveTask.id, "  Live canonical  ");
  assert.equal(liveResponse.task.title, "Live canonical");
  assert.equal(controller.taskRuntimes.get(liveTask.id).task.title, "Live canonical");
  assert.equal(readTask(liveRoot).title, "Live canonical");
  assert.equal(readTask(liveRoot).titleOrigin, "user", "successful live rename persists ownership");
  assert.deepEqual(
    events.slice(-2).map((event) => [event.type, event.payload.reason]),
    [
      ["sessions:updated", "session-renamed"],
      ["task:updated", "session-renamed"],
    ],
    "live success publishes index then canonical task update",
  );
  controller.taskRuntimes.delete(liveTask.id);

  // 2) Dormant rename returns the persisted canonical task and never needs a
  // live task:updated event.
  const dormantTask = makeTask("dormant-rename", "Dormant original");
  const dormantRoot = projectRecordRoot(dormantTask.id);
  writeManifest(dormantRoot, dormantTask);
  const dormantEventStart = events.length;
  const dormantResponse = controller.renameSession(dormantTask.id, " Dormant canonical ");
  assert.equal(dormantResponse.task.title, "Dormant canonical");
  assert.equal(readTask(dormantRoot).title, "Dormant canonical");
  assert.equal(readTask(dormantRoot).titleOrigin, "user", "dormant rename persists ownership");
  assert.deepEqual(
    events.slice(dormantEventStart).map((event) => [event.type, event.payload.reason]),
    [["sessions:updated", "session-renamed"]],
  );

  // 3) Project overlay uses its existing tmp+rename write. Failure retains the
  // prior file and emits nothing; success returns both override and rendered
  // name, with null canonically falling back to basename.
  const projectPath = path.join(tempRoot, "workspaces", "alpha-folder");
  projectsStore.setDisplayName(projectPath, "Alpha");
  const restoreProjectWrites = blockAtomicTarget(projectsPath);
  const projectEventStart = events.length;
  const projectFailure = caught(() => controller.renameProject(projectPath, "Must not leak"));
  assert.ok(projectFailure instanceof Error, "blocked project overlay write rejects rename");
  assert.equal(projectsStore.read().folders[projectPath].displayName, "Alpha");
  assert.equal(events.length, projectEventStart, "failed project rename emits no update");

  restoreProjectWrites();
  const projectResponse = controller.renameProject(projectPath, "  Beta  ");
  assert.deepEqual(projectResponse, {
    path: path.resolve(projectPath),
    displayName: "Beta",
    name: "Beta",
  });
  assert.equal(projectsStore.read().folders[projectPath].displayName, "Beta");
  assert.equal(events.at(-1).payload.reason, "project-updated");

  const resetResponse = controller.renameProject(projectPath, null);
  assert.equal(resetResponse.displayName, null);
  assert.equal(resetResponse.name, "alpha-folder");
  assert.equal(projectsStore.read().folders[projectPath].displayName, undefined);
} finally {
  controller.taskRuntimes.delete("live-rename");
  controller.dispose();
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
}

console.log("sidebar-rename-persistence: live/dormant/project atomicity passes");
