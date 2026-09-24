// A run that arrives AFTER its transcript turn attaches to that turn (X5 a).
//
// Since X2 a run begins only on the CLI's own UserPromptSubmit, and codex fires
// that hook lazily on a session's first submission (~1.7s, MEASURED at 0.156.1).
// A fast reply therefore lands its WHOLE turn in the rollout before the run
// exists: turn-side pairing finds nothing, no later block ever retries, and the
// reading surface showed TWO cards — the run-less transcript turn and the run as
// its own husk (e2e `new-chat`, 4/4 red on 8b81070). The fix pairs on run
// arrival too: when a run starts, every still-unattributed turn retries its
// anchor through the SAME resolver (`resolveRunForTurn`: promptId identity,
// then normalized text inside the 15-min window).
//
// Real modules end to end: a rollout file drained by ProviderTranscript, a real
// RunIndex behind `resolveRunForTurn`, and the reading core's own reducer +
// `buildReadingTurns` counting cards.
//
// Fixture provenance: the rollout lines are ADAPTED from the codex 0.142.5+
// shapes pinned in tests/smoke/provider-transcript.mjs (session_meta,
// task_started carrying the turn_id, user_message, agent_message,
// task_complete); the texts and ids are COMPOSED. The run:started payload is
// COMPOSED to the shape the terminal host emits from a UserPromptSubmit whose
// `turn_id` is the rollout's.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ProviderTranscript, RunIndex, resolveRunForTurn } = require("../../dist/runtime");
const S = require("../../dist/reading-core/state");
const R = require("../../dist/reading-core/runtime-reducer");
const T = require("../../dist/reading-core/selectors/turns");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-late-run-"));
const failures = [];

const taskId = "task-late-run";
const sessionId = "019f0000-aaaa-7000-8000-000000000001";
const turnId = "019f0000-bbbb-7000-8000-000000000002";
const prompt = "Reply with exactly: NEW_CHAT_READY";

function rolloutLines(ts) {
  const at = (ms) => new Date(ts + ms).toISOString();
  return [
    { timestamp: at(0), type: "session_meta", payload: { id: sessionId, cwd: "/tmp/ws", timestamp: at(0) } },
    { timestamp: at(100), type: "event_msg", payload: { type: "task_started", turn_id: turnId, model_context_window: 272000 } },
    { timestamp: at(200), type: "event_msg", payload: { type: "user_message", message: prompt, images: [], local_images: [], text_elements: [] } },
    { timestamp: at(900), type: "event_msg", payload: { type: "agent_message", message: "NEW_CHAT_READY", phase: "final_answer", memory_citation: null } },
    { timestamp: at(1000), type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: "NEW_CHAT_READY" } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function runStarted(runId, startedAt, promptId) {
  return {
    type: "run:started",
    payload: {
      taskId,
      id: runId,
      kind: "prompt",
      prompt,
      title: prompt,
      promptId,
      status: "active",
      lifecyclePhase: "active",
      startedAt,
      endedAt: null,
      elapsedMs: null,
      completionSource: null,
      completionConfidence: null,
    },
    ts: startedAt,
  };
}

/** The reading core's card count for what the transcript emitted + the report. */
function cardsFor(events, runIndex) {
  const state = S.createInitialState({ theme: "default", mode: "auto", textStep: 16 });
  const view = S.createTaskView(
    { id: taskId, title: "t", provider: "codex", createdAt: new Date().toISOString(), status: "running" },
    "Ready",
    true,
  );
  S.upsertTaskView(state, view);
  state.activeTaskId = taskId;
  for (const event of events) {
    if (event.type === "transcript:blocks") {
      R.reduceRuntimeEvent(state, event, Date.now());
    }
  }
  view.report = runIndex.read();
  return T.buildReadingTurns(view).filter((turn) => {
    const texts = [turn.fallbackText ?? "", ...turn.blocks.map((block) => block.text ?? "")].join(" ");
    return turn.key.startsWith("run:") || texts.includes("NEW_CHAT_READY");
  });
}

function setup(label) {
  const dir = path.join(tempRoot, label);
  fs.mkdirSync(dir, { recursive: true });
  const rolloutPath = path.join(dir, "rollout.jsonl");
  const now = Date.now();
  fs.writeFileSync(rolloutPath, rolloutLines(now));
  const runIndex = new RunIndex({ taskId, reportPath: path.join(dir, "runtime-report.json") });
  const events = [];
  const transcript = new ProviderTranscript({
    taskId,
    provider: "codex",
    providerCwd: "/tmp/ws",
    eventSink: (event) => events.push(event),
    resolveRunId: (input) => resolveRunForTurn(runIndex, input),
  });
  transcript.attachExistingSource({
    sourceId: `codex:${sessionId}`,
    provider: "codex",
    format: "codex-rollout-jsonl",
    path: rolloutPath,
    providerSessionId: sessionId,
    locatedAt: new Date(now).toISOString(),
  });
  return { transcript, runIndex, events, now };
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

await check("turn first, run second → ONE card, carrying the run", () => {
  const { transcript, runIndex, events, now } = setup("late");
  try {
    assert.ok(
      transcript.blocks().length >= 2 && transcript.blocks().every((block) => !block.runId),
      "precondition: the whole turn landed before any run existed",
    );
    // The run arrives (the lazy hook), and the index records it.
    runIndex.consume(runStarted("run-late-1", new Date(now + 1700).toISOString(), turnId));
    // Without the run-arrival pairing this is the failure: two cards.
    assert.equal(cardsFor(events, runIndex).length, 2, "precondition: turn-side pairing alone leaves two cards");

    transcript.attributeLateRuns();
    assert.ok(
      transcript.blocks().every((block) => block.runId === "run-late-1"),
      "every block of the turn now carries the run",
    );
    const cards = cardsFor(events, runIndex);
    assert.equal(cards.length, 1, "one card");
    assert.equal(cards[0].runId, "run-late-1", "…and it is the run's");
    assert.ok(!cards[0].key.startsWith("run:"), "…as the transcript turn, not a husk");

    // Idempotent: a second run arrival re-emits nothing for an attributed turn.
    const before = events.length;
    transcript.attributeLateRuns();
    assert.equal(events.length, before, "an attributed turn is left alone");
  } finally {
    transcript.dispose();
  }
});

await check("identity outranks text: a run with a DIFFERENT prompt id does not attach", () => {
  const { transcript, runIndex, events, now } = setup("mismatch");
  try {
    runIndex.consume(runStarted("run-other", new Date(now + 1700).toISOString(), "019f0000-cccc-7000-8000-000000000009"));
    transcript.attributeLateRuns();
    assert.ok(transcript.blocks().every((block) => !block.runId), "same text, different turn_id → no pairing");
    assert.equal(cardsFor(events, runIndex).length, 2, "the two stay apart");
  } finally {
    transcript.dispose();
  }
});

fs.rmSync(tempRoot, { recursive: true, force: true });
if (failures.length > 0) {
  process.exit(1);
}
console.log("late-run-attachment: OK");
