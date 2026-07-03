import assert from "node:assert/strict";
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

console.log("reading-turns: 9 fixture groups pass");
