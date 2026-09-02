import assert from "node:assert/strict";
import { createRequire } from "node:module";

// CliStateModel is pure logic — require it directly (no node-pty via the barrel).
const require = createRequire(import.meta.url);
const { CliStateModel } = require("../../dist/runtime/cli-signal/cli-state");

let tick = 0;
const clock = () => `t${tick++}`;

function newModel() {
  const changes = [];
  const model = new CliStateModel((snapshot) => changes.push({ ...snapshot }), clock);
  return { model, changes };
}

// 1) Initial state is idle.
{
  const { model } = newModel();
  assert.equal(model.current().activity, "idle", "starts idle");
}

// 2) Hooks-only turn: UserPromptSubmit→busy, PreToolUse(+tool), Stop→turn-ended.
{
  const { model, changes } = newModel();
  model.applyHook({ hook_event_name: "UserPromptSubmit" });
  assert.equal(model.current().activity, "busy", "UserPromptSubmit → busy");
  model.applyHook({ hook_event_name: "PreToolUse", tool_name: "Bash" });
  assert.equal(model.current().activity, "busy");
  assert.equal(model.current().tool, "Bash", "PreToolUse names the tool");
  model.applyHook({ hook_event_name: "PermissionRequest", tool_name: "Bash" });
  assert.equal(model.current().activity, "waiting-approval", "PermissionRequest → waiting-approval");
  assert.equal(model.current().tool, "Bash");
  model.applyHook({ hook_event_name: "PostToolUse", tool_name: "Bash" });
  assert.equal(model.current().activity, "busy", "PostToolUse → busy (back in turn)");
  assert.equal(model.current().tool, null, "PostToolUse clears the tool");
  model.applyHook({ hook_event_name: "Stop" });
  assert.equal(model.current().activity, "turn-ended", "Stop → turn-ended");
  assert.ok(changes.length >= 5, "each meaningful transition emitted");
}

// 2b) A FAILED turn (API error) ends via StopFailure — Stop never fires
// (probed S6, s6-diags/stopfailure-probe); busy must not linger.
{
  const { model } = newModel();
  model.applyHook({ hook_event_name: "UserPromptSubmit" });
  model.applyHook({ hook_event_name: "StopFailure", error: "model_not_found" });
  assert.equal(model.current().activity, "turn-ended", "StopFailure → turn-ended");
}

// 2c) An INTERRUPTED turn (codex) ends via Interrupt — Stop never fires for it
// either (SL-9, MEASURED at codex 0.152.1: the hook lands ~140ms after the
// interrupt and no Stop follows). Same requirement as 2b: busy must not linger
// until the `task:ready` quiescence net catches up. The model is deliberately
// provider-agnostic, so this asserts the transition, not a provider gate.
{
  const { model } = newModel();
  model.applyHook({ hook_event_name: "UserPromptSubmit" });
  model.applyHook({ hook_event_name: "PreToolUse", tool_name: "shell" });
  assert.equal(model.current().activity, "busy", "the interrupted turn was busy");
  model.applyHook({ hook_event_name: "Interrupt", turn_id: "t-1", model: "gpt-5.6-sol" });
  assert.equal(model.current().activity, "turn-ended", "Interrupt → turn-ended");
  assert.equal(model.current().tool, null, "Interrupt clears the tool");
  assert.equal(model.current().source, "hook:Interrupt", "the transition names its source");
}

// 2d) `PostModelSwitch` (claude, INJECTED since D2 U3) is a VERIFIED no-op here.
// Adding an event to the production injection list adds a payload this model sees
// on every mid-session model switch, so "it falls through the default branch" is
// a claim that has to be pinned rather than assumed. Two directions, because a
// no-op has two ways to be wrong: it must not move an IDLE composer (a switch
// happens at idle by construction — the engine refuses to start one while a run
// is live), and it must not end a turn that is genuinely running.
{
  const { model, changes } = newModel();
  const before = changes.length;
  model.applyHook({
    hook_event_name: "PostModelSwitch",
    requested_model: "haiku",
    to_model: "claude-haiku-4-5-20251001",
    from_model: "claude-fable-5-1",
    source: "command",
  });
  assert.equal(model.current().activity, "idle", "PostModelSwitch leaves an idle session idle");
  assert.equal(changes.length, before, "…and emits no change at all");

  model.applyHook({ hook_event_name: "UserPromptSubmit" });
  assert.equal(model.current().activity, "busy", "a turn is running");
  const duringTurn = changes.length;
  model.applyHook({ hook_event_name: "PostModelSwitch", requested_model: "sonnet" });
  assert.equal(model.current().activity, "busy", "…and PostModelSwitch does not end it");
  assert.equal(changes.length, duringTurn, "…nor emit");
  assert.equal(model.current().source, "hook:UserPromptSubmit", "the last mover is still the turn start");
}

// 3) Idempotency: re-applying the same activity does not emit.
{
  const { model, changes } = newModel();
  model.applyHook({ hook_event_name: "UserPromptSubmit" });
  const after = changes.length;
  model.applyHook({ hook_event_name: "UserPromptSubmit" });
  model.applyRuntimeEvent({ type: "prompt:submitted", payload: {}, ts: "" });
  assert.equal(changes.length, after, "no spurious change for an unchanged state");
}

// 4) Safety net (hooks absent): runtime events alone reproduce today's behavior.
{
  const { model } = newModel();
  model.applyRuntimeEvent({ type: "prompt:submitted", payload: {}, ts: "" });
  assert.equal(model.current().activity, "busy", "prompt:submitted → busy");
  model.applyRuntimeEvent({ type: "approval:detected", payload: { kind: "command" }, ts: "" });
  assert.equal(model.current().activity, "waiting-approval", "approval:detected → waiting-approval");
  assert.equal(model.current().approvalKind, "command", "carries the scraped kind");
  model.applyRuntimeEvent({ type: "approval:decision", payload: { decision: "approve" }, ts: "" });
  assert.equal(model.current().activity, "busy", "approval:decision → busy");
  assert.equal(model.current().approvalKind, null, "decision clears the approval kind");
  model.applyRuntimeEvent({ type: "task:ready", payload: {}, ts: "" });
  assert.equal(model.current().activity, "turn-ended", "task:ready ends a busy turn (Stop-hook fallback)");
}

// 5) task:ready must NOT downgrade a fresh idle (cold-start guard).
{
  const { model, changes } = newModel();
  const before = changes.length;
  model.applyRuntimeEvent({ type: "task:ready", payload: {}, ts: "" });
  assert.equal(model.current().activity, "idle", "task:ready while idle stays idle");
  assert.equal(changes.length, before, "no change emitted");
}

// 6) Notification forward-compat mapping (absent on 2.1.177, but typed for the future).
{
  const { model } = newModel();
  model.applyHook({ hook_event_name: "Notification", notification_type: "permission_prompt", tool_name: "Edit" });
  assert.equal(model.current().activity, "waiting-approval", "Notification(permission_prompt) → waiting-approval");
  model.applyHook({ hook_event_name: "Notification", notification_type: "idle_prompt" });
  assert.equal(model.current().activity, "turn-ended", "Notification(idle_prompt) → turn-ended");
}

// 7) pty:exit returns to idle.
{
  const { model } = newModel();
  model.applyHook({ hook_event_name: "UserPromptSubmit" });
  model.applyRuntimeEvent({ type: "pty:exit", payload: {}, ts: "" });
  assert.equal(model.current().activity, "idle", "pty:exit → idle");
}

console.log("cli-signal-state smoke: OK");
