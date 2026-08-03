import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Fixture tables for the turn selectors (map step B1): turn grouping +
// notification-run suppression + husk fallback text in buildReadingTurns,
// sig stability/flip + block-ref versioning via a FRESH tracker per fixture
// (createTurnSignatureTracker), and the status strip's transcript-derived
// selectors. Assertions pin MEASURED behavior (A1 lesson).
const require = createRequire(import.meta.url);
const T = require("../../dist/reading-core/selectors/turns");

let seq = 0;
function block(kind, turnKey, runId, extra = {}) {
  seq += 1;
  return {
    id: `b${seq}`,
    taskId: "task-1",
    sourceId: "src-1",
    provider: "claude",
    turnKey,
    runId,
    ts: extra.ts ?? `2026-07-03T10:00:${String(seq).padStart(2, "0")}.000Z`,
    seq,
    kind,
    ...extra,
  };
}

function run(runId, extra = {}) {
  return {
    runId,
    prompt: `prompt for ${runId}`,
    status: "completed",
    startedAt: "2026-07-03T09:00:00.000Z",
    endedAt: "2026-07-03T09:01:00.000Z",
    completionSource: "structured",
    stopEvents: [],
    ...extra,
  };
}

function view({ runs = [], blocks = [], runTranscripts = [] } = {}) {
  return {
    report: runs.length > 0 ? { runs } : null,
    transcriptBlockOrder: blocks.map((b) => b.id),
    transcriptBlocks: new Map(blocks.map((b) => [b.id, b])),
    runTranscripts,
  };
}

// 1) buildReadingTurns — grouping, run attribution, and time ordering.
{
  const r1 = run("run-1", { startedAt: "2026-07-03T10:00:00.000Z" });
  const b1 = block("user-message", "t1", "run-1", {
    text: "hello",
    command: null,
    attachments: [],
    ts: "2026-07-03T10:00:01.000Z",
  });
  const b2 = block("assistant-text", "t1", "run-1", {
    markdown: "hi",
    ts: "2026-07-03T10:00:02.000Z",
  });
  const b3 = block("assistant-text", "t2", null, {
    markdown: "later turn",
    ts: "2026-07-03T11:00:00.000Z",
  });
  const turns = T.buildReadingTurns(view({ runs: [r1], blocks: [b1, b2, b3] }));
  assert.equal(turns.length, 2, "two turn groups");
  assert.equal(turns[0].key, "src-1:t1", "group key = sourceId:turnKey");
  assert.equal(turns[0].runId, "run-1", "run attributed from first block with runId");
  assert.equal(turns[0].run, r1, "run object joined by reference");
  assert.deepEqual(
    turns[0].blocks.map((b) => b.id),
    [b1.id, b2.id],
    "blocks keep transcriptBlockOrder within the group",
  );
  assert.equal(turns[0].fallbackText, null, "block-backed turn has no fallback");
  assert.equal(turns[0].tsMs, Date.parse(b1.ts), "turn ts = first block ts");
  assert.equal(turns[1].key, "src-1:t2", "unattributed turn still renders");
  assert.equal(turns[1].run, null, "no run joined without runId");
}

// 2) Unmatched runs — husk turns with transcript fallback text.
{
  const r1 = run("run-1", { startedAt: "2026-07-03T10:00:00.000Z" });
  const r2 = run("run-2", { startedAt: "2026-07-03T10:30:00.000Z" });
  const turns = T.buildReadingTurns(
    view({
      runs: [r1, r2],
      runTranscripts: [
        { runId: "run-1", rawText: "", text: "scraped reply\n\n", truncated: false, receivedChars: 15 },
        { runId: "run-2", rawText: "", text: "", truncated: false, receivedChars: 0 },
      ],
    }),
  );
  assert.equal(turns.length, 2, "each unmatched run becomes a husk turn");
  assert.equal(turns[0].key, "run:run-1", "husk key = run:<id>");
  assert.equal(turns[0].fallbackText, "scraped reply", "fallback = transcript text trimEnd");
  assert.equal(turns[1].fallbackText, null, "empty transcript text → null (|| null)");
  assert.equal(turns[0].tsMs, Date.parse(r1.startedAt), "husk ts = run startedAt");
}

