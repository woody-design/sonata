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
  pendingAttachments: [],
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
    "3 of 6 images attached",
    "Couldn't restore the agent's memory — continuing as a new session; the history above stays readable",
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
    "Claude is working — Enter queues your message",
    "pendingApproval reads as working (the composer is hidden behind the drawer — S2)",
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

// 3b) composerActionMode — THE send/stop predicate (S2, D1). One expression
// decides both what the button LOOKS like and what a click DOES, so this table
// is the whole contract: `stop ⟺ a run is under way AND nothing is staged`.
// Every input combination is pinned, attachments included — an attachment with
// no text is a sendable message, so it must flip the button out of stop-mode
// exactly as typed text does.
{
  const st = (draftAttachments = []) => ({ draftAttachments });
  const image = { name: "shot.png", previewUrl: null, kind: "image" };
  const runningView = (extra = {}) => view({ report: { runs: [run("active")] }, ...extra });
  const idleView = (extra = {}) => view({ report: { runs: [run("completed")] }, ...extra });

  // (activeRun, text, attachments) → mode. The session arm.
  const TABLE = [
    { running: true, text: "", attached: false, mode: "stop" },
    { running: true, text: "   \n ", attached: false, mode: "stop" },
    { running: true, text: "steer left", attached: false, mode: "send" },
    { running: true, text: "", attached: true, mode: "send" },
    { running: true, text: "steer left", attached: true, mode: "send" },
    { running: false, text: "", attached: false, mode: "send" },
    { running: false, text: "hello", attached: false, mode: "send" },
    { running: false, text: "", attached: true, mode: "send" },
    { running: false, text: "hello", attached: true, mode: "send" },
  ];
  for (const row of TABLE) {
    const v = (row.running ? runningView : idleView)({
      pendingAttachments: row.attached ? [image] : [],
    });
    assert.equal(
      C.composerActionMode(st(), v, row.text),
      row.mode,
      `run=${row.running} text=${JSON.stringify(row.text)} attached=${row.attached} → ${row.mode}`,
    );
  }

  // A run known only to delivery state (the report has not caught up) is still
  // a run — the union is the whole reason this selector exists.
  assert.equal(
    C.composerActionMode(st(), view({ deliveryState: delivery({ activeRun: true, activeRunId: "run-9" }) }), ""),
    "stop",
    "delivery-only active run reads as stop-mode",
  );
  assert.equal(
    C.composerActionMode(st(), view({ deliveryState: delivery({ activeRun: true, activeRunId: "run-9" }) }), "queue this"),
    "send",
    "…and text still wins over it",
  );

  // New chat (no view): nothing can be running, and the attachments live in the
  // draft rather than in a view — send-mode always, whatever is staged.
  assert.equal(C.composerActionMode(st(), null, ""), "send", "new chat, empty");
  assert.equal(C.composerActionMode(st([image]), null, ""), "send", "new chat, draft attachment");

  // The two halves, separately — the painter reads both directly.
  assert.equal(C.composerActiveRun(null), false, "no view is not running");
  assert.equal(C.composerActiveRun(runningView()), true, "report says running");
  assert.equal(
    C.composerActiveRun(view({ deliveryState: delivery({ activeRun: true, activeRunId: "run-9" }) })),
    true,
    "delivery says running",
  );
  assert.equal(C.composerHasContent(st(), null, "  "), false, "whitespace is not content");
  assert.equal(C.composerHasContent(st([image]), null, ""), true, "new chat draft attachment counts");
  assert.equal(
    C.composerHasContent(st(), view({ pendingAttachments: [image] }), ""),
    true,
    "a session's own pending attachment counts",
  );
  assert.equal(
    C.composerHasContent(st([image]), view(), ""),
    false,
    "a session never reads the new-chat draft's attachments",
  );

  // --- The stop target's IDENTITY ------------------------------------------
  //
  // What the single-flight stop latches on (S2 D2). The invariant, and the whole
  // point of review round 1: ONE RUN HAS ONE KEY, whichever evidence has arrived.
  // The first cut returned a `"delivery"` sentinel before the report propagated
  // and `run:<id>` after — one run, two names — which released the latch mid-run
  // (a second bare Esc, the exact D2 hazard) and let a stale sentinel block a
  // LATER run's honest stop. So: run ids or nothing.
  assert.equal(R.activeRunKey(null), null, "nothing to stop");
  assert.equal(R.activeRunKey(idleView()), null, "a settled run is not a target");
  assert.equal(R.activeRunKey(runningView()), "run-1", "the active run names itself");

  {
    // The propagation boundary, in the three shapes one run passes through:
    // delivery knows it first (emit-on-change), then the report catches up
    // (1000ms trailing debounce), then delivery lets go first at the end.
    const deliveryOnly = view({
      report: { runs: [run("completed", { runId: "run-0" })] },
      deliveryState: delivery({ activeRun: true, activeRunId: "run-1" }),
    });
    const bothKnow = view({
      report: { runs: [run("active")] },
      deliveryState: delivery({ activeRun: true, activeRunId: "run-1" }),
    });
    const reportOnly = view({
      report: { runs: [run("active")] },
      deliveryState: delivery({ activeRun: false, activeRunId: null }),
    });
    assert.equal(R.activeRunKey(deliveryOnly), "run-1", "delivery names the run before the report");
    assert.equal(R.activeRunKey(bothKnow), "run-1", "…the same name once both know");
    assert.equal(R.activeRunKey(reportOnly), "run-1", "…and still the same as delivery lets go");
    // Stated as the invariant itself, not three coincidences.
    assert.equal(
      new Set([deliveryOnly, bothKnow, reportOnly].map(R.activeRunKey)).size,
      1,
      "one run keeps ONE key across the whole propagation boundary",
    );
    // The composer's boolean is the union and stays true throughout — a
    // different question, deliberately not derived from the identity.
    for (const v of [deliveryOnly, bothKnow, reportOnly]) {
      assert.equal(C.composerActiveRun(v), true, "the button sees a run in every shape");
    }
  }

  // Freshness order: delivery is emitted on change, the report is debounced, so
  // a report still naming the PREVIOUS run must not outrank a live delivery id.
  assert.equal(
    R.activeRunKey(
      view({
        report: { runs: [run("active", { runId: "run-1" })] },
        deliveryState: delivery({ activeRun: true, activeRunId: "run-2" }),
      }),
    ),
    "run-2",
    "the fresher evidence names the run",
  );

  // Scenario B (review round 1): a latch taken in run 1's delivery-only window
  // must never match run 2 — the failure mode was a stop silently dropped, with
  // no Esc and no feedback.
  {
    const stopRequestedRunId = R.activeRunKey(
      view({ deliveryState: delivery({ activeRun: true, activeRunId: "run-1" }) }),
    );
    const laterRun = view({ deliveryState: delivery({ activeRun: true, activeRunId: "run-2" }) });
    assert.notEqual(
      stopRequestedRunId,
      R.activeRunKey(laterRun),
      "a stale latch cannot block the next run's stop",
    );
  }

  // A run delivery asserts but cannot NAME (only reachable for payloads recorded
  // before activeRunId existed): fall back to the report, and to null — never to
  // a token that is not run-unique.
  assert.equal(
    R.activeRunKey(view({ deliveryState: delivery({ activeRun: true }) })),
    null,
    "an unnameable run yields no key (the latch stands down rather than lie)",
  );
  assert.equal(
    R.activeRunKey(
      view({ report: { runs: [run("active")] }, deliveryState: delivery({ activeRun: true }) }),
    ),
    "run-1",
    "…unless the report can name it",
  );
  assert.equal(
    C.composerActiveRun(view({ deliveryState: delivery({ activeRun: true }) })),
    true,
    "the button still shows stop for a run it cannot name",
  );
}

