import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Subtraction X1 fix round F1 — the codex permission badge AND the persisted
// task value follow the LATEST live `turn_context`. With the mid-session drives
// gone, a switch made in the Terminal (`/permissions`) is the only kind there
// is, and the rollout is the only file that records it. This pins the chain the
// controller rides: rollout line → CodexRolloutNormalizer (extracts sandbox,
// approval AND reviewer) → codexPermissionModeFromTurnContext → TaskMirror
// persist (the value a reopen spawns from).
//
// PROVENANCE, per record:
//  - Q42 (codex-cli 0.156.1) — spikes/upstream-sync-2026-09/codex/
//    q42-0156-permission-rollout-signal.capture.txt: the turn after a
//    TERMINAL-side `/permissions` switch to "Approve for me". The three consumed
//    axes and the payload KEY SET are MEASURED; the values of the keys Sonata
//    does not read (ids, cwd, dates, profiles) are COMPOSED placeholders — the
//    capture recorded only their names.
//  - Q35 (codex-cli 0.152.1) — q35-read-only-mode.turn-contexts.capture.txt:
//    turn 1 (spawned Ask for approval) and turn 3 (after a switch to Approve for
//    me). Consumed axes MEASURED; the record is TRIMMED to them (ADAPTED).
//  - R5 (codex-cli 0.152.0) — r5-permission-mode-drive.capture.txt: the Full
//    Access spawn's projection, axes MEASURED (ADAPTED — trimmed).
const require = createRequire(import.meta.url);
const { CodexRolloutNormalizer } = require("../../dist/runtime/provider-transcript/index");
const { codexPermissionModeFromTurnContext } = require("../../dist/shared/types/codex-settings");
const { TaskMirror } = require("../../dist/main/task-mirror");
// The REAL controller reconcile (runtime-controller `reconcileCodexTurnContext`).
// Loaded under ELECTRON_RUN_AS_NODE (the module imports `electron`); called on a
// minimal receiver carrying only the TaskMirror it writes through, so dropping
// the reviewer pass-through at the call site fails here.
const { RuntimeController } = require("../../dist/main/runtime-controller");

const line = (payload) =>
  JSON.stringify({ timestamp: "2026-09-23T14:50:00.000Z", type: "turn_context", payload });

const Q42_APPROVE_FOR_ME = line({
  turn_id: "composed-turn",
  root_turn_id: "composed-root",
  disabled_plugin_ids: [],
  cwd: "/tmp/composed",
  workspace_roots: ["/tmp/composed"],
  current_date: "2026-09-23",
  timezone: "UTC",
  approval_policy: "on-request", // MEASURED
  approvals_reviewer: "auto_review", // MEASURED
  sandbox_policy: { type: "workspace-write" }, // MEASURED (type)
  permission_profile: { type: "managed" },
  active_permission_profile: null,
});
const Q35_ASK = line({
  approval_policy: "on-request",
  approvals_reviewer: "user",
  sandbox_policy: { type: "workspace-write", network_access: false },
});
const Q35_APPROVE_FOR_ME = line({
  approval_policy: "on-request",
  approvals_reviewer: "auto_review",
  sandbox_policy: { type: "workspace-write", network_access: false },
});
const R5_FULL_ACCESS = line({
  approval_policy: "never",
  approvals_reviewer: "user",
  sandbox_policy: { type: "danger-full-access" },
});

function observe(rolloutLine) {
  const contexts = [];
  const normalizer = new CodexRolloutNormalizer({
    taskId: "task-1",
    sourceId: "codex:s1",
    onTurnContext: (context) => contexts.push(context),
  });
  normalizer.consumeLine(rolloutLine);
  assert.equal(contexts.length, 1, "one turn_context → one observation");
  return contexts[0];
}

const modeOf = (context) =>
  codexPermissionModeFromTurnContext(
    context.sandboxPolicy,
    context.approvalPolicy,
    context.approvalsReviewer,
  );

// 1) The normalizer passes the reviewer through (it used to drop it).
const q42 = observe(Q42_APPROVE_FOR_ME);
assert.equal(q42.approvalsReviewer, "auto_review", "approvals_reviewer reaches the observation");
assert.equal(q42.sandboxPolicy, "workspace-write");
assert.equal(q42.approvalPolicy, "on-request");

// 2) Every measured shape maps to a definite mode.
assert.equal(modeOf(q42), "approve-for-me", "Q42 0.156.1: a Terminal switch to Approve for me");
assert.equal(modeOf(observe(Q35_APPROVE_FOR_ME)), "approve-for-me", "Q35 turn 3 (0.152.1)");
assert.equal(modeOf(observe(Q35_ASK)), "ask-for-approval", "Q35 turn 1 (0.152.1)");
assert.equal(modeOf(observe(R5_FULL_ACCESS)), "full-access", "R5 full access (0.152.0)");

// 3) The persisted value follows the observation — the controller's write is
// TaskMirror.apply(reconciled ?? current), and TaskMirror persists the
// manifest a reopen spawns from. A downgrade out of Full Access made in the
// Terminal must land in the persisted task, or the next reopen re-grants it.
{
  const persisted = [];
  const mirror = new TaskMirror(
    (task) => persisted.push(task.codexPermissionMode),
    () => {},
  );
  const target = {
    task: { id: "task-1", provider: "codex", codexPermissionMode: "full-access" },
    storageRoot: "/tmp/unused",
  };
  const reconcile = (rolloutLine) => {
    const next = modeOf(observe(rolloutLine)) ?? target.task.codexPermissionMode;
    mirror.apply(target, { codexPermissionMode: next });
  };
  reconcile(Q35_ASK);
  assert.equal(target.task.codexPermissionMode, "ask-for-approval", "Full Access → Ask reconciles");
  assert.deepEqual(persisted, ["ask-for-approval"], "…and is persisted for the next reopen");
  reconcile(Q42_APPROVE_FOR_ME);
  assert.deepEqual(persisted, ["ask-for-approval", "approve-for-me"], "Ask → Approve persists too");
  reconcile(Q42_APPROVE_FOR_ME);
  assert.equal(persisted.length, 2, "an unchanged observation writes nothing");
}

// 4) The controller's own reconcile, fed an observation exactly as the
// `codex-turn-context:observed` dispatch hands it over.
{
  const persisted = [];
  const receiver = {
    taskMirror: new TaskMirror(
      (task) => persisted.push(task.codexPermissionMode),
      () => {},
    ),
  };
  const active = {
    task: {
      id: "task-1",
      provider: "codex",
      model: "gpt-6-astra",
      reasoningEffort: "high",
      codexPermissionMode: "ask-for-approval",
    },
    storageRoot: "/tmp/unused",
  };
  const reconcile = (observation) =>
    RuntimeController.prototype.reconcileCodexTurnContext.call(receiver, active, observation);
  reconcile(q42);
  assert.equal(
    active.task.codexPermissionMode,
    "approve-for-me",
    "the controller reconcile reads the reviewer (Q42 → approve-for-me)",
  );
  assert.deepEqual(persisted, ["approve-for-me"], "…and persists it for the next reopen");
  reconcile({ ...q42, approvalsReviewer: null });
  assert.equal(
    active.task.codexPermissionMode,
    "approve-for-me",
    "a missing reviewer keeps the current value (unmeasured shape, never a guess)",
  );
  assert.equal(persisted.length, 1, "…and writes nothing");
}

console.log("codex-permission-turn-context: all checks passed");
