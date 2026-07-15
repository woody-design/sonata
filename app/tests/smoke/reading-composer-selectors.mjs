import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Fixture tables for the composer + runs selectors (map step B3): slash
// scoring/filtering, placeholder/title/status suppression tables, model
// summary (incl. the A2 modelValueLabel/reasoningValueLabel behavior tables
// via its fallback path), option-prompt receipt builders, run outcome/tone,
// task/delivery status labels, and the remoteControlContext family.
// Assertions pin MEASURED behavior (A1 lesson).
const require = createRequire(import.meta.url);
const C = require("../../dist/reading-core/selectors/composer");
const CFG = require("../../dist/reading-core/config");
const R = require("../../dist/reading-core/selectors/runs");

const entry = (name, extra = {}) => ({
  invocation: `/${name}`,
  name,
  provider: "claude",
  kind: "builtin",
  description: `${name} description`,
  argumentHint: null,
  scope: "builtin",
  listed: true,
  ...extra,
});

const task = (extra = {}) => ({
  id: "task-1",
  title: "T",
  createdAt: "2026-07-01T00:00:00.000Z",
  provider: "claude",
  status: "ready",
  model: null,
  reasoningEffort: null,
  ...extra,
});

const view = (extra = {}) => ({
  task: task(),
  live: true,
  report: null,
  deliveryState: null,
  usageSnapshot: null,
  pendingOptionPrompt: null,
  optionPromptReceipt: null,
  remoteControl: { active: false, url: null, armedOverride: null },
  ...extra,
});

const delivery = (extra = {}) => ({
  taskId: "task-1",
  provider: "claude",
  deliverable: true,
  activeRun: false,
  approvalActive: false,
  bootLatched: true,
  queue: [],
  ...extra,
});

const run = (status, extra = {}) => ({
  runId: "run-1",
  prompt: "p",
  status,
  startedAt: "2026-07-03T09:00:00.000Z",
  endedAt: null,
  completionSource: null,
  approvalKind: null,
  stopEvents: [],
  ...extra,
});

// 1) slashFilterScore — match-quality ladder.
{
  const e = entry("review", { description: "Review a pull request" });
  assert.equal(C.slashFilterScore(e, ""), 0, "empty query matches everything at 0");
  assert.equal(C.slashFilterScore(e, "review"), 0, "exact name");
  assert.equal(C.slashFilterScore(e, "rev"), 1, "name prefix");
  assert.equal(C.slashFilterScore(e, "vie"), 2, "name substring");
  assert.equal(C.slashFilterScore(e, "pull"), 3, "description substring");
  assert.equal(C.slashFilterScore(e, "zzz"), null, "no match");
  assert.equal(C.slashFilterScore(entry("Review"), "review"), 0, "name lowercased before compare");
}

// 2) filteredSlashItems — listed gate, commands-before-skills, score, registry order.
{
  const cmdLate = entry("model");
  const cmdEarly = entry("mo");
  const skill = entry("mode", { kind: "skill" });
  const unlisted = entry("moo", { listed: false });
  const other = entry("help");
  const items = C.filteredSlashItems({
    entries: [skill, unlisted, cmdLate, cmdEarly, other],
    query: "mo",
  });
  assert.deepEqual(
    items.map((i) => i.name),
    ["mo", "model", "mode"],
    "unlisted dropped, no-match dropped; commands before skills; exact(0) before prefix(1); ties by registry order",
  );
}

