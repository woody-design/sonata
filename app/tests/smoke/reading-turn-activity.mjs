import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Fence for turnActivity (Turn-Signal Authority S1b): the ONE derivation the
// status strip and the sidebar spinner both read, so the two surfaces can never
// again disagree on "is the turn over". Three explicit states —
// working / background / idle — across the run × cliState × agents matrix.
// The load-bearing case is the incident shape (row 2): the run report lies
// "completed" while the hook-driven cliState still says "busy" — turnActivity
// must say "working" so neither surface hides the live turn.
const require = createRequire(import.meta.url);
const R = require("../../dist/reading-core/selectors/runs");

function runningAgentBlock() {
  return {
    id: "agents-1",
    kind: "agents",
    items: [
      {
        toolUseId: "a1",
        name: "research",
        detail: null,
        agentType: "general-purpose",
        status: "running",
        startedAt: "2026-07-16T10:00:00.000Z",
        durationMs: null,
      },
    ],
  };
}

// A minimal TaskViewState shaped exactly for turnActivity's reads: the latest
// run status (hasActiveRun), cliState.activity, and the transcript-block roster
// (stripRunningAgents). `task` present unless overridden.
function view({ runStatus = null, activity = null, agents = false, task = { id: "task-1" } } = {}) {
  const blocks = agents ? [runningAgentBlock()] : [];
  return {
    task,
    report: runStatus ? { runs: [{ runId: "run-1", status: runStatus }] } : null,
    cliState: activity ? { activity, tool: null, approvalKind: null } : null,
    transcriptBlockOrder: blocks.map((b) => b.id),
    transcriptBlocks: new Map(blocks.map((b) => [b.id, b])),
  };
}

// 1) Active run, cliState idle → working (the run family alone carries it).
assert.equal(R.turnActivity(view({ runStatus: "active", activity: "idle" })), "working");

// 2) INCIDENT SHAPE: run report says completed, but the hook cliState says busy
//    → working. The cliState leg is the whole point of S1b — a run-report lie
//    can no longer hide the live turn from either surface.
assert.equal(R.turnActivity(view({ runStatus: "completed", activity: "busy" })), "working");

// 3) Main turn over (completed + turn-ended), but subagents still running
//    → background (async agents outlive their launch turn; no "all done" edge).
assert.equal(
  R.turnActivity(view({ runStatus: "completed", activity: "turn-ended", agents: true })),
  "background",
);

// 4) Completed + turn-ended, no agents → idle.
assert.equal(R.turnActivity(view({ runStatus: "completed", activity: "turn-ended" })), "idle");

// 5) Null view → idle.
assert.equal(R.turnActivity(null), "idle");

// 6) waiting-approval cliState → working (the turn is still going; a surface
//    that draws approval distinctly must branch BEFORE this selector).
assert.equal(R.turnActivity(view({ runStatus: "completed", activity: "waiting-approval" })), "working");

// --- Boundary cases beyond the brief's core matrix ---

// 7) A view without a task is idle (defensive null-task guard).
assert.equal(R.turnActivity(view({ activity: "busy", task: null })), "idle");

// 8) Every active-family run status reads working via the run leg alone
//    (isActiveRunStatus parity — no cliState needed).
for (const status of ["active", "waiting-for-approval", "resumed-after-approval", "stopping"]) {
  assert.equal(R.turnActivity(view({ runStatus: status })), "working", `run "${status}" → working`);
}

// 9) working OUTRANKS background: agents running while the CLI is still busy is
//    a working turn, not a background one (the "not working AND agents" order).
assert.equal(
  R.turnActivity(view({ runStatus: "completed", activity: "busy", agents: true })),
  "working",
);

// 10) No run report + no cliState + no agents → idle (the fresh/empty view).
assert.equal(R.turnActivity(view({})), "idle");

// 11) A settled run with running agents and NO cliState still reads background
//     (the roster is the only background signal when hooks say nothing).
assert.equal(R.turnActivity(view({ runStatus: "completed", agents: true })), "background");

console.log("reading-turn-activity: 11 assertions pass");
