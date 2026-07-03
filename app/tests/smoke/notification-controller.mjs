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

function harness() {
  const shown = [];
  const activated = [];
  const handles = [];
  const meta = new Map(); // taskId → { title, provider }
  const notifier = (content) => {
    const handle = {
      content,
      clickCbs: [],
      show() {
        shown.push(content);
      },
      onClick(cb) {
        this.clickCbs.push(cb);
      },
      onClose() {},
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
    resolveTaskMeta: (taskId) => meta.get(taskId) ?? null,
  });
  return { controller, shown, activated, handles, meta };
}

// 1) A completed Claude turn: "<task title> / Claude finished".
{
  const h = harness();
  h.meta.set("t1", { title: "Notification feature", provider: "claude" });
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.controller.handleEvent(cli("t1", "turn-ended", 45));
  assert.equal(h.shown.length, 1, "one notification shown");
  assert.deepEqual(h.shown[0], { title: "Notification feature", body: "Claude finished" });
}

// 2) A needs-you shows the request copy.
{
  const h = harness();
  h.meta.set("t1", { title: "Fix the parser", provider: "claude" });
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.controller.handleEvent(approval("t1", { approvalId: "a1" }));
  assert.deepEqual(h.shown[0], { title: "Fix the parser", body: "Claude needs your input" });
}

// 3) Codex copy — provider-aware, never "Claude" (P2a).
{
  const h = harness();
  h.meta.set("t1", { title: "Port the CLI", provider: "codex" });
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.controller.handleEvent(cli("t1", "turn-ended", 45));
  assert.deepEqual(h.shown[0], { title: "Port the CLI", body: "Codex finished" });
}

// 4) Clicking routes to the task, once.
{
  const h = harness();
  h.meta.set("t1", { title: "Fix the parser", provider: "claude" });
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.controller.handleEvent(cli("t1", "turn-ended", 45));
  h.handles[0].click();
  assert.deepEqual(h.activated, ["t1"], "click activates the notification's task");
}

// 5) The name is read at FIRE time — a rename after the turn started still wins
//    (the whole reason we pull from the registry, not from event inference).
{
  const h = harness();
  h.meta.set("t1", { title: "old name", provider: "claude" });
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.meta.set("t1", { title: "renamed", provider: "claude" }); // renamed mid-turn
  h.controller.handleEvent(cli("t1", "turn-ended", 45));
  assert.equal(h.shown[0].title, "renamed", "title resolved at fire time");
}

// 6) Placeholder title never surfaces — fall back to the app name.
{
  const h = harness();
  h.meta.set("t1", { title: "New Task", provider: "claude" });
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.controller.handleEvent(cli("t1", "turn-ended", 45));
  assert.equal(h.shown[0].title, "Duet", "placeholder title → fallback");
}

// 7) No live meta → neutral copy, no crash.
{
  const h = harness(); // meta map empty → resolveTaskMeta returns null
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.controller.handleEvent(cli("t1", "turn-ended", 45));
  assert.deepEqual(h.shown[0], { title: "Duet", body: "Agent finished" });
}

// 8) A sub-floor turn shows nothing (policy wired through).
{
  const h = harness();
  h.meta.set("t1", { title: "Fix the parser", provider: "claude" });
  h.controller.handleEvent(cli("t1", "busy", 0));
  h.controller.handleEvent(cli("t1", "turn-ended", 5));
  assert.equal(h.shown.length, 0, "fast turn → no notification");
}

// 9) A null notifier (OS can't show) is handled without throwing.
{
  const controller = new NotificationController({
    notifier: () => null,
    activateTask: () => {},
    resolveTaskMeta: () => null,
  });
  controller.handleEvent(cli("t1", "busy", 0));
  controller.handleEvent(cli("t1", "turn-ended", 45));
  // no throw = pass
}

console.log("notification-controller smoke: OK");
