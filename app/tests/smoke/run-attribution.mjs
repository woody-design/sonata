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

// 2) Assigned runs are skipped even for identity matches.
assert.equal(
  resolveRunForTurn(runIndex, input({ promptId: "pid-1", assigned: new Set(["run-1"]) })),
  null,
  "an already-assigned run never re-attributes",
);

// 3) Unknown promptId falls back to the text match (pre-bridge coverage).
assert.equal(
  resolveRunForTurn(runIndex, input({ text: "unique legacy prompt", promptId: "pid-unknown", tsMs: Date.parse("2026-07-03T10:02:30.000Z") })),
  "run-3",
  "unknown id falls through to the legacy text bridge",
);

// 4) Text match respects the 15-minute window.
assert.equal(
  resolveRunForTurn(
    runIndex,
    input({ text: "unique legacy prompt", tsMs: Date.parse("2026-07-03T11:00:00.000Z") }),
  ),
  null,
  "stale text matches outside the window stay unattributed",
);

runIndex.dispose?.();
fs.rmSync(dir, { recursive: true, force: true });
console.log("run-attribution smoke: OK");
