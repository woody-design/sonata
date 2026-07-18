import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// The crown fence (map §2.4, step C2): the runtime reducer replayed against
// RECORDED REALITY — the pinned runtime-event corpus — so the render-path
// policy (§1.3) is verified against an oracle independent of the author's
// understanding of the code it was lifted from. Three assertion layers:
//   1. table-derived invariants + a full differential directive oracle over
//      EVERY corpus event (expected directives recomputed from pre-state by
//      an independent §1.3 transcription, not by the reducer);
//   2. final-state goldens per scenario file × active/background variant,
//      pinned under tests/fixtures/reducer-goldens/ — regenerate with
//      WRITE_REDUCER_GOLDENS=1 and review the diff, never silently;
//   3. hand-written adversarial cases the corpus cannot reach (INDEX.md
//      "NOT in this corpus"): keyed approval:expired (S6-P2),
//      approval:persisted, file:watch-error, keyed pendingApproval
//      retraction on run settle — plus option-prompt cancel, malformed
//      payloads, and the chip/liveness edge cases.
// Assertions pin MEASURED behavior (A1 lesson).
const require = createRequire(import.meta.url);
const R = require("../../dist/reading-core/runtime-reducer");
const S = require("../../dist/reading-core/state");
const C = require("../../dist/reading-core/selectors/composer");

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = resolve(HERE, "../fixtures/runtime-events");
const GOLDENS_DIR = resolve(HERE, "../fixtures/reducer-goldens");
const WRITE_GOLDENS = process.env.WRITE_REDUCER_GOLDENS === "1";

// Fixed clock (map §2.4 determinism): the reducer's only time read is the
// run:started title auto-adopt's `updatedAt`.
const NOW_MS = Date.parse("2026-07-03T12:00:00.000Z");
const READING_SETTINGS = { theme: "default", mode: "auto", textStep: 16 };

function syntheticTask(taskId) {
  // Minimal synthetic Task (corpus-seeding gotcha: task views are created by
  // IPC responses, not events, so the replay seeds them). Title is an
  // legacy automatic placeholder so recorded run:started events exercise the
  // title auto-adopt path under the fixed clock.
  return {
    id: taskId,
    title: "New Task",
    provider: "claude",
    model: "opus",
    reasoningEffort: null,
    speedMode: null,
    sandbox: null,
    approval: null,
    permissionMode: null,
    runtimeSessionId: `rs-${taskId}`,
    providerSessionRef: null,
    providerCwd: "/workspace/fixture",
    workingDirectory: "/workspace/fixture",
    status: "running",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  };
}

function isActive(state, view) {
  return Boolean(view.task && view.task.id === state.activeTaskId);
}

// ---------------------------------------------------------------------------
// Layer 1 — the differential directive oracle: an independent transcription
// of the §1.3 render-path table, computed from PRE-reduce state.
// ---------------------------------------------------------------------------

// The markViewChanged family: mutate → full (active) | unread-only (bg).
const VIEW_CHANGED_TYPES = new Set([
  "run:started",
  "run:updated",
  "approval:detected",
  "approval:decision",
  "approval:persisted",
  "option-prompt:detected",
  "option-prompt:resolved",
  "remote-control:state",
  "control-switch:state",
  "delivery:state",
  "delivery:receipt",
  "task:updated",
  "run:stopped",
  "transcript:located",
]);

function expectedDirectives(state, event) {
  if (event.type === "sessions:updated") {
    return [{ kind: "session-index-debounced" }];
  }
  const taskId = event.payload?.taskId;
  const view = typeof taskId === "string" ? S.taskViewForId(state, taskId) : null;
  if (!view) {
    return [];
  }
  const active = isActive(state, view);

  if (event.type === "pty:data") {
    // Recompute the C1 boolean (appendLiveTranscript's "cleaned text now
    // visible" condition) on a shallow-copied transcript slice, so the
    // reducer's scheduling choice is checked against the state op directly.
    const liveRunId = view.liveTranscriptRunId;
    const probe = {
      liveTranscriptRunId: liveRunId,
      task: view.task ? { provider: view.task.provider } : null,
      runTranscripts: liveRunId
        ? view.runTranscripts.filter((t) => t.runId === liveRunId).map((t) => ({ ...t }))
        : [],
    };
    return S.appendLiveTranscript(probe, event.payload.data)
      ? [{ kind: "transcript-debounced", taskId }]
      : [{ kind: "none" }];
  }
  if (event.type === "approval:expired") {
    if (view.pendingApproval?.approvalId !== event.payload.approvalId) {
      return [{ kind: "none" }];
    }
    return [active ? { kind: "full", taskId } : { kind: "unread-only", taskId }];
  }
  if (event.type === "usage:updated") {
    if (!active) {
      return [{ kind: "none" }];
    }
    const before = C.sessionModelSummaryLabel(view);
    const after = C.sessionModelSummaryLabel({
      task: view.task,
      usageSnapshot: event.payload.snapshot,
    });
    return [
      {
        kind: "usage-in-place",
        taskId,
        chipChanged: after !== before,
        popoverOpen: Boolean(state.usagePopover),
      },
    ];
  }
  if (event.type === "cli-state:changed") {
    const previousActivity = view.cliState?.activity ?? null;
    return event.payload.activity !== previousActivity
      ? [{ kind: "sidebar", taskId }]
      : [{ kind: "none" }];
  }
  if (event.type === "working-status:updated") {
    const previousLiveness = view.workingStatus?.liveness ?? "fresh";
    if (event.payload.liveness !== previousLiveness) {
      return [{ kind: "strip-full", taskId, statusStrip: active }];
    }
    return active ? [{ kind: "strip-in-place", taskId }] : [{ kind: "none" }];
  }
  if (event.type === "transcript:blocks") {
    return [active ? { kind: "transcript-debounced", taskId } : { kind: "unread-only", taskId }];
  }
  if (event.type === "report:updated") {
    return [{ kind: "report-refresh", taskId }];
  }
  if (VIEW_CHANGED_TYPES.has(event.type)) {
    return [active ? { kind: "full", taskId } : { kind: "unread-only", taskId }];
  }
  // No renderer handler (task:started, task:ready, prompt:submitted,
  // file:watching, file:changed, pty:exit, run:stop-requested, …).
  return [{ kind: "none" }];
}