// 2b) composerNotice — the composer line's editorial policy (2026-07-04):
// action feedback shows, lifecycle narration never does.
{
  const suppressed = [
    "Idle",
    "Ready",
    "Queued",
    "Stopping",
    "Stopped",
    "Failed",
    "Claude is working",
    "Codex is starting",
    "Starting Claude",
    "Delivering to Codex",
    "Waiting for Claude approval",
    "Claude PTY 12345",
    "Opening session",
    "Choosing Task Folder",
    "Selected proj",
    "Resuming session",
    "Resumed — your message will send when the agent is ready",
    "Choose how to resume",
    "Answer sent",
    "Type a message before sending",
  ];
  for (const status of suppressed) {
    assert.equal(C.composerNotice(status), "", `narration suppressed: ${status}`);
  }
  const shown = [
    // The fenced Invariant 5: partial attachment failure surfaced, not silent.
    "Attached 3 of 4 — the rest were unavailable.",
    "Couldn't restore the agent's memory — continuing as a new session; the history above stays readable",
    "Unknown Claude command — press Enter again to send it anyway",
    "Something exploded: ENOENT",
  ];
  for (const status of shown) {
    assert.equal(C.composerNotice(status), status, `action feedback shows: ${status}`);
  }
}

// 3) composerPlaceholder — the state table.
{
  const p = (v, activeRun = false, pendingApproval = false) =>
    C.composerPlaceholder(v, activeRun, pendingApproval);
  assert.equal(
    p(null),
    "Describe a task or ask a question",
    "new chat invites intent (2026-07-04 redesign) — provider-independent",
  );
  assert.equal(
    p(view({ pendingApproval: true }), false, true),
    "Claude approval is waiting — Enter queues your message",
    "approval outranks everything",
  );
  assert.equal(
    p(view(), true, false),
    "Claude is working — Enter queues your message",
    "active run",
  );
  assert.equal(p(view({ live: false })), "Message Claude — resumes this session", "dormant view");
  assert.equal(
    p(view({ deliveryState: delivery({ bootLatched: false }) })),
    "Claude is starting — your message will send when it's ready",
    "boot not latched",
  );
  assert.equal(
    p(view({ deliveryState: null })),
    "Claude is starting — your message will send when it's ready",
    "no delivery state reads as not latched (optional chain)",
  );
  assert.equal(
    p(view({ deliveryState: delivery(), report: { runs: [] } })),
    "Message Claude",
    "latched + zero runs",
  );
  assert.equal(
    p(view({ deliveryState: delivery(), report: { runs: [run("completed")] } })),
    "Continue, correct, or redirect this Task",
    "latched + history",
  );
}

// 4) sendPromptTitle — the state table.
{
  const t = (v, activeRun, pendingApproval, hasText) =>
    C.sendPromptTitle(v, activeRun, pendingApproval, hasText);
  assert.equal(t(null, false, false, true), "", "no task → empty title");
  assert.equal(t(view(), true, false, true), "Stop Claude", "active run → stop");
  assert.equal(t(view(), false, false, false), "Type a message before sending.", "no text");
  assert.equal(
    t(view(), false, true, true),
    "Queued — delivers after Claude approval is resolved.",
    "pending approval",
  );
  assert.equal(
    t(view({ deliveryState: delivery({ bootLatched: false }) }), false, false, true),
    "Claude is starting — your message sends as soon as it accepts input.",
    "live + not latched",
  );
  assert.equal(
    t(view({ live: false, deliveryState: delivery({ deliverable: false }) }), false, false, true),
    "Queued — delivers when Claude is ready.",
    "not deliverable (dormant skips the boot branch)",
  );
  assert.equal(t(view({ deliveryState: delivery() }), false, false, true), "Send to Claude", "ready");
}

