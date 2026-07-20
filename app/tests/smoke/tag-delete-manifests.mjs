import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { planTagRemovalFromManifests } = require("../../dist/main/tag-manifests");
const { buildSessionIndex } = require("../../dist/main/session-index");

const removedId = "custom.remove-me";
const timestamp = "2030-01-15T17:00:00.000Z";

function task(id, tags) {
  const providerCwd = path.join("/tmp", "sonata-tag-smoke", id);
  return {
    id,
    title: id,
    provider: "claude",
    model: null,
    reasoningEffort: null,
    speedMode: null,
    codexPermissionMode: null,
    permissionMode: "default",
    runtimeSessionId: `runtime-${id}`,
    providerSessionRef: null,
    providerCwd,
    workingDirectory: providerCwd,
    status: "idle",
    autoWorkspace: true,
    ...(tags === undefined ? {} : { tags }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function candidate(id, tags) {
  return {
    storageRoot: path.join("/records", id),
    manifest: { task: task(id, tags) },
    mtimeMs: Date.parse(timestamp),
  };
}

const candidates = [
  candidate("dormant-with-keep", [removedId, "type.research"]),
  candidate("live", [removedId, "status.todo"]),
  candidate("untouched", ["priority.p1"]),
  candidate("dormant-only-removed", [removedId]),
];
const liveTasks = new Map([
  ["live", { ...candidates[1].manifest.task, tags: [removedId, "type.design"] }],
]);

const mutations = planTagRemovalFromManifests(candidates, liveTasks, removedId);
assert.equal(mutations.length, 3, "every tagged manifest is planned exactly once");
assert.equal(mutations.find((entry) => entry.task.id === "live").live, true);

const rewritten = new Map(mutations.map((entry) => [entry.storageRoot, entry.task]));
const finalCandidates = candidates.map((entry) => ({
  ...entry,
  manifest: { task: rewritten.get(entry.storageRoot) ?? entry.manifest.task },
}));
for (const entry of finalCandidates) {
  assert.ok(!entry.manifest.task.tags?.includes(removedId), `${entry.storageRoot} is stripped`);
  assert.equal(entry.manifest.task.updatedAt, timestamp, "tag deletion does not bump updatedAt");
}
assert.deepEqual(
  finalCandidates.find((entry) => entry.manifest.task.id === "live").manifest.task.tags,
  ["type.design"],
  "the live task is the freshest payload and is synchronized into its manifest",
);
assert.equal(
  "tags" in finalCandidates.find((entry) => entry.manifest.task.id === "dormant-only-removed").manifest.task,
  false,
  "removing the final tag restores the optional-field representation",
);

const index = buildSessionIndex({
  candidates: finalCandidates,
  liveTasks: new Map(),
  overlay: { version: 1, lastUsedFolder: null, folders: {} },
});
assert.deepEqual(
  index.chats.find((summary) => summary.task.id === "dormant-with-keep").task.tags,
  ["type.research"],
  "SessionSummary naturally carries Task.tags through the index",
);

console.log("ok   tag delete: strips all manifest plans, syncs live truth, preserves updatedAt");