// 4) sendPromptTitle — the state table. Argument 2 is the MODE, not the run
// (S2): the title must describe the press the user is about to make.
{
  const t = (v, stopMode, pendingApproval, hasContent) =>
    C.sendPromptTitle(v, stopMode, pendingApproval, hasContent);
  assert.equal(t(null, false, false, true), "", "no task → empty title");
  assert.equal(t(view(), true, false, false), "Stop Claude", "stop-mode → stop");
  assert.equal(t(view(), false, false, false), "Type a message before sending.", "no text");
  // Mid-run with a staged message: send-mode falls through to the delivery
  // ladder, which already distinguishes the providers' mid-turn semantics —
  // Claude writes through (deliverable) and Codex holds (not deliverable).
  assert.equal(
    t(view({ deliveryState: delivery() }), false, false, true),
    "Send to Claude",
    "mid-run Claude write-through reads as a send",
  );
  assert.equal(
    t(
      view({ task: task({ provider: "codex" }), deliveryState: delivery({ deliverable: false }) }),
      false,
      false,
      true,
    ),
    "Queued — delivers when Codex is ready.",
    "mid-run Codex hold reads as a queue",
  );
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
  // Re-walked against the live `/model` picker at claude 2.1.258 (upstream sync
  // 2026-09-01, SL-4 — probes q12/q13). The LABELS are the load-bearing half:
  // `sessionModelValue` maps the statusline `model.display_name` back to an alias
  // BY LABEL, so a label that is not the CLI's display name silently marks no
  // current model at all. Each label below is the display name the CLI itself
  // reported after switching to that alias.
  assert.deepEqual(
    CFG.MODEL_OPTIONS.claude.map(({ label, value }) => ({ label, value })),
    [
      { label: "Fable 5.1", value: "fable" },
      { label: "Opus 5 (1M context)", value: "opus[1m]" },
      { label: "Opus 5", value: "opus" },
      { label: "Sonnet 5", value: "sonnet" },
      { label: "Haiku 4.5", value: "haiku" },
      { label: "Native Default", value: null },
    ],
    "claude model list follows the current native order while retaining stable aliases",
  );
  // The label→alias round trip `sessionModelValue` performs, pinned on the
  // MEASURED display names (q13: each is what the statusline payload carried
  // after `/model <alias>` settled). A relabel that breaks the round trip is the
  // exact regression this slice found and fixed, so it is tested as a round trip
  // rather than as a list.
  for (const [displayName, alias] of [
    ["Fable 5.1", "fable"],
    ["Opus 5 (1M context)", "opus[1m]"],
    ["Opus 5", "opus"],
    ["Sonnet 5", "sonnet"],
    ["Haiku 4.5", "haiku"],
  ]) {
    const match = CFG.MODEL_OPTIONS.claude.find((option) => option.label === displayName);
    assert.equal(
      match?.value,
      alias,
      `the live statusline display name ${JSON.stringify(displayName)} maps back to ${alias}`,
    );
    assert.equal(
      CFG.modelValueLabel("claude", alias),
      displayName,
      `…and ${alias} renders as the CLI's own display name`,
    );
  }
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
  // offered ONLY on the Opus rows; every other Claude model (and Native Default,
  // whose account model we can't know) collapses to Standard alone. Codex has no
  // per-model gate — Fast is offered for every model. Pinning the full matrix
  // means dropping Fast from Opus OR leaking it onto a non-Opus Claude model
  // fails here (not just a spot-check).
  // `opus[1m]` joined the gate on MEASUREMENT (SL-4 probe q15): at 2.1.258 it
  // draws the same fast-mode acknowledgement from the CLI as plain `opus`, while
  // `haiku` + fastMode draws none at all.
  const speedValues = (provider, model) =>
    CFG.speedOptionsForModel(provider, model).map(({ value }) => value);
  assert.deepEqual(speedValues("claude", "opus"), ["default", "fast"], "Claude Opus offers Fast");
  assert.deepEqual(
    speedValues("claude", "opus[1m]"),
    ["default", "fast"],
    "Claude Opus (1M context) offers Fast too",
  );
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
    "Opus 5 High",
    "Claude standard-speed draft: no Fast suffix",
  );
  assert.equal(
    C.draftModelSummaryLabel(draft({ speedMode: { claude: "fast", codex: "default" } })),
    "Opus 5 High Fast",
    "Claude fast draft appends Fast",
  );
  assert.equal(
    C.draftModelSummaryLabel(draft({ speedMode: { claude: "default", codex: "fast" } })),
    "Opus 5 High",
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
    "Opus 5 Extra High",
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
  // The display name here is MEASURED (claude 2.1.258 — the statusline payload
  // for `claude-opus-5[1m]`), not invented. The fixture used to read "Fable 5",
  // a name the CLI has never emitted, which is part of why the label drift this
  // slice fixed went unseen for a whole release train.
  assert.equal(
    C.sessionModelSummaryLabel(
      view({
        task: task({ model: "opus", reasoningEffort: "low" }),
        usageSnapshot: { modelDisplayName: "Opus 5 (1M context)", reasoningEffort: "high" },
      }),
    ),
    "Opus 5 (1M context) High",
    "live statusline outranks spawn settings",
  );
  assert.equal(
    C.sessionModelSummaryLabel(
      view({ task: task({ model: "opus" }), usageSnapshot: { reasoningEffort: "high" } }),
    ),
    "Opus 5 High",
    "partial snapshot: live effort + fallback model",
  );
}