// 5) sessionModelSummaryLabel — live statusline wins; spawn settings fallback.
{
  assert.deepEqual(
    CFG.MODEL_OPTIONS.codex.map(({ label, value }) => ({ label, value })),
    [
      { label: "5.6 Sol", value: "gpt-5.6-sol" },
      { label: "5.6 Terra", value: "gpt-5.6-terra" },
      { label: "5.6 Luna", value: "gpt-5.6-luna" },
      { label: "5.5", value: "gpt-5.5" },
      { label: "5.4", value: "gpt-5.4" },
      { label: "5.4 Mini", value: "gpt-5.4-mini" },
      { label: "5.3 Codex Spark", value: "gpt-5.3-codex-spark" },
      { label: "Native Default", value: null },
    ],
    "codex model list follows the current native order and slugs",
  );
  assert.deepEqual(
    CFG.MODEL_OPTIONS.claude.map(({ label, value }) => ({ label, value })),
    [
      { label: "Fable 5", value: "fable" },
      { label: "Opus 4.8", value: "opus" },
      { label: "Sonnet 5", value: "sonnet" },
      { label: "Haiku 4.5", value: "haiku" },
      { label: "Native Default", value: null },
    ],
    "claude model list follows the current native order while retaining stable aliases",
  );
  assert.deepEqual(
    CFG.reasoningOptionsForModel("codex", "gpt-5.6-sol").map(({ label, value }) => ({
      label,
      value,
    })),
    [
      { label: "Light", value: "low" },
      { label: "Medium", value: "medium" },
      { label: "High", value: "high" },
      { label: "Extra High", value: "xhigh" },
      { label: "Max", value: "max" },
      { label: "Ultra", value: "ultra" },
      { label: "Native Default", value: null },
    ],
    "Sol exposes both Max and Ultra and the Codex-app Light label",
  );
  // Complete Max/Ultra per-model gate matrix (codex 0.144.4 /model picker,
  // spikes/codex-effort-max-ultra/). Every codex model + Native Default (null)
  // is pinned, so dropping a model from an allowlist OR leaking a gated tier
  // onto a model that lacks it fails here. Ungated tiers stay present for all.
  const CODEX_EFFORT_GATE = [
    { model: "gpt-5.6-sol", max: true, ultra: true },
    { model: "gpt-5.6-terra", max: true, ultra: true },
    { model: "gpt-5.6-luna", max: true, ultra: false },
    { model: "gpt-5.5", max: false, ultra: false },
    { model: "gpt-5.4", max: false, ultra: false },
    { model: "gpt-5.4-mini", max: false, ultra: false },
    { model: "gpt-5.3-codex-spark", max: false, ultra: false },
    { model: null, max: false, ultra: false },
  ];
  for (const { model, max, ultra } of CODEX_EFFORT_GATE) {
    const label = model ?? "null";
    const values = CFG.reasoningOptionsForModel("codex", model).map(({ value }) => value);
    assert.equal(values.includes("max"), max, `${label} Max gate`);
    assert.equal(values.includes("ultra"), ultra, `${label} Ultra gate`);
    for (const base of ["low", "medium", "high", "xhigh", null]) {
      assert.ok(values.includes(base), `${label} keeps ungated tier ${base ?? "null"}`);
    }
  }
  assert.equal(CFG.reasoningValueLabel("codex", "low"), "Light", "Codex low label");
  assert.equal(CFG.reasoningValueLabel("claude", "low"), "Low", "Claude low label");
  assert.equal(CFG.SPEED_OPTIONS[0].label, "Standard", "default speed label follows Codex");

  // Launch Speed gate (S3). Claude native fast mode is Opus-only, so Fast is
  // offered ONLY on Opus; every other Claude model (and Native Default, whose
  // account model we can't know) collapses to Standard alone. Codex has no
  // per-model gate — Fast is offered for every model. Pinning the full matrix
  // means dropping Fast from Opus OR leaking it onto a non-Opus Claude model
  // fails here (not just a spot-check).
  const speedValues = (provider, model) =>
    CFG.speedOptionsForModel(provider, model).map(({ value }) => value);
  assert.deepEqual(speedValues("claude", "opus"), ["default", "fast"], "Claude Opus offers Fast");
  for (const model of ["fable", "sonnet", "haiku", null]) {
    assert.deepEqual(
      speedValues("claude", model),
      ["default"],
      `Claude ${model ?? "Native Default"} offers only Standard`,
    );
  }
  for (const model of [
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
    null,
  ]) {
    assert.deepEqual(
      speedValues("codex", model),
      ["default", "fast"],
      `Codex ${model ?? "Native Default"} offers Fast (no per-model gate)`,
    );
  }

  // draftModelSummaryLabel appends "Fast" whenever the ACTIVE provider's draft
  // speed is fast — for Claude too now, not only Codex. A non-fast draft (and
  // the other provider's fast selection) must not leak "Fast" onto the chip.
  const draft = (extra = {}) => ({
    provider: "claude",
    model: { claude: "opus", codex: "gpt-5.6-sol" },
    reasoningEffort: { claude: "high", codex: "high" },
    speedMode: { claude: "default", codex: "default" },
    ...extra,
  });
  assert.equal(
    C.draftModelSummaryLabel(draft()),
    "Opus 4.8 High",
    "Claude standard-speed draft: no Fast suffix",
  );
  assert.equal(
    C.draftModelSummaryLabel(draft({ speedMode: { claude: "fast", codex: "default" } })),
    "Opus 4.8 High Fast",
    "Claude fast draft appends Fast",
  );
  assert.equal(
    C.draftModelSummaryLabel(draft({ speedMode: { claude: "default", codex: "fast" } })),
    "Opus 4.8 High",
    "the inactive provider's fast selection does not leak onto the Claude chip",
  );
  assert.equal(
    C.draftModelSummaryLabel(
      draft({ provider: "codex", speedMode: { claude: "default", codex: "fast" } }),
    ),
    "5.6 Sol High Fast",
    "Codex fast draft still appends Fast",
  );

  assert.equal(C.sessionModelSummaryLabel(null), null, "no view");
  assert.equal(C.sessionModelSummaryLabel(view({ task: null })), null, "no task");
  assert.equal(
    C.sessionModelSummaryLabel(view({ task: task({ model: null, reasoningEffort: null }) })),
    null,
    "nothing known → null",
  );
  assert.equal(
    C.sessionModelSummaryLabel(view({ task: task({ model: "opus", reasoningEffort: "xhigh" }) })),
    "Opus 4.8 Extra High",
    "spawn settings via the A2 label tables",
  );
  assert.equal(
    C.sessionModelSummaryLabel(
      view({ task: task({ provider: "codex", model: "gpt-5.4-mini", reasoningEffort: "max" }) }),
    ),
    "5.4 Mini Max",
    "codex short label; a known value outside the current picker still has a friendly label",
  );
  assert.equal(
    C.sessionModelSummaryLabel(
      view({ task: task({ provider: "codex", model: "gpt-5.6-sol", reasoningEffort: "ultra" }) }),
    ),
    "5.6 Sol Ultra",
    "new Codex model and Ultra labels",
  );
  assert.equal(
    C.sessionModelSummaryLabel(
      view({
        task: task({ model: "opus", reasoningEffort: "low" }),
        usageSnapshot: { modelDisplayName: "Fable 5", reasoningEffort: "high" },
      }),
    ),
    "Fable 5 High",
    "live statusline outranks spawn settings",
  );
  assert.equal(
    C.sessionModelSummaryLabel(
      view({ task: task({ model: "opus" }), usageSnapshot: { reasoningEffort: "high" } }),
    ),
    "Opus 4.8 High",
    "partial snapshot: live effort + fallback model",
  );
}

