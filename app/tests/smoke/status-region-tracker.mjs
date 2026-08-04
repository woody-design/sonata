import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { StatusRegionTracker } = require("../../dist/runtime/working-status/index");
// Geometry reaches every mirror through the single clamp (SL-9); the grid takes
// the clamped pair, not loose numbers.
const { normalizeTerminalDimensions } = require("../../dist/runtime/terminal-dimensions");

const failures = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHarness(provider, options = {}) {
  const emitted = [];
  const tracker = new StatusRegionTracker({
    taskId: "task-1",
    provider,
    eventSink: (event) => {
      if (event.type === "working-status:updated") {
        emitted.push(event.payload);
      }
    },
    // Boot geometry is a required input (SL-9): in production it is the host's
    // own `StartedPty.dimensions`, because `task:started` fires before the
    // runtime is registered and never reaches this grid.
    dimensions: normalizeTerminalDimensions(120, 36),
    ...options,
  });
  const feed = (data) => tracker.handleRuntimeEvent({ type: "pty:data", payload: { taskId: "task-1", data }, ts: "t" });
  const runStarted = () =>
    tracker.handleRuntimeEvent({ type: "run:started", payload: { taskId: "task-1", status: "active" }, ts: "t" });
  const runCompleted = () =>
    tracker.handleRuntimeEvent({ type: "run:updated", payload: { taskId: "task-1", status: "completed" }, ts: "t" });
  const approvalDetected = () =>
    tracker.handleRuntimeEvent({ type: "approval:detected", payload: { taskId: "task-1", kind: "command" }, ts: "t" });
  const approvalDecision = () =>
    tracker.handleRuntimeEvent({ type: "approval:decision", payload: { taskId: "task-1", decision: "approve" }, ts: "t" });
  return { tracker, emitted, feed, runStarted, runCompleted, approvalDetected, approvalDecision };
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

await check("claude: spinner line relays only while a run is active", async () => {
  const h = createHarness("claude");
  // Spinner on screen BEFORE run:started → must stay null (no emission).
  h.feed("✻ Catapulting…\r\n");
  await delay(450);
  assert.equal(h.emitted.length, 0, "no emission before the run starts");

  h.runStarted();
  h.feed("\r✶ Catapulting… (4s · ↓ 125 tokens · thinking with xhigh effort)");
  await delay(450);
  const latest = h.emitted[h.emitted.length - 1];
  assert.ok(latest?.native, "native region present during the run");
  assert.equal(latest.native.line, "✶ Catapulting… (4s · ↓ 125 tokens · thinking with xhigh effort)");

  h.runCompleted();
  const final = h.emitted[h.emitted.length - 1];
  assert.equal(final.native, null, "region nulls when the run finishes");
  h.tracker.dispose();
});

await check("claude: TUI redraw keeps the latest frame only", async () => {
  const h = createHarness("claude");
  h.runStarted();
  h.feed("✢ Crafting… (2s)\r\n");
  await delay(450);
  // Cursor-up + erase-line + rewrite, like the real TUI repaint.
  h.feed("[1A[2K✽ Crafting… (3s · ↑ 88 tokens)\r\n");
  await delay(450);
  const latest = h.emitted[h.emitted.length - 1];
  assert.equal(latest.native.line, "✽ Crafting… (3s · ↑ 88 tokens)");
  h.tracker.dispose();
});

await check("claude: retry cluster above the spinner becomes troubleLines", async () => {
  const h = createHarness("claude");
  h.runStarted();
  h.feed(
    [
      "❯ Reply with exactly: SHOULD-NOT-ARRIVE",
      "  ⎿  Unable to connect to API (ConnectionRefused)",
      "     Retrying in 17s · attempt 8/10",
      "· Crafting… (1m 26s)",
      "  ⎿  Tip: Use /btw to ask a quick side question",
      "",
    ].join("\r\n"),
  );
  await delay(450);
  const latest = h.emitted[h.emitted.length - 1];
  assert.equal(latest.native.line, "· Crafting… (1m 26s)");
  assert.deepEqual(latest.native.troubleLines, [
    "⎿  Unable to connect to API (ConnectionRefused)",
    "Retrying in 17s · attempt 8/10",
  ]);
  assert.deepEqual(latest.native.subLines, ["⎿  Tip: Use /btw to ask a quick side question"]);
  h.tracker.dispose();
});

await check("claude: a multi-row todo sub-block relays in full (⎿ on first row only)", async () => {
  // The real shape from Woody's screenshot (2026-07-03): claude paints the
  // live todo list under the spinner with ⎿ on the FIRST row only — the
  // remaining rows are indented siblings. Requiring ⎿ on every row relayed
  // exactly one sub-task. The region ends at the blank row before the
  // composer border.
  const h = createHarness("claude");
  h.runStarted();
  h.feed(
    [
      "✢ Implementing S3 slash passthrough… (16m 18s · ↑ 49.3k tokens)",
      "  ⎿  ✔ Phase 0: map every consumer of slash intent routing + modal machinery",
      "     ✔ Ask Woody: modal delivery guard decision (A: delete / B: minimal detector)",
      "     ■ Implement S3: 2-way slash + retire modal machinery per decision",
      "     □ Verify zero-regression + write S3 findings doc",
      "",
      "╭──────────────────────────────╮",
      "│ ❯                            │",
      "╰──────────────────────────────╯",
    ].join("\r\n"),
  );
  await delay(450);
  const latest = h.emitted[h.emitted.length - 1];
  assert.equal(latest.native.line, "✢ Implementing S3 slash passthrough… (16m 18s · ↑ 49.3k tokens)");
  assert.deepEqual(
    latest.native.subLines,
    [
      "⎿  ✔ Phase 0: map every consumer of slash intent routing + modal machinery",
      "✔ Ask Woody: modal delivery guard decision (A: delete / B: minimal detector)",
      "■ Implement S3: 2-way slash + retire modal machinery per decision",
      "□ Verify zero-regression + write S3 findings doc",
    ],
    "the full todo block relays; the composer border does not leak in",
  );
  h.tracker.dispose();
});

await check("codex: working line and boot stage lines relay", async () => {
  const h = createHarness("codex");
  h.runStarted();
  h.feed("• Starting MCP servers (1/3): codex_apps, figma (0s • esc to interrupt)\r\n");
  await delay(450);
  assert.equal(
    h.emitted[h.emitted.length - 1].native.line,
    "• Starting MCP servers (1/3): codex_apps, figma (0s • esc to interrupt)",
  );
  h.feed("[1A[2K• Working (3s • esc to interrupt)\r\n");
  await delay(450);
  assert.equal(h.emitted[h.emitted.length - 1].native.line, "• Working (3s • esc to interrupt)");
  h.tracker.dispose();
});

await check("tracker: resize and task restart survive", async () => {
  const h = createHarness("claude");
  h.runStarted();
  h.feed("✻ Pondering… (2s)\r\n");
  await delay(450);
  h.tracker.resize(normalizeTerminalDimensions(80, 24));
  h.tracker.handleRuntimeEvent({
    type: "task:started",
    payload: { taskId: "task-1", cols: 100, rows: 30 },
    ts: "t",
  });
  const final = h.emitted[h.emitted.length - 1];
  assert.equal(final.native, null, "restart resets to null");
  h.tracker.dispose();
});

await check("liveness: fresh → quiet → silent on silence, self-heals on data", async () => {
  // Thresholds sized so the 300ms sample throttle cannot race them.
  const h = createHarness("claude", { quietAfterMs: 600, silentAfterMs: 1200, livenessCheckMs: 100 });
  h.runStarted();
  h.feed("✻ Pondering… (2s)\r\n");
  await delay(450); // first sample landed, silence still under the quiet bar
  assert.equal(h.emitted[h.emitted.length - 1]?.liveness, "fresh");

  await delay(550); // ~1.0s of silence — past quiet, before silent
  let latest = h.emitted[h.emitted.length - 1];
  assert.equal(latest.liveness, "quiet");
  assert.ok(latest.silentSince, "silence window start recorded");
  assert.ok(latest.native, "native region still relayed while quiet");

  await delay(600); // ~1.6s of silence — past silent
  latest = h.emitted[h.emitted.length - 1];
  assert.equal(latest.liveness, "silent");

  h.feed("✽ Pondering… (12s)\r\n"); // evidence resumes
  await delay(100);
  latest = h.emitted[h.emitted.length - 1];
  assert.equal(latest.liveness, "fresh", "self-heals immediately on data");
  assert.equal(latest.silentSince, null);
  h.tracker.dispose();
});

await check("liveness: approval pauses the silence clock", async () => {
  const h = createHarness("claude", { quietAfterMs: 250, silentAfterMs: 600, livenessCheckMs: 60 });
  h.runStarted();
  h.feed("✻ Pondering… (2s)\r\n");
  await delay(100);
  h.approvalDetected();
  await delay(500); // would be quiet/silent without the pause
  const latest = h.emitted[h.emitted.length - 1];
  assert.equal(latest.liveness, "fresh", "no stall suspicion while waiting for the user");
  h.approvalDecision();
  await delay(100);
  assert.equal(h.emitted[h.emitted.length - 1].liveness, "fresh", "clock restarts after decision");
  h.tracker.dispose();
});

await check("liveness: run end resets to fresh/null even from silent", async () => {
  const h = createHarness("claude", { quietAfterMs: 150, silentAfterMs: 300, livenessCheckMs: 50 });
  h.runStarted();
  h.feed("✻ Pondering… (2s)\r\n");
  await delay(450);
  assert.equal(h.emitted[h.emitted.length - 1].liveness, "silent");
  h.runCompleted();
  const final = h.emitted[h.emitted.length - 1];
  assert.equal(final.native, null);
  assert.equal(final.liveness, "fresh");
  h.tracker.dispose();
});

if (failures.length > 0) {
  console.error(`\n${failures.length} status-region-tracker check(s) failed.`);
  process.exit(1);
}
console.log("\nstatus-region-tracker smoke checks passed.");