// 3) Notification-run suppression — prefix-keyed, wakeups stay visible.
{
  const notif = run("run-n", {
    prompt: "  <task-notification>task-abc done</task-notification>",
    startedAt: "2026-07-03T10:00:00.000Z",
  });
  const wakeupA = run("run-w1", { prompt: "wakeup tick", startedAt: "2026-07-03T10:01:00.000Z" });
  const wakeupB = run("run-w2", { prompt: "wakeup tick", startedAt: "2026-07-03T10:02:00.000Z" });
  const turns = T.buildReadingTurns(view({ runs: [notif, wakeupA, wakeupB] }));
  assert.deepEqual(
    turns.map((t) => t.runId),
    ["run-w1", "run-w2"],
    "task-notification husk suppressed (leading whitespace included); identical-text wakeups both visible",
  );
}

// 4) Matched runs are not duplicated as husks; sort is by tsMs ascending.
{
  const r1 = run("run-1", { startedAt: "2026-07-03T12:00:00.000Z" });
  const b1 = block("assistant-text", "t1", "run-1", {
    markdown: "x",
    ts: "2026-07-03T12:00:05.000Z",
  });
  const early = run("run-0", { startedAt: "2026-07-03T09:00:00.000Z" });
  const turns = T.buildReadingTurns(view({ runs: [r1, early], blocks: [b1] }));
  assert.deepEqual(
    turns.map((t) => t.key),
    ["run:run-0", "src-1:t1"],
    "husk of the earlier run sorts before the later block turn",
  );
}

// 4b) Compaction boundary (S7): the marker groups into its OWN turn and is
// recognized by isCompactionTurn so the renderer draws a separator, not a husk.
{
  // Claude shape: a prior reply turn, then a compaction marker on its dedicated
  // `compact-<uuid>` key, then a post-compact turn.
  const reply = block("assistant-text", "t1", "run-1", {
    markdown: "one json object per line",
    ts: "2026-07-03T10:00:00.000Z",
  });
  const marker = block("compaction", "compact-abc", null, {
    trigger: "manual",
    ts: "2026-07-03T10:01:00.000Z",
  });
  const post = block("user-message", "t2", null, {
    text: "next",
    command: null,
    attachments: [],
    ts: "2026-07-03T10:02:00.000Z",
  });
  const turns = T.buildReadingTurns(view({ blocks: [reply, marker, post] }));
  assert.equal(turns.length, 3, "the marker is its own turn group, between the two turns");
  const markerTurn = turns.find((t) => t.key === "src-1:compact-abc");
  assert.ok(markerTurn, "marker turn keyed by sourceId:compact-<uuid>");
  assert.equal(markerTurn.blocks.length, 1, "the marker turn holds only the compaction block");
  assert.equal(
    T.isCompactionTurn(markerTurn),
    true,
    "a compaction-only turn is recognized as a marker (renders as a separator)",
  );
  // The two conversational turns are NOT compaction turns.
  assert.equal(T.isCompactionTurn(turns.find((t) => t.key === "src-1:t1")), false);
  assert.equal(T.isCompactionTurn(turns.find((t) => t.key === "src-1:t2")), false);
}

// 4c) PHANTOM-HUSK REGRESSION (mirrors S6): a marker folded into a real turn
// must NOT be a compaction turn — else the renderer would suppress the whole
// turn (its reply) behind a separator. isCompactionTurn is exact, not "contains
// a compaction block".
{
  const reply = block("assistant-text", "tX", "run-9", { markdown: "answer", ts: "2026-07-03T10:00:00.000Z" });
  const strayMarker = block("compaction", "tX", null, { trigger: null, ts: "2026-07-03T10:00:01.000Z" });
  const turns = T.buildReadingTurns(view({ blocks: [reply, strayMarker] }));
  assert.equal(turns.length, 1, "same turnKey → one group");
  assert.equal(
    T.isCompactionTurn(turns[0]),
    false,
    "a turn mixing a reply and a compaction block is NOT a compaction turn — the reply must render",
  );
  // And an empty turn is never a compaction turn (guards the length>0 clause).
  assert.equal(T.isCompactionTurn({ blocks: [] }), false, "empty turn is not a compaction turn");
}