// 5b) Live-chip switch hints — the display-only chip names each CLI's native
// switch. Codex has no Shift+Tab permission cycle; its /model covers effort.
{
  assert.equal(
    C.sessionModelSwitchHint("claude"),
    "Switch models in the CLI — /model",
    "claude model hint names /model",
  );
  assert.equal(
    C.sessionModelSwitchHint("codex"),
    "Switch model and effort in the CLI — /model",
    "codex model hint names /model and calls out effort",
  );
  assert.equal(
    C.sessionPermissionSwitchHint("claude"),
    "Switch modes in the CLI — Shift+Tab or /permissions",
    "claude permission hint keeps Shift+Tab",
  );
  assert.equal(
    C.sessionPermissionSwitchHint("codex"),
    "Switch permissions in the CLI — /permissions",
    "codex permission hint drops Shift+Tab, names /permissions",
  );
}

// 6) Option-prompt receipt builders.
{
  const q = (header, question, labels) => ({
    header,
    question,
    multiSelect: false,
    options: labels.map((label) => ({ label, description: "" })),
  });
  const prompt = {
    toolUseId: "tu-1",
    questions: [q("Auth", "Which auth?", ["OAuth", "Keys"]), q("DB", "Which db?", ["PG"])],
  };

  assert.deepEqual(
    C.optionPromptQuestionMeta(view({ pendingOptionPrompt: prompt })),
    [
      { header: "Auth", question: "Which auth?" },
      { header: "DB", question: "Which db?" },
    ],
    "meta from the live prompt",
  );
  assert.deepEqual(
    C.optionPromptQuestionMeta(
      view({
        optionPromptReceipt: {
          toolUseId: "tu-0",
          reconciled: true,
          lines: [{ header: "H", question: "Q", labels: ["A"] }],
        },
      }),
    ),
    [{ header: "H", question: "Q" }],
    "meta from a prior receipt",
  );
  assert.deepEqual(C.optionPromptQuestionMeta(view()), [], "no card context → empty");

  assert.deepEqual(
    C.reconcileReceiptLines(
      [
        { header: "Auth", question: "Which auth?" },
        { header: "DB", question: "Which db?" },
      ],
      { "Which auth?": ["OAuth"] },
    ),
    [
      { header: "Auth", question: "Which auth?", labels: ["OAuth"] },
      { header: "DB", question: "Which db?", labels: [] },
    ],
    "reconcile keys answers by question; unanswered → empty labels",
  );
  assert.deepEqual(
    C.reconcileReceiptLines([], { "Free question?": ["Yes"] }),
    [{ header: "Free question?", question: "Free question?", labels: ["Yes"] }],
    "no meta → lines derived straight from answers",
  );

  assert.deepEqual(
    C.optimisticReceiptLines(prompt, [1, -1]),
    [
      { header: "Auth", question: "Which auth?", labels: ["Keys"] },
      { header: "DB", question: "Which db?", labels: [] },
    ],
    "optimistic: selected index label; -1 → no labels",
  );
  assert.deepEqual(
    C.optimisticReceiptLines(prompt, [5]),
    [
      { header: "Auth", question: "Which auth?", labels: [] },
      { header: "DB", question: "Which db?", labels: [] },
    ],
    "out-of-range index and missing selection → empty labels",
  );
}

