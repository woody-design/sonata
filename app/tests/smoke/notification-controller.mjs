import assert from "node:assert/strict";
import { createRequire } from "node:module";

// The controller imports `electron`, but only touches it inside the DEFAULT
// notifier — which we replace with a fake here — so this runs under plain node.
const require = createRequire(import.meta.url);
const { NotificationController } = require("../../dist/main/notification-controller");

const T0 = Date.parse("2026-07-03T10:00:00.000Z");
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const cli = (taskId, activity, sec) => ({
  type: "cli-state:changed",
  payload: { taskId, activity },
  ts: at(sec),
});
const approval = (taskId, extra = {}) => ({
  type: "approval:detected",
  payload: { taskId, ...extra },
  ts: at(0),
});
const runStarted = (taskId, title) => ({ type: "run:started", payload: { taskId, title }, ts: at(0) });
const taskUpdated = (taskId, title) => ({
  type: "task:updated",
  payload: { taskId, task: { id: taskId, title }, reason: "runtime-status" },
  ts: at(0),
});

function harness() {
  const shown = [];
  const activated = [];
  const handles = [];
  const notifier = (content) => {
    const handle = {
      content,
      clickCbs: [],
      closeCbs: [],
      shown: false,
      show() {
        this.shown = true;
        shown.push(content);
      },
      onClick(cb) {
        this.clickCbs.push(cb);
      },
      onClose(cb) {
        this.closeCbs.push(cb);
      },
      click() {
        this.clickCbs.forEach((cb) => cb());
      },
    };
    handles.push(handle);
    return handle;
  };
  const controller = new NotificationController({
    notifier,
    activateTask: (taskId) => activated.push(taskId),
  });
  return { controller, shown, activated, handles };
}

// 1) A completed turn shows "<task title> / Claude finished".
{
  const h = harness();
  h.controller.handleEvent(taskUpdated("t1", "Notification feature"));
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.controller.handleEvent(cli("t1", "turn-ended", 45));
  assert.equal(h.shown.length, 1, "one notification shown");
  assert.deepEqual(
    h.shown[0],
    { title: "Notification feature", body: "Claude finished" },
    "task title as title, Claude Code-style body",
  );
}

// 2) A needs-you shows the approval copy.
{
  const h = harness();
  h.controller.handleEvent(taskUpdated("t1", "Fix the parser"));
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.controller.handleEvent(approval("t1", { approvalId: "a1" }));
  assert.deepEqual(h.shown[0], { title: "Fix the parser", body: "Claude needs your input" });
}

// 3) Clicking routes to the task, once (ref dropped on click).
{
  const h = harness();
  h.controller.handleEvent(taskUpdated("t1", "Fix the parser"));
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.controller.handleEvent(cli("t1", "turn-ended", 45));
  h.handles[0].click();
  assert.deepEqual(h.activated, ["t1"], "click activates the notification's task");
}

// 4) The user-editable session name wins over a run title.
{
  const h = harness();
  h.controller.handleEvent(runStarted("t1", "run-derived title"));
  h.controller.handleEvent(taskUpdated("t1", "Human name"));
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.controller.handleEvent(cli("t1", "turn-ended", 45));
  assert.equal(h.shown[0].title, "Human name", "task:updated title beats run:started");
}

// 5) Auto-title placeholders never surface — fall back to the app name.
{
  const h = harness();
  h.controller.handleEvent(taskUpdated("t1", "New Task"));
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.controller.handleEvent(cli("t1", "turn-ended", 45));
  assert.equal(h.shown[0].title, "Duet", "placeholder title → fallback");
}

// 6) A sub-floor turn shows nothing (policy wired through).
{
  const h = harness();
  h.controller.handleEvent(taskUpdated("t1", "Fix the parser"));
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.controller.handleEvent(cli("t1", "turn-ended", 5));
  assert.equal(h.shown.length, 0, "fast turn → no notification");
}

// 7) A null notifier (OS can't show) is handled without throwing.
{
  const controller = new NotificationController({
    notifier: () => null,
    activateTask: () => {},
  });
  controller.handleEvent(cli("t1", "busy", 0));
  controller.handleEvent(cli("t1", "turn-ended", 45));
  // no throw = pass
}

console.log("notification-controller smoke: OK");
