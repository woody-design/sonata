import assert from "node:assert/strict";
import { createRequire } from "node:module";

// NotificationPolicy is pure logic — require the built module directly (no
// Electron, no node-pty).
const require = createRequire(import.meta.url);
const { NotificationPolicy } = require("../../dist/main/notification-policy");

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
const option = (taskId, toolUseId) => ({
  type: "option-prompt:detected",
  payload: { taskId, toolUseId },
  ts: at(0),
});

// 1) A turn longer than the floor → complete.
{
  const p = new NotificationPolicy();
  assert.equal(p.observe(cli("t1", "busy", 0)), null, "busy start does not notify");
  const d = p.observe(cli("t1", "turn-ended", 45));
  assert.ok(d && d.kind === "complete" && d.taskId === "t1", "long turn → complete");
}

// 2) A fast turn stays silent — you were still watching.
{
  const p = new NotificationPolicy();
  p.observe(cli("t1", "busy", 0));
  assert.equal(p.observe(cli("t1", "turn-ended", 5)), null, "sub-floor turn → no complete");
}

// 3) turn-ended with no observed start (resume/boot) never fires.
{
  const p = new NotificationPolicy();
  assert.equal(p.observe(cli("t1", "turn-ended", 300)), null, "unseen turn start → no complete");
}

// 4) A re-emitted turn-ended does not double-fire.
{
  const p = new NotificationPolicy();
  p.observe(cli("t1", "busy", 0));
  assert.ok(p.observe(cli("t1", "turn-ended", 45)), "first turn-ended fires");
  assert.equal(p.observe(cli("t1", "turn-ended", 46)), null, "re-emitted turn-ended stays silent");
}

// 5) A mid-turn approval fires needs-you AND does not reset the turn clock.
{
  const p = new NotificationPolicy();
  p.observe(cli("t1", "busy", 0));
  const a = p.observe(approval("t1", { approvalId: "a1" }));
  assert.ok(a && a.kind === "needs-you" && a.reason === "approval", "approval → needs-you");
  p.observe(cli("t1", "waiting-approval", 10));
  p.observe(cli("t1", "busy", 20)); // resume after answering — same turn
  const d = p.observe(cli("t1", "turn-ended", 35)); // 35s from the ORIGINAL busy
  assert.ok(d && d.kind === "complete", "resume-after-approval keeps the original clock");
}

// 6) Approvals dedup by id within a turn.
{
  const p = new NotificationPolicy();
  p.observe(cli("t1", "busy", 0));
  assert.ok(p.observe(approval("t1", { approvalId: "a1" })), "first approval fires");
  assert.equal(p.observe(approval("t1", { approvalId: "a1" })), null, "same approval id deduped");
}

// 7) A resurfaced approval (broker timeout re-render) is not a new demand.
{
  const p = new NotificationPolicy();
  p.observe(cli("t1", "busy", 0));
  assert.equal(
    p.observe(approval("t1", { approvalId: "a2", resurfacedAfterDecision: true })),
    null,
    "resurfaced approval → silent",
  );
}

// 8) An AskUserQuestion (option-prompt) fires needs-you, deduped by toolUseId.
{
  const p = new NotificationPolicy();
  p.observe(cli("t1", "busy", 0));
  const d = p.observe(option("t1", "tu1"));
  assert.ok(d && d.kind === "needs-you" && d.reason === "option-prompt", "option-prompt → needs-you");
  assert.equal(p.observe(option("t1", "tu1")), null, "same toolUseId deduped");
}

// 9) The ask-dedup set clears on a fresh turn.
{
  const p = new NotificationPolicy();
  p.observe(cli("t1", "busy", 0));
  assert.ok(p.observe(approval("t1", { approvalId: "a1" })), "approval fires in turn 1");
  p.observe(cli("t1", "turn-ended", 45));
  p.observe(cli("t1", "busy", 60)); // turn 2 → clears notified asks
  assert.ok(p.observe(approval("t1", { approvalId: "a1" })), "same id re-fires in a new turn");
}

// 10) Tasks are independent.
{
  const p = new NotificationPolicy();
  p.observe(cli("t1", "busy", 0));
  p.observe(cli("t2", "busy", 0));
  assert.ok(p.observe(cli("t1", "turn-ended", 45)), "t1 completes");
  assert.equal(p.observe(cli("t2", "turn-ended", 5)), null, "t2's fast turn is independent");
}

// 11) The floor is configurable.
{
  const p = new NotificationPolicy({ completeFloorMs: 1000 });
  p.observe(cli("t1", "busy", 0));
  assert.ok(p.observe(cli("t1", "turn-ended", 2)), "2s turn fires under a 1s floor");
}

console.log("notification-policy smoke: OK");