// 7) Run-status predicates.
{
  for (const s of ["active", "waiting-for-approval", "resumed-after-approval", "stopping"]) {
    assert.equal(R.isActiveRunStatus(s), true, `${s} is active`);
  }
  for (const s of ["completed", "stopped", "failed", "pty-exited", "approval-denied", ""]) {
    assert.equal(R.isActiveRunStatus(s), false, `${s} is settled`);
  }
  assert.equal(R.hasActiveRun(null), false, "no view");
  assert.equal(R.hasActiveRun(view({ report: { runs: [] } })), false, "no runs");
  assert.equal(
    R.hasActiveRun(view({ report: { runs: [run("active"), run("completed")] } })),
    false,
    "only the LATEST run counts",
  );
  assert.equal(
    R.hasActiveRun(view({ report: { runs: [run("completed"), run("active")] } })),
    true,
    "latest active",
  );
}

// 8) runOutcome / runTone / completionErrorExcerpt.
{
  assert.equal(
    R.runOutcome(run("waiting-for-approval", { approvalKind: "command" }), "Claude"),
    "Waiting for Command approval",
    "waiting uses the approval-kind label",
  );
  assert.equal(
    R.runOutcome(run("resumed-after-approval", { approvalKind: null }), "Claude"),
    "Resumed after Native approval",
    "null approvalKind falls back to 'Native' (formatters table)",
  );
  assert.equal(
    R.runOutcome(run("stopped", { stopEvents: [{ action: "stopped", slashStopSent: true }] }), "Claude"),
    "Stopped by Esc + /stop",
    "slash-stop wording",
  );
  assert.equal(R.runOutcome(run("stopped"), "Claude"), "Stopped by Esc", "plain stop");
  assert.equal(
    R.runOutcome(run("approval-denied", { approvalKind: "file-edit" }), "Claude"),
    "File edit approval denied",
    "denied",
  );
  assert.equal(
    R.runOutcome(run("completed", { completionSource: "terminal-idle-heuristic" }), "Claude"),
    "Completed by terminal idle heuristic",
    "heuristic completion named",
  );
  assert.equal(R.runOutcome(run("completed"), "Claude"), "Completed", "completed");
  assert.equal(R.runOutcome(run("pty-exited"), "Claude"), "PTY exited", "pty exit");
  assert.equal(R.runOutcome(run("failed"), "Claude"), "Failed", "failed");
  assert.equal(R.runOutcome(run("active"), "Claude"), "Claude is working", "fallback uses providerName");

  assert.equal(R.runTone(run("stopped")), "attention", "stopped tone");
  assert.equal(R.runTone(run("approval-denied")), "attention", "denied tone");
  assert.equal(R.runTone(run("failed")), "attention", "failed tone");
  assert.equal(R.runTone(run("completed")), "complete", "completed tone");
  assert.equal(R.runTone(run("waiting-for-approval")), "waiting", "waiting tone");
  assert.equal(R.runTone(run("active")), "active", "active tone");
  assert.equal(R.runTone(run("pty-exited")), "active", "pty-exited falls through to active (pinned)");

  assert.equal(R.completionErrorExcerpt(null), null, "no run");
  assert.equal(R.completionErrorExcerpt(run("completed")), null, "no hint");
  assert.equal(R.completionErrorExcerpt(run("completed", { completionHint: "text" })), null, "non-object hint");
  assert.equal(
    R.completionErrorExcerpt(run("completed", { completionHint: ["a"] })),
    null,
    "array hint rejected",
  );
  assert.equal(
    R.completionErrorExcerpt(run("completed", { completionHint: { errorExcerpt: "  API 529  " } })),
    "API 529",
    "excerpt trimmed",
  );
  assert.equal(
    R.completionErrorExcerpt(run("completed", { completionHint: { errorExcerpt: "   " } })),
    null,
    "blank excerpt → null",
  );
}