// 4d) Degraded compaction boundary (SL-7 / codex #36642): a marker whose source
// record carried no summary item renders as the WARNING variant of the same
// separator. The field is optional and absent on every record the normalizer
// could not fully assess, so absence must read as "nothing to report" — the
// calm marker — and never as a warning.
{
  const degraded = block("compaction", "compact-lost", null, {
    provider: "codex",
    trigger: null,
    integrity: "summary-missing",
    ts: "2026-07-03T10:01:00.000Z",
  });
  const healthy = block("compaction", "compact-ok", null, {
    provider: "codex",
    trigger: null,
    ts: "2026-07-03T10:02:00.000Z",
  });
  const turns = T.buildReadingTurns(view({ blocks: [degraded, healthy] }));
  const degradedTurn = turns.find((t) => t.key === "src-1:compact-lost");
  const healthyTurn = turns.find((t) => t.key === "src-1:compact-ok");
  // Both are still compaction turns: the warning ADDS to the separator, it does
  // not replace it (a degraded boundary must never fall back to a husk card).
  assert.equal(T.isCompactionTurn(degradedTurn), true);
  assert.equal(T.isCompactionTurn(healthyTurn), true);
  assert.equal(
    T.isDegradedCompactionTurn(degradedTurn),
    true,
    "a marker carrying the measured signature drives the warning variant",
  );
  assert.equal(
    T.isDegradedCompactionTurn(healthyTurn),
    false,
    "a marker with no integrity field draws the calm separator (absence ≠ warning)",
  );
  // Claude never carries the field; and a non-compaction block can never forge
  // the warning, whatever it holds.
  const claudeMarker = block("compaction", "compact-claude", null, { trigger: "auto" });
  const forger = block("system-note", "tF", null, { text: "note", integrity: "summary-missing" });
  assert.equal(T.isDegradedCompactionTurn({ blocks: [claudeMarker] }), false);
  assert.equal(T.isDegradedCompactionTurn({ blocks: [forger] }), false);
  assert.equal(T.isDegradedCompactionTurn({ blocks: [] }), false);
}

// 4e) MID-TURN auto-compaction — the placement that actually dominates. MEASURED:
// of 49 real `compacted` records in local rollouts (0.142.5 → 0.146.0-alpha.3.1),
// 40 have NO `task_started` before them, so the marker joins the LIVE turn and
// isCompactionTurn is false there. The calm marker renders as nothing in that
// turn (S7, unchanged) — but the warning must not, or the slice would be
// invisible in exactly the case #36642 breaks. It reaches the card as an answer
// block instead, in seq order, where the compaction interrupted the reply.
{
  const prompt = block("user-message", "t1", "run-1", {
    text: "do the thing",
    command: null,
    attachments: [],
    ts: "2026-07-03T10:00:00.000Z",
  });
  const before = block("assistant-text", "t1", "run-1", {
    markdown: "working on it",
    ts: "2026-07-03T10:00:01.000Z",
  });
  const midTurnMarker = block("compaction", "t1", null, {
    provider: "codex",
    trigger: null,
    integrity: "summary-missing",
    ts: "2026-07-03T10:00:02.000Z",
  });
  const after = block("assistant-text", "t1", "run-1", {
    markdown: "done",
    ts: "2026-07-03T10:00:03.000Z",
  });
  const turns = T.buildReadingTurns(view({ blocks: [prompt, before, midTurnMarker, after] }));
  assert.equal(turns.length, 1, "a mid-turn compaction does not fork the turn");
  assert.equal(
    T.isCompactionTurn(turns[0]),
    false,
    "the mixed turn is NOT a compaction turn — its reply must still render",
  );
  assert.equal(
    T.isDegradedCompactionBlock(midTurnMarker),
    true,
    "the block itself carries the signature, whatever turn it landed in",
  );
  assert.equal(
    turns[0].blocks.indexOf(midTurnMarker),
    2,
    "and it keeps its seq position — the warning draws where the compaction happened",
  );
  // Negatives: the calm marker and every other kind stay out of the in-card path.
  assert.equal(
    T.isDegradedCompactionBlock(block("compaction", "t1", null, { trigger: null })),
    false,
    "a calm marker is not an in-card warning (S7 behaviour unchanged)",
  );
  assert.equal(
    T.isDegradedCompactionBlock(block("system-note", "t1", null, {
      text: "note",
      integrity: "summary-missing",
    })),
    false,
    "no other block kind can forge the warning",
  );
}

