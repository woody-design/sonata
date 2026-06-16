import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Regression for the main-process crash "Unhandled RunIndex event
// {type:'modal:state'}". TerminalHost.armModalPanel emits `modal:state` — a
// renderer-facing UI event — into the same eventSink as run-index events. The
// old boundary cast `event as RunIndexEvent` and let it reach consume's
// `default: assertNever`, crashing the main process.
//
// These checks drive the PRODUCTION RuntimeController.handleRuntimeEvent (helpers
// early-return on an unregistered task, so the pre-consume machinery no-ops and
// only sendEvent + the consume boundary actually run). Exhaustiveness itself is
// locked at COMPILE time by `satisfies Record<RunIndexEvent["type"], true>` plus
// consume's `assertNever`; this is the runtime proof for the reported repro and a
// representative sweep of every RuntimeEvent type.
const require = createRequire(import.meta.url);
const { RuntimeController } = require("../../dist/main/runtime-controller");
const { RunIndex, isRunIndexEvent } = require("../../dist/runtime");

const TS = new Date(1700000000000).toISOString();
const T = "smoke-task";
const R = "smoke-run";

// One representative payload per RuntimeEvent type (full RuntimeEvent union:
// TerminalDataEvent + the 27 ProductRuntimeEvent members = 28 types).
const PAYLOADS = {
  "pty:data": { taskId: T, data: "x" },
  "pty:exit": { taskId: T, runId: R, exitCode: 0, signal: null, elapsedMs: 1 },
  "task:started": {
    taskId: T, provider: "claude", model: null, reasoningEffort: null, speedMode: null,
    command: "claude", args: [], cwd: "/tmp", rows: 24, cols: 80,
    persistence: "raw-terminal-memory-only",
  },
  "task:ready": { taskId: T, source: "terminal-idle-composer-heuristic", confidence: "high" },
  "task:accepts-input": { taskId: T, source: "idle-prompt-structural", confidence: "high" },
  "working-status:updated": { taskId: T, native: null, liveness: "idle", silentSince: null, capturedAt: TS },
  "cli-state:changed": { taskId: T, activity: "idle", tool: null, approvalKind: null, source: "test", changedAt: TS },
  "task:updated": { taskId: T, task: { id: T, title: "x" }, reason: "runtime-status" },
  "prompt:submitted": { taskId: T, runId: R, kind: "prompt", chars: 1, attachments: 0 },
  "delivery:state": { taskId: T },
  "delivery:receipt": { taskId: T, itemId: "i", item: {}, receipt: {} },
  "run:started": {
    taskId: T, id: R, kind: "prompt", prompt: "p", title: "t", status: "active",
    lifecyclePhase: "active", startedAt: TS, endedAt: null, elapsedMs: null,
    completionSource: null, completionConfidence: null,
  },
  "run:updated": {
    taskId: T, id: R, kind: "prompt", prompt: "p", title: "t", status: "active",
    lifecyclePhase: "active", startedAt: TS, endedAt: null, elapsedMs: null,
    completionSource: null, completionConfidence: null,
  },
  "run:stop-requested": { taskId: T, runId: R, phase: "interrupt", encodedAs: "Esc" },
  "run:stopped": { taskId: T, runId: R, interruptSent: true, slashStopSent: false, slashStopReason: "" },
  "approval:detected": { taskId: T, runId: R, kind: "command", source: "test" },
  "approval:decision": { taskId: T, runId: R, decision: "approve", encodedAs: "y", previousKind: null },
  "approval:persisted": { taskId: T, runId: R, file: "/tmp/x", rulesAdded: [] },
  "modal:state": { taskId: T, active: true, excerpt: "panel tail", signature: "footer-hint", origin: "slash" },
  "terminal:user-control": { taskId: T, active: true, reason: "user" },
  "file:watching": { taskId: T, cwd: "/tmp", mode: "fs.watch" },
  "file:watch-error": { taskId: T, cwd: "/tmp", mode: "fs.watch", error: "e" },
  "file:changed": {
    taskId: T, runId: R, path: "a.txt", absolutePath: "/tmp/a.txt", eventType: "change",
    changeKind: "modified", type: "file", size: 1, mtimeMs: 1, sha256: null,
  },
  "report:updated": {
    taskId: T, reportPath: "/tmp/r.json", runCount: 0, latestRunId: null,
    rawTerminalPersisted: false, rawTerminalPointer: null,
  },
  "transcript:located": { taskId: T, source: { sourceId: "s", kind: "claude-jsonl", path: "/tmp/x" } },
  "transcript:blocks": { taskId: T, sourceId: "s", upserts: [], reset: false },
  "usage:updated": { taskId: T, snapshot: { sessionName: null } },
  "sessions:updated": { reason: "session-updated" },
};
const ALL_TYPES = Object.keys(PAYLOADS);
const makeEvent = (type) => ({ type, payload: PAYLOADS[type], ts: TS });