// Named table invariants (the packet's list) — implied by the oracle, but
// asserted separately so a failure names the violated §1.3 row directly.
function checkInvariants(event, directives, context) {
  const kinds = directives.map((d) => d.kind);
  if (event.type === "usage:updated") {
    assert.ok(!kinds.includes("full"), `usage:updated must never full-render (${context})`);
    assert.ok(!kinds.includes("unread-only"), `usage:updated is never unread (${context})`);
  }
  if (kinds.includes("strip-in-place")) {
    assert.equal(
      event.type,
      "working-status:updated",
      `strip-in-place only from working-status ticks (${context})`,
    );
    assert.ok(context.active, `strip-in-place only when the view is active (${context})`);
  }
  if (event.type === "cli-state:changed") {
    assert.ok(
      kinds.every((k) => k === "sidebar" || k === "none"),
      `cli-state may only rebuild the sidebar, and only on activity transitions (${context})`,
    );
    assert.equal(kinds.includes("sidebar"), context.activityTransition,
      `cli-state → sidebar iff activity transition (${context})`);
  }
  if (event.type === "sessions:updated") {
    assert.deepEqual(kinds, ["session-index-debounced"], `sessions:updated row (${context})`);
  }
  if (event.type === "report:updated" && directives.length > 0) {
    assert.deepEqual(kinds, ["report-refresh"], `report:updated is effect-only (${context})`);
  }
  if (event.type === "pty:data" && directives.length > 0) {
    assert.equal(
      kinds.includes("transcript-debounced"),
      context.ptyAppendVisible,
      `pty:data schedules the transcript render iff the C1 boolean (${context})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Layer 2 — final-state goldens (JSON projection; Maps as sorted entries,
// long strings as content digests so goldens stay reviewable).
// ---------------------------------------------------------------------------

function digest(text) {
  return {
    "~len": text.length,
    "~sha256": createHash("sha256").update(text).digest("hex").slice(0, 16),
    "~head": text.slice(0, 64),
    "~tail": text.slice(-64),
  };
}

function project(value) {
  if (typeof value === "string") {
    return value.length > 160 ? digest(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map(project);
  }
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, project(entry)]);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, project(entry)]));
  }
  return value;
}

function projectState(state) {
  return {
    activeTaskId: state.activeTaskId,
    taskViews: state.taskViews.map((view) => project(view)),
  };
}

// ---------------------------------------------------------------------------
// Corpus replay
// ---------------------------------------------------------------------------

function loadScenarioFiles(scenario) {
  const dir = join(CORPUS_DIR, scenario);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => ({
      name,
      events: readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).event),
    }));
}

function replay(events, { active }) {
  const state = S.createInitialState({ ...READING_SETTINGS });
  const taskIds = [
    ...new Set(
      events
        .map((event) => event.payload?.taskId)
        .filter((taskId) => typeof taskId === "string"),
    ),
  ];
  for (const taskId of taskIds) {
    S.upsertTaskView(state, S.createTaskView(syntheticTask(taskId), "Claude PTY 1", true));
  }
  state.activeTaskId = active ? (taskIds[0] ?? null) : null;

  const directiveCounts = {};
  let dropped = 0;
  for (const event of events) {
    const view =
      typeof event.payload?.taskId === "string"
        ? S.taskViewForId(state, event.payload.taskId)
        : null;
    const context = {
      active: view ? isActive(state, view) : false,
      activityTransition:
        event.type === "cli-state:changed" && view
          ? event.payload.activity !== (view.cliState?.activity ?? null)
          : false,
      ptyAppendVisible: false,
      toString() {
        return `${event.type} @ ${event.ts} active=${this.active}`;
      },
    };
    const expected = expectedDirectives(state, event);
    if (event.type === "pty:data") {
      context.ptyAppendVisible = expected.some((d) => d.kind === "transcript-debounced");
    }
    const directives = R.reduceRuntimeEvent(state, event, NOW_MS);
    assert.deepEqual(
      directives,
      expected,
      `directive oracle mismatch on ${context} — got ${JSON.stringify(directives)}, table says ${JSON.stringify(expected)}`,
    );
    checkInvariants(event, directives, context);
    if (directives.length === 0) {
      dropped += 1;
    }
    for (const d of directives) {
      directiveCounts[d.kind] = (directiveCounts[d.kind] ?? 0) + 1;
    }
  }
  return { state, directiveCounts, dropped, events: events.length };
}

const scenarios = readdirSync(CORPUS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.ok(scenarios.length > 0, "pinned corpus exists");

let totalEvents = 0;
let goldensChecked = 0;
if (WRITE_GOLDENS) {
  mkdirSync(GOLDENS_DIR, { recursive: true });
}
for (const scenario of scenarios) {
  const golden = {};
  for (const file of loadScenarioFiles(scenario)) {
    const variants = {};
    for (const variant of ["active", "background"]) {
      const result = replay(file.events, { active: variant === "active" });
      totalEvents += result.events;
      // Seeding covers every recorded taskId, so nothing may be dropped.
      assert.equal(result.dropped, 0, `${scenario}/${file.name} ${variant}: dropped events`);
      variants[variant] = {
        events: result.events,
        directiveCounts: result.directiveCounts,
        state: projectState(result.state),
      };
    }
    golden[file.name] = variants;
  }
  const goldenPath = join(GOLDENS_DIR, `${scenario}.json`);
  const rendered = `${JSON.stringify(golden, null, 2)}\n`;
  if (WRITE_GOLDENS) {
    writeFileSync(goldenPath, rendered);
  } else {
    let pinned;
    try {
      pinned = JSON.parse(readFileSync(goldenPath, "utf8"));
    } catch (error) {
      assert.fail(`missing/unreadable golden ${goldenPath} (${error.message}) — run WRITE_REDUCER_GOLDENS=1 and review the diff`);
    }
    assert.deepEqual(
      JSON.parse(rendered),
      pinned,
      `final-state golden drift for ${scenario} — if intended, regenerate with WRITE_REDUCER_GOLDENS=1 and review the diff`,
    );
    goldensChecked += 1;
  }
}

// ---------------------------------------------------------------------------
// Layer 3 — hand-written adversarial cases (INDEX.md "NOT in this corpus":
// all four mandatory, plus the recommended additions).
// ---------------------------------------------------------------------------

function evt(type, payload) {
  return { type, payload, ts: "2026-07-03T12:00:00.000Z" };
}

function seedView({ active = true, task = syntheticTask("task-A"), ...overrides } = {}) {
  const state = S.createInitialState({ ...READING_SETTINGS });
  const view = S.createTaskView(task, "Claude PTY 1", true);
  S.upsertTaskView(state, view);
  state.activeTaskId = active ? task.id : null;
  Object.assign(view, overrides);
  return { state, view };
}

function hookApproval(overrides = {}) {
  return {
    taskId: "task-A",
    runId: "run-1",
    kind: "command",
    source: "claude-hook-broker",
    answerVia: "reply",
    approvalId: "ask-1",
    summary: "Run `touch x`",
    ...overrides,
  };
}

// 1) MANDATORY — keyed approval:expired (S6-P2): a non-matching approvalId
//    must NOT clear the live card.
{
  const card = hookApproval();
  const { state, view } = seedView({ pendingApproval: card, status: "Waiting for approval" });
  const mismatch = R.reduceRuntimeEvent(
    state,
    evt("approval:expired", { taskId: "task-A", approvalId: "ask-OTHER" }),
    NOW_MS,
  );
  assert.deepEqual(mismatch, [{ kind: "none" }], "non-matching expiry → deliberate no-op");
  assert.equal(view.pendingApproval, card, "non-matching expiry keeps the live card (same ref)");
  assert.equal(view.approvalExpired, false, "no expired flag on a rejected expiry");
  assert.equal(view.status, "Waiting for approval", "status untouched");

  const match = R.reduceRuntimeEvent(
    state,
    evt("approval:expired", { taskId: "task-A", approvalId: "ask-1" }),
    NOW_MS,
  );
  assert.deepEqual(match, [{ kind: "full", taskId: "task-A" }], "matching expiry → full render");
  assert.equal(view.pendingApproval, card, "matching expiry KEEPS the ask (drawer S2: expired variant)");
  assert.equal(view.approvalExpired, true, "…and flips the expired flag");
  assert.equal(view.status, "Waiting in the CLI", "…with the S5 status voice");
}
{
  // Background variant: the expiry marks unread instead of painting.
  const { state, view } = seedView({ active: false, pendingApproval: hookApproval() });
  const d = R.reduceRuntimeEvent(
    state,
    evt("approval:expired", { taskId: "task-A", approvalId: "ask-1" }),
    NOW_MS,
  );
  assert.deepEqual(d, [{ kind: "unread-only", taskId: "task-A" }], "bg expiry → unread-only");
  assert.equal(view.unread, true, "bg expiry sets unread");
}
{
  // No card at all → the keyed guard rejects (undefined !== "ask-1").
  const { state, view } = seedView();
  const d = R.reduceRuntimeEvent(
    state,
    evt("approval:expired", { taskId: "task-A", approvalId: "ask-1" }),
    NOW_MS,
  );
  assert.deepEqual(d, [{ kind: "none" }], "expiry with no card → no-op");
  assert.equal(view.approvalExpired, false, "no expired flag without a card");
}
{
  // MEASURED quirk, pinned: a scrape card carries no approvalId, so a
  // malformed expiry that ALSO lacks one matches (undefined === undefined)
  // and flips the drawer to its expired variant (drawer S2) — today's
  // verbatim keyed-guard semantics.
  const card = hookApproval({ approvalId: undefined, answerVia: undefined, source: "scrape" });
  const { state, view } = seedView({ pendingApproval: card });
  const d = R.reduceRuntimeEvent(state, evt("approval:expired", { taskId: "task-A" }), NOW_MS);
  assert.deepEqual(d, [{ kind: "full", taskId: "task-A" }]);
  assert.equal(view.pendingApproval, card, "undefined-vs-undefined expiry matches (measured)…");
  assert.equal(view.approvalExpired, true, "…and flips the expired variant");
}

// 2) MANDATORY — approval:persisted receipt (receipt-by-observation label).
{
  const { state, view } = seedView();
  const d = R.reduceRuntimeEvent(
    state,
    evt("approval:persisted", {
      taskId: "task-A",
      runId: "run-1",
      file: "/workspace/fixture/.claude/settings.local.json",
      rulesAdded: ["Bash(touch:*)", "Read(//workspace/**)"],
    }),
    NOW_MS,
  );
  assert.deepEqual(d, [{ kind: "full", taskId: "task-A" }]);
  assert.equal(
    view.status,
    "Allow rule saved: Bash(touch:*), Read(//workspace/**) → /workspace/fixture/.claude/settings.local.json",
    "persisted receipt status quotes rules + file verbatim",
  );
}

// 3) MANDATORY — file:watch-error tolerance: no handler, no crash, no state.
{
  const { state } = seedView();
  const before = JSON.stringify(projectState(state));
  const d = R.reduceRuntimeEvent(
    state,
    evt("file:watch-error", { taskId: "task-A", cwd: "/workspace/fixture", mode: "fs.watch", error: "EMFILE" }),
    NOW_MS,
  );
  assert.deepEqual(d, [{ kind: "none" }], "file:watch-error is tolerated, not rendered");
  assert.equal(JSON.stringify(projectState(state)), before, "…and mutates nothing");
}

// 4) MANDATORY — keyed pendingApproval retraction on run:updated settle
//    (fix/dormant-resume 2026-07-03; landed after the corpus was recorded).
function runUpdated(overrides = {}) {
  return evt("run:updated", {
    taskId: "task-A",
    id: "run-1",
    kind: "prompt",
    prompt: "do the thing",
    title: "do the thing",
    status: "completed",
    lifecyclePhase: "completed",
    startedAt: "2026-07-03T11:00:00.000Z",
    endedAt: "2026-07-03T11:01:00.000Z",
    elapsedMs: 60000,
    completionSource: "stop-hook",
    completionConfidence: "high",
    ...overrides,
  });
}
{
  const { state, view } = seedView({
    pendingApproval: hookApproval({ runId: "run-1" }),
    liveTranscriptRunId: "run-1",
  });
  const d = R.reduceRuntimeEvent(state, runUpdated(), NOW_MS);
  assert.deepEqual(d, [{ kind: "full", taskId: "task-A" }]);
  assert.equal(view.pendingApproval, null, "settled run retracts ITS stale approval card");
  assert.equal(view.liveTranscriptRunId, null, "settle clears the live transcript pointer");
}
{
  const other = hookApproval({ runId: "run-2", approvalId: "ask-2" });
  const { state, view } = seedView({ pendingApproval: other });
  R.reduceRuntimeEvent(state, runUpdated(), NOW_MS);
  assert.equal(view.pendingApproval, other, "another run's card survives the settle (keyed)");
}
{
  const card = hookApproval({ runId: null });
  const { state, view } = seedView({ pendingApproval: card });
  R.reduceRuntimeEvent(state, runUpdated(), NOW_MS);
  assert.equal(view.pendingApproval, card, "a run-less (scrape) card survives too (null ≠ id)");
}
{
  const card = hookApproval({ runId: "run-1" });
  const { state, view } = seedView({ pendingApproval: card, liveTranscriptRunId: "run-1" });
  R.reduceRuntimeEvent(state, runUpdated({ status: "waiting-for-approval" }), NOW_MS);
  assert.equal(view.pendingApproval, card, "an ACTIVE-status update retracts nothing");
  assert.equal(view.liveTranscriptRunId, "run-1", "…and keeps the live pointer");
}
{
  // Background settle: the fourth sidebar state, finished-while-away.
  const { state, view } = seedView({ active: false });
  const d = R.reduceRuntimeEvent(state, runUpdated(), NOW_MS);
  assert.deepEqual(d, [{ kind: "unread-only", taskId: "task-A" }]);
  assert.equal(view.completedUnseen, true, "bg settle → completedUnseen");
  assert.equal(view.unread, true, "bg settle → unread");
}
{
  // Slash settle raises the passive attention pointer (first line only).
  const { state, view } = seedView();
  R.reduceRuntimeEvent(
    state,
    runUpdated({ kind: "slash", prompt: "/compact\nplus trailing detail" }),
    NOW_MS,
  );
  assert.deepEqual(
    view.slashAttention,
    { runId: "run-1", command: "/compact" },
    "slash-completed → slashAttention pointer with the command's first line",
  );
}

// 5) Recommended — option-prompt resolved-with-null (cancel).
function optionPrompt() {
  return {
    taskId: "task-A",
    toolUseId: "tu-1",
    questions: [
      {
        header: "Approach",
        question: "Which approach?",
        multiSelect: false,
        options: [{ label: "Plan A" }, { label: "Plan B" }],
      },
    ],
  };
}
{
  // A superseding prompt resets the WHOLE stepper: drafts AND step (S2 review
  // B1 — a stale step from a previous answered prompt opened the new drawer
  // on Review/out-of-range).
  const { state, view } = seedView({ optionPromptStep: 3, optionPromptReceipt: null });
  R.reduceRuntimeEvent(
    state,
    evt("option-prompt:detected", {
      taskId: "task-A",
      toolUseId: "tu-9",
      questions: optionPrompt().questions,
    }),
    NOW_MS,
  );
  assert.equal(view.optionPromptStep, 0, "detected resets the stepper to Q1");
  assert.deepEqual(
    view.optionPromptDrafts,
    [{ optionIndices: [], text: null }],
    "detected resets the drafts",
  );
}
{
  const { state, view } = seedView({
    pendingOptionPrompt: optionPrompt(),
    optionPromptDrafts: [{ optionIndices: [], text: null }],
    optionPromptBusy: true,
    status: "Claude is asking",
  });
  const d = R.reduceRuntimeEvent(
    state,
    evt("option-prompt:resolved", { taskId: "task-A", toolUseId: "tu-1", answers: null }),
    NOW_MS,
  );
  assert.deepEqual(d, [{ kind: "full", taskId: "task-A" }]);
  assert.equal(view.pendingOptionPrompt, null, "cancel drops the live form");
  assert.equal(view.optionPromptBusy, false, "cancel clears busy");
  assert.equal(view.status, "Ready", "cancel status");
}
{
  // MEASURED quirk, pinned: a null-answers resolve for a DIFFERENT toolUseId
  // keeps the form but still repaints (markViewChanged sat outside the guard).
  const prompt = optionPrompt();
  const { state, view } = seedView({ pendingOptionPrompt: prompt, optionPromptBusy: true });
  const d = R.reduceRuntimeEvent(
    state,
    evt("option-prompt:resolved", { taskId: "task-A", toolUseId: "tu-OTHER", answers: null }),
    NOW_MS,
  );
  assert.deepEqual(d, [{ kind: "full", taskId: "task-A" }], "mismatched cancel still repaints (measured)");
  assert.equal(view.pendingOptionPrompt, prompt, "…but keeps the live form");
  assert.equal(view.optionPromptBusy, true, "…and its busy flag");
}
{
  // Cancel keeps a receipt already shown from a completed answer.
  const receipt = { toolUseId: "tu-0", reconciled: true, lines: [] };
  const { state, view } = seedView({ optionPromptReceipt: receipt });
  R.reduceRuntimeEvent(
    state,
    evt("option-prompt:resolved", { taskId: "task-A", toolUseId: "tu-1", answers: null }),
    NOW_MS,
  );
  assert.equal(view.optionPromptReceipt, receipt, "cancel keeps the prior receipt");
}
{
  // Answered: the receipt reconciles from the provider's verbatim answers.
  const { state, view } = seedView({
    pendingOptionPrompt: optionPrompt(),
    optionPromptDrafts: [{ optionIndices: [0], text: null }],
    optionPromptBusy: true,
  });
  const d = R.reduceRuntimeEvent(
    state,
    evt("option-prompt:resolved", {
      taskId: "task-A",
      toolUseId: "tu-1",
      answers: { "Which approach?": ["Plan B"] },
    }),
    NOW_MS,
  );
  assert.deepEqual(d, [{ kind: "full", taskId: "task-A" }]);
  assert.deepEqual(view.optionPromptReceipt, {
    toolUseId: "tu-1",
    reconciled: true,
    lines: [{ header: "Approach", question: "Which approach?", labels: ["Plan B"] }],
  });
  assert.equal(view.pendingOptionPrompt, null);
  assert.equal(view.status, "Answered");
}

// 6) Recommended — malformed-payload tolerance.
{
  const { state } = seedView();
  const before = JSON.stringify(projectState(state));
  const unknown = R.reduceRuntimeEvent(
    state,
    evt("mystery:event", { taskId: "task-A", anything: 1 }),
    NOW_MS,
  );
  assert.deepEqual(unknown, [{ kind: "none" }], "unknown event type for a loaded view → none");
  assert.equal(JSON.stringify(projectState(state)), before, "…without mutation");

  const noTask = R.reduceRuntimeEvent(state, evt("task:updated", {}), NOW_MS);
  assert.deepEqual(noTask, [], "payload without taskId → dropped");

  const strayTask = R.reduceRuntimeEvent(
    state,
    evt("run:started", { taskId: "task-UNLOADED", id: "run-9", title: "x", status: "active" }),
    NOW_MS,
  );
  assert.deepEqual(strayTask, [], "unloaded taskId → dropped (views come from IPC, not events)");
}
{
  // pty:data with no live run appends nothing and schedules nothing — but the
  // background unread cue still fires (it precedes the append).
  const { state, view } = seedView({ active: false });
  const d = R.reduceRuntimeEvent(
    state,
    evt("pty:data", { taskId: "task-A", data: "hello", seq: 0 }),
    NOW_MS,
  );
  assert.deepEqual(d, [{ kind: "none" }], "no live run → no transcript schedule");
  assert.equal(view.unread, true, "…but a bg chunk still marks unread (measured)");
  assert.equal(view.runTranscripts.length, 0, "…and no transcript was created");
}

// 7) Recommended — usage-in-place payload flags (chip change + open popover).
{
  const snapshot = (modelDisplayName) => ({
    provider: "claude",
    capturedAt: NOW_MS,
    context: null,
    limits: [],
    modelDisplayName,
    reasoningEffort: "high",
  });
  const { state, view } = seedView();
  const first = R.reduceRuntimeEvent(
    state,
    evt("usage:updated", { taskId: "task-A", snapshot: snapshot("Sonnet 4.6") }),
    NOW_MS,
  );
  assert.deepEqual(
    first,
    [{ kind: "usage-in-place", taskId: "task-A", chipChanged: true, popoverOpen: false }],
    "statusline model differs from spawn fallback → chipChanged",
  );
  const same = R.reduceRuntimeEvent(
    state,
    evt("usage:updated", { taskId: "task-A", snapshot: snapshot("Sonnet 4.6") }),
    NOW_MS,
  );
  assert.deepEqual(
    same,
    [{ kind: "usage-in-place", taskId: "task-A", chipChanged: false, popoverOpen: false }],
    "same summary → no chip repaint",
  );
  state.usagePopover = { pinned: false };
  const open = R.reduceRuntimeEvent(
    state,
    evt("usage:updated", { taskId: "task-A", snapshot: snapshot("Opus 4.8") }),
    NOW_MS,
  );
  assert.deepEqual(
    open,
    [{ kind: "usage-in-place", taskId: "task-A", chipChanged: true, popoverOpen: true }],
    "open popover rides the same in-place directive",
  );
  state.usagePopover = null;

  state.activeTaskId = null;
  const bg = R.reduceRuntimeEvent(
    state,
    evt("usage:updated", { taskId: "task-A", snapshot: snapshot("Haiku 4.5") }),
    NOW_MS,
  );
  assert.deepEqual(bg, [{ kind: "none" }], "background usage tick just stores");
  assert.equal(view.usageSnapshot.modelDisplayName, "Haiku 4.5", "…the snapshot");
  assert.equal(view.unread, false, "a usage tick is never unread");
}

// 8) Recommended — run:started housekeeping + clock-injected title adopt.
{
  const { state, view } = seedView({
    pendingOptionPrompt: optionPrompt(),
    optionPromptReceipt: { toolUseId: "tu-0", reconciled: true, lines: [] },
    optionPromptBusy: true,
    slashAttention: { runId: "run-0", command: "/compact" },
    completedUnseen: true,
  });
  const d = R.reduceRuntimeEvent(
    state,
    evt("run:started", {
      taskId: "task-A",
      id: "run-7",
      kind: "prompt",
      prompt: "Fix the flaky test",
      title: "Fix the flaky test",
      status: "active",
      lifecyclePhase: "active",
      startedAt: "2026-07-03T11:30:00.000Z",
      endedAt: null,
      elapsedMs: null,
      completionSource: null,
      completionConfidence: null,
    }),
    NOW_MS,
  );
  assert.deepEqual(d, [{ kind: "full", taskId: "task-A" }]);
  assert.equal(view.status, "Running");
  assert.equal(view.liveTranscriptRunId, "run-7");
  assert.equal(view.pendingOptionPrompt, null, "a new run moots the option prompt");
  assert.equal(view.optionPromptReceipt, null, "…and its receipt");
  assert.equal(view.optionPromptBusy, false);
  assert.equal(view.slashAttention, null, "…and the slash pointer");
  assert.equal(view.completedUnseen, false);
  assert.equal(view.runTranscripts.at(-1)?.runId, "run-7", "run transcript ensured");
  assert.equal(view.task.title, "Fix the flaky test", "placeholder title auto-adopts");
  assert.equal(
    view.task.updatedAt,
    new Date(NOW_MS).toISOString(),
    "…stamped with the injected clock",
  );
}
{
  // A non-placeholder title never auto-adopts.
  const task = { ...syntheticTask("task-A"), title: "My named session" };
  const { state, view } = seedView({ task });
  R.reduceRuntimeEvent(
    state,
    evt("run:started", { taskId: "task-A", id: "run-8", title: "Different", status: "active" }),
    NOW_MS,
  );
  assert.equal(view.task.title, "My named session", "user titles are never overwritten");
  assert.equal(view.task, task, "…and the task object is not replaced (same ref)");
}
{
  // A new dated automatic title keeps its creation prefix and ownership.
  const task = {
    ...syntheticTask("task-A"),
    title: "0703-New task",
    titleOrigin: "automatic",
  };
  const { state, view } = seedView({ task });
  R.reduceRuntimeEvent(
    state,
    evt("run:started", { taskId: "task-A", id: "run-dated", title: "Research", status: "active" }),
    NOW_MS,
  );
  assert.equal(view.task.title, "0703-Research", "dated automatic title preserves prefix");
  assert.equal(view.task.titleOrigin, "automatic", "automatic ownership survives adoption");
}
{
  // A user-owned automatic-looking title is never replaced.
  const task = {
    ...syntheticTask("task-A"),
    title: "0703-New task",
    titleOrigin: "user",
  };
  const { state, view } = seedView({ task });
  R.reduceRuntimeEvent(
    state,
    evt("run:started", { taskId: "task-A", id: "run-user", title: "Research", status: "active" }),
    NOW_MS,
  );
  assert.equal(view.task, task, "user-owned title keeps object identity and content");
}

// 9) Recommended — working-status liveness edges.
function workingStatus(liveness) {
  return evt("working-status:updated", {
    taskId: "task-A",
    native: { text: "Working…" },
    liveness,
    silentSince: null,
    capturedAt: "2026-07-03T12:00:00.000Z",
  });
}
{
  // First-ever event at liveness "fresh" is NOT a transition (the null
  // coalesce defaults to "fresh") — it takes the in-place tick path.
  const { state } = seedView();
  const first = R.reduceRuntimeEvent(state, workingStatus("fresh"), NOW_MS);
  assert.deepEqual(first, [{ kind: "strip-in-place", taskId: "task-A" }], "fresh-first = tick (measured)");
  const toQuiet = R.reduceRuntimeEvent(state, workingStatus("quiet"), NOW_MS);
  assert.deepEqual(
    toQuiet,
    [{ kind: "strip-full", taskId: "task-A", statusStrip: true }],
    "fresh→quiet transition, active → spinner + strip",
  );
}
{
  const { state, view } = seedView({ active: false });
  const transition = R.reduceRuntimeEvent(state, workingStatus("quiet"), NOW_MS);
  assert.deepEqual(
    transition,
    [{ kind: "strip-full", taskId: "task-A", statusStrip: false }],
    "bg transition still patches the sidebar spinner, never the strip",
  );
  const tick = R.reduceRuntimeEvent(state, workingStatus("quiet"), NOW_MS);
  assert.deepEqual(tick, [{ kind: "none" }], "bg tick is a pure store");
  assert.equal(view.unread, false, "working status is never unread");
}

// 10) Recommended — cli-state transition edges.
{
  const { state, view } = seedView();
  const first = R.reduceRuntimeEvent(
    state,
    evt("cli-state:changed", { taskId: "task-A", activity: "busy", tool: null, approvalKind: null, source: "hook", changedAt: "2026-07-03T12:00:00.000Z" }),
    NOW_MS,
  );
  assert.deepEqual(first, [{ kind: "sidebar", taskId: "task-A" }], "null→busy is a transition");
  const toolOnly = R.reduceRuntimeEvent(
    state,
    evt("cli-state:changed", { taskId: "task-A", activity: "busy", tool: "Bash", approvalKind: null, source: "hook", changedAt: "2026-07-03T12:00:01.000Z" }),
    NOW_MS,
  );
  assert.deepEqual(toolOnly, [{ kind: "none" }], "tool-only change must not rebuild (S0)");
  assert.equal(view.cliState.tool, "Bash", "…though the tool is stored");
  assert.equal(view.unread, false, "cli activity is never unread content");
}

// 11) Contract fence (S1 INV-2 consumer side) — transcript:blocks reset is
//     SOURCE-SCOPED: it drops ONLY blocks of the reset's sourceId, leaving a
//     concurrent source's blocks on the same task untouched (audit A1.5;
//     applyTranscriptUpserts, state.ts:448-469). A task holds multiple sources
//     (/clear, resume chains), so a source's own re-drain must never wipe the
//     others. Frozen 2026-07-07 (Product/sonata-eink/docs/contracts-v2.md Part A).
{
  const blk = (id, sourceId) => ({
    kind: "assistant-text",
    id,
    taskId: "task-A",
    sourceId,
    provider: "claude",
    turnKey: `${sourceId}:t1`,
    runId: null,
    ts: "2026-07-03T12:00:00.000Z",
    seq: 0,
    markdown: id,
  });
  const blocks = (sourceId, reset, upserts) =>
    evt("transcript:blocks", { taskId: "task-A", sourceId, reset, upserts });

  const { state, view } = seedView();
  // Two sources land their initial drains (each a source-scoped reset).
  R.reduceRuntimeEvent(state, blocks("src-A", true, [blk("A1", "src-A"), blk("A2", "src-A")]), NOW_MS);
  R.reduceRuntimeEvent(state, blocks("src-B", true, [blk("B1", "src-B")]), NOW_MS);
  assert.deepEqual(view.transcriptBlockOrder, ["A1", "A2", "B1"], "both sources' blocks are present");

  // Source A re-drains (truncation/replacement): reset must drop A1/A2 ONLY.
  const d = R.reduceRuntimeEvent(state, blocks("src-A", true, [blk("A3", "src-A")]), NOW_MS);
  assert.deepEqual(d, [{ kind: "transcript-debounced", taskId: "task-A" }], "active view schedules the transcript render");
  assert.equal(view.transcriptBlocks.has("A1"), false, "source A's stale blocks dropped");
  assert.equal(view.transcriptBlocks.has("A2"), false, "source A's stale blocks dropped");
  assert.equal(view.transcriptBlocks.has("B1"), true, "the OTHER source survives its sibling's reset");
  assert.deepEqual(view.transcriptBlockOrder, ["B1", "A3"], "surviving-then-fresh order, no stale ids");
}

// 12) control-switch:state — the phases NOT in the corpus (S1 model/effort,
//     S2 permission). The chip's value follows its own SSOT (statusline for
//     model/effort, hook payload for permission), so these only drive the pending
//     affordance / needs-attention banner / failure notice / reachable-modes set,
//     never the chip label itself.
{
  const switchEvt = (phase, extra = {}) =>
    evt("control-switch:state", {
      taskId: "task-A",
      kind: "model",
      value: "sonnet",
      phase,
      error: null,
      ...extra,
    });

  // pending → records the in-flight switch (dims the chip); full render active.
  {
    const { state, view } = seedView();
    const d = R.reduceRuntimeEvent(state, switchEvt("pending"), NOW_MS);
    assert.deepEqual(d, [{ kind: "full", taskId: "task-A" }], "pending → full render");
    assert.deepEqual(
      view.controlSwitch,
      { kind: "model", value: "sonnet", phase: "pending" },
      "pending records the in-flight switch",
    );
  }

  // settled → clears the pending affordance (the statusline drives the label).
  {
    const { state, view } = seedView({
      controlSwitch: { kind: "model", value: "sonnet", phase: "pending" },
    });
    const d = R.reduceRuntimeEvent(state, switchEvt("settled"), NOW_MS);
    assert.deepEqual(d, [{ kind: "full", taskId: "task-A" }], "settled → full render");
    assert.equal(view.controlSwitch, null, "settled drops the pending affordance");
  }

  // failed → clears the affordance and reports a one-line composer notice.
  {
    const { state, view } = seedView({
      controlSwitch: { kind: "model", value: "bogus", phase: "pending" },
      status: "Running",
    });
    const d = R.reduceRuntimeEvent(
      state,
      switchEvt("failed", { value: "bogus", error: "Claude rejected the model \"bogus\"." }),
      NOW_MS,
    );
    assert.deepEqual(d, [{ kind: "full", taskId: "task-A" }], "failed → full render");
    assert.equal(view.controlSwitch, null, "failed clears the pending affordance");
    assert.equal(view.status, 'Claude rejected the model "bogus".', "failed surfaces the reason as status");
  }

  // failed with no error string → a safe default notice.
  {
    const { state, view } = seedView();
    R.reduceRuntimeEvent(state, switchEvt("failed", { error: null }), NOW_MS);
    assert.equal(view.status, "Couldn't switch — Claude rejected it.", "failed falls back to a default notice");
  }

  // needs-attention → the RED LINE banner pointer; nothing else happens.
  {
    const { state, view } = seedView({ status: "Ready" });
    const d = R.reduceRuntimeEvent(
      state,
      switchEvt("needs-attention", { kind: "effort", value: "high" }),
      NOW_MS,
    );
    assert.deepEqual(d, [{ kind: "full", taskId: "task-A" }], "needs-attention → full render");
    assert.deepEqual(
      view.controlSwitch,
      { kind: "effort", value: "high", phase: "needs-attention" },
      "needs-attention records the pointer for the banner",
    );
    assert.equal(view.status, "Ready", "needs-attention does not overwrite status (banner carries it)");
  }

  // Permission axis (S2): pending records a permission-kind pointer (dims the
  // ACCESS chip); settled clears it. The label follows the hook payload, not this.
  {
    const { state, view } = seedView();
    R.reduceRuntimeEvent(
      state,
      switchEvt("pending", { kind: "permission", value: "plan" }),
      NOW_MS,
    );
    assert.deepEqual(
      view.controlSwitch,
      { kind: "permission", value: "plan", phase: "pending" },
      "a permission switch records a permission-kind pointer",
    );
    R.reduceRuntimeEvent(
      state,
      switchEvt("settled", { kind: "permission", value: "plan", observedModes: ["plan"] }),
      NOW_MS,
    );
    assert.equal(view.controlSwitch, null, "permission settled drops the pending affordance");
  }

  // Codex permission axis (S3): pending records a codex-permission-kind pointer
  // (dims the ACCESS chip on a codex session); settled clears it. UNLIKE claude,
  // the label follows this event's mirror (the controller writes
  // task.codexPermissionMode off the picker receipt) — but the reducer's job here
  // is only the pending affordance, so it carries no observedModes.
  {
    const { state, view } = seedView();
    R.reduceRuntimeEvent(
      state,
      switchEvt("pending", { kind: "codex-permission", value: "approve-for-me" }),
      NOW_MS,
    );
    assert.deepEqual(
      view.controlSwitch,
      { kind: "codex-permission", value: "approve-for-me", phase: "pending" },
      "a codex permission switch records a codex-permission-kind pointer",
    );
    R.reduceRuntimeEvent(
      state,
      switchEvt("settled", { kind: "codex-permission", value: "approve-for-me" }),
      NOW_MS,
    );
    assert.equal(view.controlSwitch, null, "codex-permission settled drops the pending affordance");
    // The codex axis never touches the claude reachable-modes set.
    assert.deepEqual(
      view.observedPermissionModes,
      [],
      "codex-permission carries no observedModes — the claude reachable set is untouched",
    );
  }

  // Codex Full Access consent gate (RED LINE 2): the choreography rolls back →
  // needs-attention (the RED LINE banner pointer), never a silent settle.
  {
    const { state, view } = seedView({ status: "Ready" });
    R.reduceRuntimeEvent(
      state,
      switchEvt("needs-attention", { kind: "codex-permission", value: "full-access" }),
      NOW_MS,
    );
    assert.deepEqual(
      view.controlSwitch,
      { kind: "codex-permission", value: "full-access", phase: "needs-attention" },
      "a rolled-back codex Full Access switch records the needs-attention pointer",
    );
  }

  // observedModes MERGE (D4 — reachable-modes set grows, never shrinks): a
  // choreography that confirmed `auto` en route teaches the menu auto exists,
  // on BOTH settle and needs-attention, de-duplicated and order-stable.
  {
    const { state, view } = seedView();
    assert.deepEqual(view.observedPermissionModes, [], "seed: synthetic task has null mode → empty set");
    R.reduceRuntimeEvent(
      state,
      switchEvt("needs-attention", { kind: "permission", value: "plan", observedModes: ["default", "auto"] }),
      NOW_MS,
    );
    assert.deepEqual(
      view.observedPermissionModes,
      ["default", "auto"],
      "needs-attention still merges the modes seen en route",
    );
    R.reduceRuntimeEvent(
      state,
      switchEvt("settled", { kind: "permission", value: "acceptEdits", observedModes: ["auto", "acceptEdits"] }),
      NOW_MS,
    );
    assert.deepEqual(
      view.observedPermissionModes,
      ["default", "auto", "acceptEdits"],
      "merge de-dupes (auto) and appends the new mode (acceptEdits), order-stable",
    );
  }

  // task:updated reconciling permission_mode adds the mode to the reachable set
  // (how a native Shift+Tab to the account-gated `auto` becomes menu-eligible).
  {
    const { state, view } = seedView();
    R.reduceRuntimeEvent(
      state,
      evt("task:updated", {
        taskId: "task-A",
        task: { ...syntheticTask("task-A"), permissionMode: "auto" },
        reason: "runtime-status",
      }),
      NOW_MS,
    );
    assert.deepEqual(
      view.observedPermissionModes,
      ["auto"],
      "a hook reconcile to auto records it as reachable",
    );
  }

  // A new run moots any lingering switch pointer (pending or needs-attention).
  {
    const { state, view } = seedView({
      active: false,
      controlSwitch: { kind: "model", value: "sonnet", phase: "needs-attention" },
    });
    R.reduceRuntimeEvent(
      state,
      evt("run:started", {
        taskId: "task-A",
        id: "run-2",
        kind: "prompt",
        prompt: "next",
        title: "next",
        status: "running",
        lifecyclePhase: "running",
        startedAt: "2026-07-03T12:00:00.000Z",
        endedAt: null,
        elapsedMs: null,
        completionSource: null,
        completionConfidence: null,
      }),
      NOW_MS,
    );
    assert.equal(view.controlSwitch, null, "a new run clears the stale switch pointer");
  }

  // Background variant: a switch phase on an unfocused view marks unread.
  {
    const { state, view } = seedView({ active: false });
    const d = R.reduceRuntimeEvent(state, switchEvt("pending"), NOW_MS);
    assert.deepEqual(d, [{ kind: "unread-only", taskId: "task-A" }], "bg switch → unread-only");
    assert.equal(view.unread, true, "bg switch marks unread");
  }

  // pty:exit (S1 review fix B): a crash mid-switch drops the pointer so the chip
  // can't stay stuck in "Switching…" — but ONLY when something was pending, so
  // the corpus oracle's pty:exit → none stays correct.
  const ptyExit = () =>
    evt("pty:exit", {
      taskId: "task-A",
      generation: 1,
      runId: null,
      exitCode: 1,
      signal: null,
      elapsedMs: 1234,
    });
  {
    const { state, view } = seedView({
      controlSwitch: { kind: "model", value: "sonnet", phase: "needs-attention" },
    });
    const d = R.reduceRuntimeEvent(state, ptyExit(), NOW_MS);
    assert.deepEqual(d, [{ kind: "full", taskId: "task-A" }], "pty:exit with a pending switch → full render");
    assert.equal(view.controlSwitch, null, "pty:exit clears the stuck switch pointer");
  }
  {
    const { state, view } = seedView();
    const d = R.reduceRuntimeEvent(state, ptyExit(), NOW_MS);
    assert.deepEqual(d, [{ kind: "none" }], "pty:exit with no switch → deliberate no-op (corpus oracle unchanged)");
    assert.equal(view.controlSwitch, null, "…and leaves controlSwitch null");
  }
}

if (WRITE_GOLDENS) {
  console.log(
    `reading-runtime-reducer: goldens REGENERATED for ${scenarios.length} scenarios (${totalEvents} events replayed ×2 variants) — review the diff before committing`,
  );
} else {
  console.log(
    `reading-runtime-reducer: ${scenarios.length} scenarios / ${totalEvents} events replayed ×2 variants against the directive oracle; ${goldensChecked} goldens verified; adversarial cases pass`,
  );
}