// 4f) WIRING FENCE (verify the effect, not the artifact). The selectors above can
// be perfect and the boundary still render calm if the view never reads them —
// which is precisely the failure this slice exists to prevent. Pin the
// load-bearing halves in the renderer source: BOTH placements feed a selector
// into the marker factory, and the factory has a distinct warning surface.
{
  const transcriptView = readFileSync(
    new URL("../../src/renderer/view/transcript.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    transcriptView,
    /renderCompactionMarker\(\{ degraded: isDegradedCompactionTurn\(turn\) \}\)/,
    "the standalone branch feeds the turn selector into the marker factory",
  );
  assert.match(
    transcriptView,
    /function isAnswerBlock\([\s\S]{0,400}?isDegradedCompactionBlock\(block\)/,
    "isAnswerBlock admits the degraded marker, so it reaches the card mid-turn",
  );
  assert.match(
    transcriptView,
    /if \(isDegradedCompactionBlock\(block\)\) \{\s*\n\s*return renderCompactionMarker\(\{ degraded: true, inCard: true \}\);/,
    "and renderTranscriptBlock draws it as the same warning separator",
  );
  assert.match(
    transcriptView,
    /degraded \? "degraded" : "", inCard \? "in-card" : ""/,
    "the warning and in-card variants are distinct classes on the same separator",
  );
  // The copy is asserted here rather than left to the view alone: it is the
  // whole user-facing payload of the slice, and every clause is hedged on
  // purpose (a signature is not a verdict — see the constants' comment).
  assert.match(
    transcriptView,
    /"Context compacted — summary missing"/,
    "the degraded headline names the observation, not an outcome",
  );
  assert.match(
    transcriptView,
    /"No summary was written, so the replies below may have lost the earlier context\. The transcript above is unaffected\."/,
    "the degraded note hedges the consequence and keeps the transcript claim true",
  );
  const styles = readFileSync(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");
  assert.match(
    styles,
    /\.compaction-marker\.degraded \.compaction-marker-label \{/,
    "the warning variant has its own styling",
  );
  assert.match(styles, /\.compaction-marker\.in-card \{/, "the in-card variant has its own rhythm");
}

// 5) Signature tracker — block-ref versioning with a fresh tracker.
{
  const tracker = T.createTurnSignatureTracker();
  const a = block("assistant-text", "t1", "run-1", { markdown: "a" });
  const b = block("assistant-text", "t1", "run-1", { markdown: "b" });
  assert.equal(tracker.blockRenderVersion(a), 1, "fresh tracker starts at 1");
  assert.equal(tracker.blockRenderVersion(a), 1, "same reference keeps its version");
  assert.equal(tracker.blockRenderVersion(b), 2, "new reference gets the next version");
  const replacedA = { ...a };
  assert.equal(tracker.blockRenderVersion(replacedA), 3, "an upsert-replaced ref reads as changed");

  const fresh = T.createTurnSignatureTracker();
  assert.equal(fresh.blockRenderVersion(b), 1, "trackers are isolated (per-fixture reset)");
}

// 6) Signature stability and flips.
{
  const tracker = T.createTurnSignatureTracker();
  const r1 = run("run-1");
  const b1 = block("assistant-text", "t1", "run-1", { markdown: "reply" });
  const turnOf = (runObj, blocks, fallbackText = null) => ({
    key: "src-1:t1",
    runId: runObj?.runId ?? null,
    run: runObj,
    blocks,
    fallbackText,
    tsMs: 0,
  });

  const sig1 = tracker.turnSignature(turnOf(r1, [b1]));
  const sig2 = tracker.turnSignature(turnOf(r1, [b1]));
  assert.equal(sig1, sig2, "unchanged turn → stable sig");

  const sigNewRef = tracker.turnSignature(turnOf(r1, [{ ...b1 }]));
  assert.notEqual(sigNewRef, sig1, "replaced block reference flips the sig");

  assert.notEqual(
    tracker.turnSignature(turnOf({ ...r1, status: "active" }, [b1])),
    sig1,
    "run status flips the sig",
  );
  assert.notEqual(
    tracker.turnSignature(turnOf({ ...r1, endedAt: "2026-07-03T09:02:00.000Z" }, [b1])),
    sig1,
    "endedAt flips the sig",
  );
  assert.notEqual(
    tracker.turnSignature(turnOf({ ...r1, completionSource: "terminal-idle-heuristic" }, [b1])),
    sig1,
    "completionSource flips the sig",
  );
  assert.notEqual(
    tracker.turnSignature(
      turnOf({ ...r1, stopEvents: [{ action: "stopped", slashStopSent: false }] }, [b1]),
    ),
    sig1,
    "stopEvents length flips the sig",
  );
  assert.notEqual(
    tracker.turnSignature(turnOf(r1, [b1], "fallback")),
    sig1,
    "fallbackText flips the sig",
  );

  const runless = tracker.turnSignature(turnOf(null, [b1]));
  assert.equal(typeof runless, "string", "run-less turn still signs");
  assert.ok(runless.startsWith("|||||"), "run-less fields serialize as empty parts");
}

// 7) stripRunningAgents — running-only, across agents blocks, order preserved.
{
  const agent = (toolUseId, status) => ({
    toolUseId,
    name: `agent ${toolUseId}`,
    detail: null,
    agentType: "general-purpose",
    status,
    startedAt: "2026-07-03T10:00:00.000Z",
    durationMs: status === "done" ? 1000 : null,
  });
  const g1 = block("agents", "t1", "run-1", { items: [agent("a1", "running"), agent("a2", "done")] });
  const g2 = block("agents", "t2", "run-2", { items: [agent("a3", "running")] });
  const other = block("assistant-text", "t1", "run-1", { markdown: "x" });
  const items = T.stripRunningAgents(view({ blocks: [g1, other, g2] }));
  assert.deepEqual(
    items.map((item) => item.toolUseId),
    ["a1", "a3"],
    "running agents only, in block order",
  );
  assert.deepEqual(T.stripRunningAgents(view({})), [], "no blocks → empty roster");
}

// 8) deriveCurrentStepForView — plan step outranks running tool; latest wins.
{
  const plan = (items) => block("plan", "t1", "run-1", { items });
  const tool = (toolName, status, summary) =>
    block("tool-call", "t1", "run-1", {
      callId: `c${seq}`,
      toolName,
      summary,
      inputPreview: "",
      inputTruncated: false,
      status,
      resultPreview: null,
      resultTruncated: false,
      durationMs: null,
    });

  assert.equal(T.deriveCurrentStepForView(view({})), null, "nothing running → null");
  assert.equal(
    T.deriveCurrentStepForView(view({ blocks: [tool("Bash", "running", "npm test")] })),
    "Bash — npm test",
    "running tool with summary",
  );
  assert.equal(
    T.deriveCurrentStepForView(view({ blocks: [tool("Bash", "running", "")] })),
    "Bash",
    "running tool without summary",
  );
  assert.equal(
    T.deriveCurrentStepForView(view({ blocks: [tool("Bash", "ok", "npm test")] })),
    null,
    "settled tool is not a current step",
  );
  assert.equal(
    T.deriveCurrentStepForView(
      view({
        blocks: [
          tool("Bash", "running", "npm test"),
          plan([
            { text: "Write tests", activeLabel: "Writing tests", status: "in_progress" },
            { text: "Ship", activeLabel: null, status: "pending" },
          ]),
        ],
      }),
    ),
    "Writing tests",
    "plan activeLabel outranks the running tool",
  );
  assert.equal(
    T.deriveCurrentStepForView(
      view({ blocks: [plan([{ text: "Step A", activeLabel: null, status: "in_progress" }])] }),
    ),
    "Step A",
    "plan falls back to text without activeLabel",
  );
  assert.equal(
    T.deriveCurrentStepForView(
      view({
        blocks: [
          plan([{ text: "Old", activeLabel: null, status: "in_progress" }]),
          plan([{ text: "All done", activeLabel: null, status: "completed" }]),
        ],
      }),
    ),
    "Old",
    "a later plan with no active item keeps the earlier step (planStep retained)",
  );
}

// 9) transcriptForRun — lookup by runId.
{
  const t1 = { runId: "run-1", rawText: "", text: "abc", truncated: false, receivedChars: 3 };
  const v = view({ runTranscripts: [t1] });
  assert.equal(T.transcriptForRun(v, "run-1"), t1, "found by runId");
  assert.equal(T.transcriptForRun(v, "run-2"), null, "missing → null");
}

// 10) userPromptDisplay — image markers lift out of DISPLAY text ONLY with real
//     attachments; the count feeds the reading bubble's chip (2026-07-05).
{
  const userBlock = (extra) =>
    block("user-message", "t1", "run-1", { text: "", command: null, attachments: [], ...extra });

  // Real image attachment: marker stripped, leading space tidied, count = 1.
  assert.deepEqual(
    T.userPromptDisplay(userBlock({ text: "[Image #1] 我刚做完重构", attachments: [{ kind: "image" }] }), ""),
    { text: "我刚做完重构", imageCount: 1 },
    "image prompt: marker stripped, counted",
  );

  // Multiple images: all markers gone, the user's text preserved, count = 2.
  assert.deepEqual(
    T.userPromptDisplay(
      userBlock({ text: "[Image #1] [Image #2]看这两张", attachments: [{ kind: "image" }, { kind: "image" }] }),
      "",
    ),
    { text: "看这两张", imageCount: 2 },
    "multi-image: all markers stripped, count = 2",
  );

  // NEGATIVE (review 2026-07-05): a user who literally typed "[Image #1]" with
  // NO attachment keeps their words verbatim — nothing to strip, no chip.
  assert.deepEqual(
    T.userPromptDisplay(userBlock({ text: "[Image #1] foo", attachments: [] }), ""),
    { text: "[Image #1] foo", imageCount: 0 },
    "literal marker without an attachment stays verbatim",
  );

  // Husk turn (no user-message block): falls back to the run prompt, no chip.
  assert.deepEqual(
    T.userPromptDisplay(undefined, "raw run prompt"),
    { text: "raw run prompt", imageCount: 0 },
    "no user block → fallback text, no chip",
  );

  // A file/folder attachment is not an image: no strip, no chip.
  assert.deepEqual(
    T.userPromptDisplay(userBlock({ text: "look at this", attachments: [{ kind: "file" }] }), ""),
    { text: "look at this", imageCount: 0 },
    "file attachment is not an image; text untouched",
  );
}

// 11) imageAttachmentLabel — the sticky/nav label an image-only prompt shows in
//     place of a text bubble (review 2026-07-05 P2: a bare count chip would be
//     non-navigable and would blank the sticky header).
{
  assert.equal(T.imageAttachmentLabel(1), "1 image attached", "singular");
  assert.equal(T.imageAttachmentLabel(3), "3 images attached", "plural");
}

// 12) assistantReplyContent — one semantic reply across multiple assistant
// text blocks. Notes/process stay visible elsewhere but never enter clipboard
// copy; the final visible text block defines the reply's timestamp.
{
  const first = block("assistant-text", "t1", "run-1", {
    markdown: "    indentedCode()\nHard break  \n",
    ts: "2026-07-03T10:00:02.000Z",
  });
  const note = block("system-note", "t1", "run-1", {
    text: 'Agent "research" finished.',
    ts: "2026-07-03T10:00:03.000Z",
  });
  const tool = block("tool-call", "t1", "run-1", {
    callId: "call-copy-test",
    toolName: "Bash",
    summary: "echo ignored",
    inputPreview: "",
    inputTruncated: false,
    status: "ok",
    resultPreview: null,
    resultTruncated: false,
    durationMs: 10,
    ts: "2026-07-03T10:00:04.000Z",
  });
  const last = block("assistant-text", "t1", "run-1", {
    markdown: "```ts\nconst answer = 42;\n```\n",
    ts: "2026-07-03T10:00:05.000Z",
  });
  const invisibleTail = block("assistant-text", "t1", "run-1", {
    markdown: "  \n",
    ts: "2026-07-03T10:00:06.000Z",
  });
  assert.deepEqual(
    T.assistantReplyContent([first, note, tool, last, invisibleTail]),
    {
      markdown: "    indentedCode()\nHard break  \n\n\n```ts\nconst answer = 42;\n```\n",
      completedAt: last.ts,
    },
    "raw Markdown bytes survive; system/process/whitespace-only content is excluded",
  );
  assert.equal(T.assistantReplyContent([note, tool]), null, "no assistant text → no reply action");
}

// The count tracks the numbered outline (1–12); lettered siblings (4b–4e) hang
// off their parent number.
console.log("reading-turns: 12 fixture groups pass");