// The 16 types RunIndex.consume handles (the allowlist isRunIndexEvent encodes).
const EXPECTED_ALLOWLIST = new Set([
  "pty:exit", "task:started", "task:ready", "task:accepts-input",
  "working-status:updated", "prompt:submitted", "run:started", "run:updated",
  "run:stop-requested", "run:stopped", "approval:detected", "approval:decision",
  "approval:persisted", "file:watching", "file:watch-error", "file:changed",
]);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-modal-smoke-"));

function makeController() {
  const sent = [];
  const stubStore = { read: () => ({}), write: () => {}, noteFolderUsed: () => {} };
  const controller = new RuntimeController({
    sendEvent: (event) => sent.push(event),
    projectsStore: stubStore,
    resumeSettingsStore: stubStore,
    claudeSettingsStore: stubStore,
  });
  return { controller, sent };
}

function freshRunIndex(tag) {
  return new RunIndex({ taskId: T, reportPath: path.join(tmpDir, `report-${tag}.json`) });
}

// --- 1. THE REPRO: modal:state no longer crashes, still reaches the renderer --
{
  const { controller, sent } = makeController();
  const runIndex = freshRunIndex("modal");
  assert.doesNotThrow(
    () => controller.handleRuntimeEvent(makeEvent("modal:state"), runIndex),
    "modal:state must not crash handleRuntimeEvent",
  );
  const forwarded = sent.filter((e) => e.type === "modal:state");
  assert.equal(forwarded.length, 1, "modal:state still reaches the renderer (modal banner)");
  assert.equal(forwarded[0].payload.active, true, "the forwarded modal:state is intact");
}

// --- 2. THE CLASS: the dormant siblings the audit found are also defused -------
// cli-state:changed and task:updated are type-level gaps too (excluded from
// RunIndexEvent, not consume-handled). Today they ship via sendEvent and never
// reach handleRuntimeEvent, but the allowlist guard neutralizes them if they ever do.
for (const type of ["cli-state:changed", "task:updated"]) {
  const { controller } = makeController();
  assert.doesNotThrow(
    () => controller.handleRuntimeEvent(makeEvent(type), freshRunIndex(type)),
    `sibling ${type} must not crash handleRuntimeEvent`,
  );
}

// --- 3. THE SWEEP: every RuntimeEvent type passes through without assertNever --
{
  const { controller } = makeController();
  const runIndex = freshRunIndex("sweep");
  for (const type of ALL_TYPES) {
    assert.doesNotThrow(
      () => controller.handleRuntimeEvent(makeEvent(type), runIndex),
      `handleRuntimeEvent must not throw for ${type}`,
    );
  }
}

// --- 4. THE GUARD: isRunIndexEvent classifies exactly the consume allowlist ---
// Catches the guard drifting too permissive (a future crasher) OR too strict (a
// real event silently dropped before consume).
for (const type of ALL_TYPES) {
  assert.equal(
    isRunIndexEvent(makeEvent(type)),
    EXPECTED_ALLOWLIST.has(type),
    `isRunIndexEvent(${type}) must be ${EXPECTED_ALLOWLIST.has(type)}`,
  );
}

// --- 5. CONSUME COVERAGE: every allowlisted type is handled (assertNever sound) --
// Drive each allowlisted event straight into consume — proves consume's switch
// has a case for all 16, so its default:assertNever is unreachable at runtime.
{
  const runIndex = freshRunIndex("consume");
  for (const type of ALL_TYPES) {
    if (!EXPECTED_ALLOWLIST.has(type)) continue;
    assert.doesNotThrow(
      () => runIndex.consume(makeEvent(type)),
      `consume must handle allowlisted ${type}`,
    );
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(JSON.stringify({ smoke: "modal-state-crash", success: true }, null, 2));
