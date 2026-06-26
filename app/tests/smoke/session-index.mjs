import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildSessionIndex } = require("../../dist/main/session-index");
const { ProjectsStore } = require("../../dist/main/projects-store");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "duet-session-index-smoke-"));
const storageRoot = path.join(root, "Duet Projects");
const userFolder = path.join(root, "my-project");
fs.mkdirSync(userFolder, { recursive: true });

function manifest(taskId, providerCwd, { title = taskId, archived, autoWorkspace, updatedAt } = {}) {
  return {
    schemaId: "duet.task-manifest.v1",
    version: 1,
    generatedAt: updatedAt,
    task: {
      id: taskId,
      title,
      provider: "claude",
      model: null,
      reasoningEffort: null,
      speedMode: null,
      sandbox: null,
      approval: null,
      permissionMode: "default",
      runtimeSessionId: `runtime-${taskId}`,
      providerSessionRef: null,
      providerCwd,
      workingDirectory: providerCwd,
      status: "idle",
      ...(archived !== undefined ? { archived } : {}),
      ...(autoWorkspace !== undefined ? { autoWorkspace } : {}),
      createdAt: updatedAt,
      updatedAt,
    },
    rawTerminalPolicy: "raw-terminal-not-persisted-by-default",
    runtimeReportPath: "runtime-report.json",
  };
}

function candidate(taskId, providerCwd, options = {}) {
  const sr = path.join(storageRoot, taskId);
  return {
    storageRoot: sr,
    manifest: manifest(taskId, providerCwd, options),
    mtimeMs: Date.parse(options.updatedAt),
  };
}

// A project-less chat now lives in a VISIBLE workspace (~/Documents/Duet/<…>),
// outside the record root — proving the explicit autoWorkspace flag, not the
// path, is what sorts it into Chats.
const chatsCwd = path.join(root, "Documents", "Duet", "2026-06-09-quick-chat");
const candidates = [
  candidate("task-1", userFolder, { title: "Older session", updatedAt: "2026-06-10T10:00:00.000Z" }),
  candidate("task-2", userFolder, { title: "Newer session", updatedAt: "2026-06-11T10:00:00.000Z" }),
  candidate("task-3", chatsCwd, {
    title: "Quick chat",
    autoWorkspace: true,
    updatedAt: "2026-06-09T10:00:00.000Z",
  }),
  candidate("task-4", userFolder, {
    title: "Archived session",
    archived: true,
    updatedAt: "2026-06-11T12:00:00.000Z",
  }),
];

const storePath = path.join(root, "projects.json");
const store = new ProjectsStore(storePath);
store.noteFolderUsed(userFolder);
store.setDisplayName(userFolder, "My Project");

const liveTasks = new Map([
  [
    "task-2",
    { ...candidates[1].manifest.task, status: "running", title: "Newer session (live)" },
  ],
]);

const index = buildSessionIndex({
  candidates,
  liveTasks,
  overlay: store.read(),
});

assert.equal(index.projects.length, 1, "one project derived from the user folder");
const project = index.projects[0];
assert.equal(project.name, "My Project", "overlay display name wins");
assert.equal(project.path, path.resolve(userFolder));
assert.equal(project.sessions.length, 2, "archived session excluded by default");
assert.deepEqual(
  project.sessions.map((s) => s.task.id),
  ["task-2", "task-1"],
  "project sessions newest first",
);
assert.equal(project.sessions[0].live, true, "live session marked live");
assert.equal(project.sessions[0].liveStatus, "running");
assert.equal(
  project.sessions[0].task.title,
  "Newer session (live)",
  "live task object wins over the disk manifest",
);
assert.equal(project.sessions[1].live, false);

assert.equal(index.chats.length, 1, "auto-workspace session lands in Chats");
assert.equal(index.chats[0].task.id, "task-3");
assert.equal(index.lastUsedFolder, userFolder, "lastUsedFolder follows noteFolderUsed");

const withArchived = buildSessionIndex({
  candidates,
  liveTasks,
  overlay: store.read(),
  includeArchived: true,
});
assert.equal(withArchived.projects[0].sessions.length, 3, "includeArchived shows everything");
assert.equal(
  withArchived.projects[0].sessions.filter((s) => s.archived).length,
  1,
  "archived flag surfaces on the summary",
);

const archivedProject = (() => {
  store.setArchived(userFolder, true);
  return buildSessionIndex({
    candidates,
    liveTasks,
    overlay: store.read(),
  });
})();
assert.equal(archivedProject.projects.length, 0, "archived project hidden by default");
assert.equal(archivedProject.lastUsedFolder, null, "archiving clears lastUsedFolder");

fs.rmSync(root, { recursive: true, force: true });
console.log("ok   session index derivation, overlay, archive semantics");
