import assert from "node:assert/strict";

const {
  isCliActionRequest,
  isTerminalActiveTaskState,
} = await import("../../dist/shared/types/ipc.js");

const fresh = {
  taskId: null,
  live: false,
  openTaskIds: [],
  projectName: "Tasks",
  sessionTitle: "New task",
  emptySurface: { kind: "fresh", phase: "ready" },
};
const dormant = {
  taskId: "task-1",
  live: false,
  openTaskIds: ["task-1"],
  projectName: "Duet",
  sessionTitle: "Review lifecycle",
  emptySurface: { kind: "dormant", phase: "ready", taskId: "task-1" },
};
const live = {
  ...dormant,
  live: true,
  emptySurface: { kind: "none" },
};

assert.equal(isCliActionRequest({ action: "start", expectedTaskId: null }), true);
assert.equal(isCliActionRequest({ action: "resume", expectedTaskId: "task-1" }), true);
assert.equal(isCliActionRequest({ action: "start", expectedTaskId: "task-1" }), false);
assert.equal(isCliActionRequest({ action: "resume", expectedTaskId: null }), false);
assert.equal(
  isCliActionRequest({ action: "resume", expectedTaskId: "task-1", extra: true }),
  false,
);

assert.equal(isTerminalActiveTaskState(fresh), true);
assert.equal(isTerminalActiveTaskState(dormant), true);
assert.equal(isTerminalActiveTaskState(live), true);
assert.equal(isTerminalActiveTaskState({ ...fresh, live: true }), false);
assert.equal(
  isTerminalActiveTaskState({ ...dormant, emptySurface: { kind: "none" } }),
  false,
);
assert.equal(
  isTerminalActiveTaskState({
    ...dormant,
    emptySurface: { kind: "dormant", phase: "ready", taskId: "task-2" },
  }),
  false,
);
assert.equal(isTerminalActiveTaskState({ ...dormant, openTaskIds: [] }), false);
assert.equal(
  isTerminalActiveTaskState({ ...fresh, openTaskIds: ["task-1", "task-1"] }),
  false,
);

console.log(JSON.stringify({ success: true }, null, 2));
