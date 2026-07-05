import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// resolveRunForTurn — the run↔turn bridge (2026-07-03 loop-wakeup fix):
// exact prompt_id identity FIRST (the CLI's UserPromptSubmit.prompt_id,
// stamped onto hook-begun runs), then the legacy prompt-text match inside a
// 15-minute window. Identity must beat text, and text must keep covering
// pre-bridge records.
const require = createRequire(import.meta.url);
const { RunIndex, resolveRunForTurn } = require("../../dist/runtime");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-run-attribution-"));
const runIndex = new RunIndex({ taskId: "t", reportPath: path.join(dir, "report.json") });

const runStarted = (id, prompt, promptId, startedAt) => ({
  type: "run:started",
  payload: {
    taskId: "t",
    id,
    kind: "prompt",
    prompt,
    promptId,
    title: prompt.slice(0, 40),
    status: "active",
    lifecyclePhase: "active",
    startedAt,
    endedAt: null,
    elapsedMs: null,
    completionSource: null,
    completionConfidence: null,
  },
  ts: startedAt,
});

const T0 = "2026-07-03T10:00:00.000Z";
const T0MS = Date.parse(T0);
// Two runs with IDENTICAL prompt text — only the id can tell them apart.
runIndex.consume(runStarted("run-1", "检查 agent 是否完成", "pid-1", T0));
runIndex.consume(runStarted("run-2", "检查 agent 是否完成", "pid-2", "2026-07-03T10:01:00.000Z"));
// A pre-bridge run (no promptId) with unique text.
runIndex.consume(runStarted("run-3", "unique legacy prompt", null, "2026-07-03T10:02:00.000Z"));

const input = (over = {}) => ({
  text: "",
  command: null,
  tsMs: T0MS,
  assigned: new Set(),
  promptId: null,
  ...over,
});

// 1) Identity beats text: promptId picks the SECOND run despite equal text
//    and a closer first-run timestamp.
assert.equal(
  resolveRunForTurn(runIndex, input({ text: "检查 agent 是否完成", promptId: "pid-2" })),
  "run-2",
  "prompt_id identity wins over text/time",
);

// 2) An identity verdict is FINAL (review 2026-07-03): re-anchoring a turn
//    whose run is already assigned returns THAT run — it must never fall
//    through to the text pass and steal a same-text sibling.
assert.equal(
  resolveRunForTurn(
    runIndex,
    input({ text: "检查 agent 是否完成", promptId: "pid-1", assigned: new Set(["run-1"]) }),
  ),
  "run-1",
  "identity re-anchor returns the same run; the sibling is never stolen",
);

// 3) Unknown promptId falls back to the text match (pre-bridge coverage).
assert.equal(
  resolveRunForTurn(runIndex, input({ text: "unique legacy prompt", promptId: "pid-unknown", tsMs: Date.parse("2026-07-03T10:02:30.000Z") })),
  "run-3",
  "unknown id falls through to the legacy text bridge",
);

// 4) Text match respects the window — 15 minutes by default.
assert.equal(
  resolveRunForTurn(
    runIndex,
    input({ text: "unique legacy prompt", tsMs: Date.parse("2026-07-03T11:00:00.000Z") }),
  ),
  null,
  "stale text matches outside the window stay unattributed",
);

// 5) Machine anchors pass a TIGHT window (review 2026-07-03): recurring
//    wakeups repeat identical text, so only the near-simultaneous twin may
//    text-match — a sibling one minute away must NOT.
assert.equal(
  resolveRunForTurn(
    runIndex,
    input({
      text: "检查 agent 是否完成",
      tsMs: Date.parse("2026-07-03T10:00:02.000Z"), // 2s after run-1 started
      textWindowMs: 30_000,
      assigned: new Set(),
    }),
  ),
  "run-1",
  "the tight window pairs the true twin",
);
assert.equal(
  resolveRunForTurn(
    runIndex,
    input({
      text: "检查 agent 是否完成",
      tsMs: Date.parse("2026-07-03T10:02:00.000Z"), // sibling run-2 is 60s away
      textWindowMs: 30_000,
      assigned: new Set(["run-1"]),
    }),
  ),
  null,
  "the tight window refuses a sibling outside near-simultaneity",
);

// 6) Identity outranks text even in the FALLBACK (review 2026-07-03): an
//    anchor carrying pid-X must not text-match a run carrying pid-Y — only
//    id-less (pre-bridge) runs stay text-matchable.
assert.equal(
  resolveRunForTurn(
    runIndex,
    input({
      text: "检查 agent 是否完成",
      promptId: "pid-unknown-to-index", // exact miss → text pass
      tsMs: Date.parse("2026-07-03T10:00:01.000Z"),
    }),
  ),
  null,
  "an id-bearing anchor never text-pairs with a differently-id'd run",
);
assert.equal(
  resolveRunForTurn(
    runIndex,
    input({
      text: "unique legacy prompt", // run-3 carries NO promptId
      promptId: "pid-unknown-to-index",
      tsMs: Date.parse("2026-07-03T10:02:10.000Z"),
    }),
  ),
  "run-3",
  "id-less legacy runs remain text-matchable for id-bearing anchors",
);

// 7) Image prompt (2026-07-05): the CLI prepends `[Image #N]` to the turn text
//    (transcript user-message), but Duet stored the raw typed prompt and the
//    typed run never got a promptId. Before the shared normalizer this fell
//    through to an un-attributed run → a second husk card. The equivalence
//    relation must read through the markers. run-img carries NO promptId, so an
//    id-bearing anchor still text-pairs with it (case 6, second assertion).
runIndex.consume(
  runStarted("run-img", "我刚做完一系列重构 Preview 的工作", null, "2026-07-03T10:03:00.000Z"),
);
assert.equal(
  resolveRunForTurn(
    runIndex,
    input({
      text: "[Image #1] [Image #2] [Image #3]我刚做完一系列重构 Preview 的工作",
      promptId: "a837862a-eccc-4b84-be3b-0ba4ef2ceede",
      tsMs: Date.parse("2026-07-03T10:03:01.000Z"),
    }),
  ),
  "run-img",
  "image prompt attributes despite the [Image #N] prefix the run prompt lacks",
);

// 8) Whitespace is canonicalized on both sides (review 2026-07-05): a run whose
//    stored text differs only by collapsed spaces still matches its turn.
runIndex.consume(
  runStarted("run-ws", "spaced    out   prompt", null, "2026-07-03T10:04:00.000Z"),
);
assert.equal(
  resolveRunForTurn(
    runIndex,
    input({ text: "spaced out prompt", tsMs: Date.parse("2026-07-03T10:04:01.000Z") }),
  ),
  "run-ws",
  "horizontal whitespace differences no longer block attribution",
);

runIndex.dispose?.();
fs.rmSync(dir, { recursive: true, force: true });
console.log("run-attribution smoke: OK");