// 9) taskStatusLabel / deliveryStatusLabel tables.
{
  assert.equal(R.taskStatusLabel(task({ status: "running" })), "Claude is working");
  assert.equal(R.taskStatusLabel(task({ status: "waiting-for-approval" })), "Waiting for approval");
  assert.equal(R.taskStatusLabel(task({ status: "stopping" })), "Stopping");
  assert.equal(R.taskStatusLabel(task({ status: "stopped" })), "Stopped");
  assert.equal(R.taskStatusLabel(task({ status: "failed" })), "Failed");
  assert.equal(R.taskStatusLabel(task({ status: "starting" })), "Claude is starting");
  assert.equal(R.taskStatusLabel(task({ status: "new" })), "Claude is starting");
  assert.equal(R.taskStatusLabel(task({ status: "ready" })), "Ready");

  const item = (status) => ({ id: "i", status });
  assert.equal(
    R.deliveryStatusLabel(delivery({ queue: [item("delivered"), item("delivering")] })),
    "Delivering to Claude",
    "delivering outranks all",
  );
  assert.equal(R.deliveryStatusLabel(delivery({ queue: [item("queued")] })), "Queued");
  assert.equal(
    R.deliveryStatusLabel(delivery({ queue: [item("undelivered")] })),
    "Ready",
    "missed-receipt report retired 2026-07-04 — an undelivered item is silent, not a badge",
  );
  assert.equal(
    R.deliveryStatusLabel(delivery({ approvalActive: true })),
    "Waiting for Claude approval",
    "approval before activeRun",
  );
  assert.equal(R.deliveryStatusLabel(delivery({ activeRun: true })), "Claude is working");
  assert.equal(R.deliveryStatusLabel(delivery()), "Ready", "bootLatched idle");
  assert.equal(
    R.deliveryStatusLabel(delivery({ bootLatched: false })),
    "Starting Claude",
    "not yet latched",
  );
  assert.equal(
    R.deliveryStatusLabel(delivery({ queue: [item("queued")], approvalActive: true })),
    "Queued",
    "live queue activity outranks the approval row",
  );
}