// (5b — live-chip switch-hint selectors retired in S5: S3/S4 made the codex
// access + model chips interactive, dropping the last callers of
// sessionModelSwitchHint / sessionPermissionSwitchHint.)

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

  // Draft → wire selections (drawer S1; replaces the optimistic receipt).
  const draft = (optionIndices, text = null) => ({ optionIndices, text });
  assert.deepEqual(
    C.optionPromptSelectionsFromDrafts(prompt, [draft([1]), draft([0])]),
    [
      { kind: "option", index: 1 },
      { kind: "option", index: 0 },
    ],
    "single-select drafts map to option selections",
  );
  assert.equal(
    C.optionPromptSelectionsFromDrafts(prompt, [draft([1]), draft([])]),
    null,
    "any unanswered question → null (send disabled)",
  );
  assert.equal(
    C.optionPromptSelectionsFromDrafts(prompt, [draft([1])]),
    null,
    "wrong draft count → null",
  );
  assert.deepEqual(
    C.optionPromptSelectionsFromDrafts(prompt, [draft([], "custom answer"), draft([0])]),
    [
      { kind: "text", text: "custom answer" },
      { kind: "option", index: 0 },
    ],
    "non-empty text becomes a free-text selection",
  );
  assert.deepEqual(
    C.optionPromptSelectionsFromDrafts(prompt, [draft([1], "wins"), draft([0])])?.[0],
    { kind: "text", text: "wins" },
    "text supersedes stray indices (belt to the UI's suspender)",
  );
  {
    const multiPrompt = {
      toolUseId: "tu-2",
      questions: [{ ...q("Top", "Which toppings?", ["Cheese", "Basil", "Olive"]), multiSelect: true }],
    };
    assert.deepEqual(
      C.optionPromptSelectionsFromDrafts(multiPrompt, [draft([2, 0])]),
      [{ kind: "options", indices: [0, 2] }],
      "multi-select drafts sort into an options selection",
    );
    // P9f: free-text is NOT injectable on a multiSelect question — the text is
    // ignored there (picked options win; no options → unanswered/null).
    assert.deepEqual(
      C.optionPromptSelectionsFromDrafts(multiPrompt, [draft([1], "ignored on multi")]),
      [{ kind: "options", indices: [1] }],
      "text on a multiSelect question falls through to the toggles",
    );
    assert.equal(
      C.optionPromptSelectionsFromDrafts(multiPrompt, [draft([], "only text")]),
      null,
      "text-only draft on a multiSelect question stays unanswered",
    );
  }
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
  // SL-15: the key is READ from the report, not assumed. Codex's stop writes
  // Ctrl+C while a turn is live (its interrupt key moved at 0.152.x), so the two
  // cases above are now the FALLBACK — a report with no recorded encoding, which
  // is every report written before the field existed, and all of those were Esc.
  assert.equal(
    R.runOutcome(
      run("stopped", { stopEvents: [{ action: "interrupt", phase: "interrupt", encodedAs: "Ctrl+C" }] }),
      "Codex",
    ),
    "Stopped by Ctrl+C",
    "a codex stop names the key it actually wrote",
  );
  assert.equal(
    R.runOutcome(
      run("stopped", {
        stopEvents: [
          { action: "interrupt", phase: "interrupt", encodedAs: "Ctrl+C" },
          { action: "stopped", slashStopSent: true },
        ],
      }),
      "Codex",
    ),
    "Stopped by Ctrl+C + /stop",
    "and keeps the slash-stop wording",
  );
  assert.equal(
    R.runOutcome(
      run("stopped", {
        stopEvents: [
          { action: "interrupt", phase: "interrupt", encodedAs: "Esc" },
          // A RETRY row is not the stop's own press; the first `interrupt` row is
          // the one that names the key the stop wrote.
          { action: "interrupt", phase: "interrupt-retry", encodedAs: "Esc" },
        ],
      }),
      "Claude",
    ),
    "Stopped by Esc",
    "a retry row does not change the reported key",
  );
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
  assert.equal(
    R.deliveryStatusLabel(
      delivery({ activeRun: true, attachmentNotice: "3 of 6 images attached" }),
    ),
    "Claude is working",
    "S6 item 5: live run status outranks the sticky notice — a text-only follow-up shows working, not the stale partial-attachment notice",
  );
  assert.equal(
    R.deliveryStatusLabel(delivery({ attachmentNotice: "3 of 6 images attached" })),
    "3 of 6 images attached",
    "S6 item 5: once idle, the sticky reminder resurfaces above Ready until the next full delivery clears it",
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
  // The Rewind panel (claude ≥2.1.216) is the one hold that outranks the queue
  // rows: it is the REASON they are not moving, so "Queued" alone would be an
  // unexplained stall — the invisible-hold failure S3 decision A warns about,
  // and the price of exempting this panel from that decision (its Enter is a
  // RESTORE, so the "visible and recoverable" premise fails). It stays BELOW
  // "Delivering", where bytes are already in flight.
  assert.equal(
    R.deliveryStatusLabel(delivery({ rewindPanelOpen: true, queue: [item("queued")] })),
    "Rewind panel open — press Esc in the CLI",
    "the hold explains itself instead of reading Queued",
  );
  assert.equal(
    R.deliveryStatusLabel(delivery({ rewindPanelOpen: true })),
    "Rewind panel open — press Esc in the CLI",
    "and it outranks the idle Ready — an empty queue could not deliver either",
  );
  assert.equal(
    R.deliveryStatusLabel(delivery({ rewindPanelOpen: true, queue: [item("delivering")] })),
    "Delivering to Claude",
    "delivering still outranks it",
  );
  assert.equal(
    R.deliveryStatusLabel(delivery({ rewindPanelOpen: undefined })),
    "Ready",
    "the field is optional — recorded fixtures predate it and must read as not-open",
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

// --- stoppedRunRefillDraft (stop S2): stopping hands the words back --------
{
  const runReport = (extra = {}) => ({
    runId: "run-1",
    taskId: "task-1",
    kind: "prompt",
    prompt: "fix the login bug\nand add a test",
    title: "fix the login bug",
    status: "active",
    lifecyclePhase: "active",
    startedAt: "2026-07-17T00:00:00.000Z",
    endedAt: null,
    elapsedMs: null,
    completionSource: null,
    completionConfidence: null,
    ...extra,
  });
  const viewWithRun = (runExtra = {}) => view({ report: { runs: [runReport(runExtra)] } });

  assert.equal(
    R.stoppedRunRefillDraft(viewWithRun(), ""),
    "fix the login bug\nand add a test",
    "an empty composer refills with the stopped run's full (multi-line) prompt",
  );
  assert.equal(
    R.stoppedRunRefillDraft(viewWithRun(), "already typing a correction"),
    null,
    "an occupied composer is never clobbered",
  );
  assert.equal(
    R.stoppedRunRefillDraft(viewWithRun(), "   \n  "),
    "fix the login bug\nand add a test",
    "a whitespace-only composer counts as empty and still refills",
  );
  assert.equal(
    R.stoppedRunRefillDraft(viewWithRun({ status: "completed" }), ""),
    null,
    "a settled run refills nothing (the stop targeted nothing)",
  );
  assert.equal(
    R.stoppedRunRefillDraft(viewWithRun({ prompt: "   " }), ""),
    null,
    "a blank run prompt refills nothing",
  );
  assert.equal(R.stoppedRunRefillDraft(view({ report: { runs: [] } }), ""), null, "no runs → null");
  assert.equal(R.stoppedRunRefillDraft(null, ""), null, "no view → null");
  assert.equal(
    R.stoppedRunRefillDraft(viewWithRun({ prompt: "  indented code\n  matters  " }), ""),
    "  indented code\n  matters  ",
    "the prompt returns VERBATIM — leading/trailing whitespace can be meaningful",
  );
  assert.equal(
    R.stoppedRunRefillDraft(viewWithRun({ prompt: "<task-notification>\n…\n</task-notification>" }), ""),
    null,
    "a background task-notification run's envelope XML is never handed back",
  );
  assert.equal(
    R.stoppedRunRefillDraft(viewWithRun({ prompt: "[Image attachment]" }), ""),
    null,
    "the attachment-only placeholder is never handed back",
  );
  assert.equal(
    R.stoppedRunRefillDraft(viewWithRun({ prompt: "[3 image attachments]" }), ""),
    null,
    "the multi-attachment placeholder is never handed back",
  );
  assert.equal(
    R.stoppedRunRefillDraft(viewWithRun({ prompt: "(prompt)" }), ""),
    null,
    "the hook-echo fallback placeholder is never handed back",
  );
}

console.log("reading-composer-selectors: 13 fixture groups pass");