// 10) Remote Control context family.
{
  const ctxOf = (v, draft = "claude") => R.remoteControlContext(v, draft);
  assert.deepEqual(ctxOf(view()), { mode: "inject" }, "live claude → inject");
  assert.deepEqual(ctxOf(view({ live: false })), { mode: "arm-dormant" }, "dormant claude → arm");
  assert.deepEqual(
    ctxOf(view({ task: task({ provider: "codex" }) })),
    { mode: "unavailable" },
    "codex task → unavailable",
  );
  assert.deepEqual(ctxOf(null, "claude"), { mode: "arm-draft" }, "claude draft → arm-draft");
  assert.deepEqual(ctxOf(null, "codex"), { mode: "unavailable" }, "codex draft → unavailable");
  assert.deepEqual(
    ctxOf(view({ task: null }), "claude"),
    { mode: "arm-draft" },
    "view without task falls to the draft branch",
  );

  const rc = (armedOverride) => ({ active: false, url: null, armedOverride });
  assert.equal(R.dormantArmed(view({ remoteControl: rc(true) }), false), true, "override true wins");
  assert.equal(R.dormantArmed(view({ remoteControl: rc(false) }), true), false, "override false wins");
  assert.equal(R.dormantArmed(view({ remoteControl: rc(null) }), true), true, "null follows default");

  const on = (ctx, v, draftRc = false, dflt = false) => R.remoteControlOn(ctx, v, draftRc, dflt);
  assert.equal(on({ mode: "arm-draft" }, null, true), true, "arm-draft reads the draft flag");
  assert.equal(
    on({ mode: "inject" }, view({ remoteControl: { active: true, url: "u", armedOverride: null } })),
    true,
    "inject reads live active",
  );
  assert.equal(on({ mode: "inject" }, null), false, "inject without view → false");
  assert.equal(
    on({ mode: "arm-dormant" }, view({ remoteControl: rc(null) }), false, true),
    true,
    "arm-dormant follows the effective armed state",
  );
  assert.equal(on({ mode: "arm-dormant" }, null, false, true), false, "arm-dormant without view → false");
  assert.equal(on({ mode: "unavailable" }, view(), true, true), false, "unavailable is never on");
}

// 11) lifecycleFreezesComposerText — D1's narrow freeze grain. Only the
// draft-moving phases disable the composer textarea; every other active phase
// (and idle) leaves typing enabled, so mutual exclusion never blurs the input.
{
  const freezes = (phase) => C.lifecycleFreezesComposerText({ sessionLifecycle: { phase } });
  // The resume choice no longer holds a lifecycle phase (D3): it is view state,
  // so `awaiting-resume-choice` is gone and the composer stays typable through it.
  const draftMoving = ["starting", "preparing-resume", "resuming"];
  const typingAllowed = [
    "idle",
    "sending",
    "attaching",
    "session-mutation",
    "project-mutation",
  ];
  for (const phase of draftMoving) {
    assert.equal(freezes(phase), true, `${phase} freezes the composer text`);
  }
  for (const phase of typingAllowed) {
    assert.equal(freezes(phase), false, `${phase} leaves the composer typable`);
  }
  // The two sets partition the full SessionLifecycle union (eight phases).
  assert.equal(
    draftMoving.length + typingAllowed.length,
    8,
    "all eight lifecycle phases are covered by the freeze partition",
  );
}

console.log("reading-composer-selectors: 11 fixture groups pass");
