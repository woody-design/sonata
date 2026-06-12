// Slice A smoke — single-writer take-over guards.
// While the user controls the terminal: delivery holds, every automation
// write path throws the guard error, and ONLY writeUserInput reaches the
// PTY. On hand-back the guards lift and queued items stay queued (never
// failed). P1b made this a safety property: a navigating human can flip the
// idle-prompt heuristic, so the pump must be locked out by state, not luck.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DeliveryController, TerminalHost, USER_CONTROL_GUARD_MESSAGE } = require("../../dist/runtime");

const taskId = "task-terminal-takeover-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-takeover-guard-"));
const scriptPath = path.join(workspace, "fake-cli.mjs");
const inputLogPath = path.join(workspace, "stdin.log");
const queuedPrompt = "queued while the human holds the keys";
const userKeys = "hello-from-takeover\r";

fs.writeFileSync(
  scriptPath,
  `
import fs from "node:fs";
const inputLogPath = ${JSON.stringify(inputLogPath)};
process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdout.write("fake CLI up\\n");
process.stdin.on("data", (data) => {
  fs.appendFileSync(inputLogPath, data);
});
`,
  "utf8",
);

const events = [];
const host = new TerminalHost({
  taskId,
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type !== "pty:data") {
      events.push(event);
    }
  },
});
const delivery = new DeliveryController({
  taskId,
  provider: "codex",
  terminalHost: host,
  eventSink: (event) => events.push(event),
  hasLiveTranscriptSource: () => false,
});

const failures = [];
function assert(condition, label) {
  if (!condition) {
    failures.push(label);
  }
}

try {
  host.startTask({
    cwd: workspace,
    command: process.execPath,
    args: [scriptPath],
    rows: 16,
    cols: 100,
  });
  await delay(400);

  // -- take over ------------------------------------------------------------
  assert(host.setUserControl(true) === true, "setUserControl(true) returns active");
  assert(host.isUserControlActive(), "host reports user control active");
  assert(
    events.some((e) => e.type === "terminal:user-control" && e.payload.active === true),
    "terminal:user-control active event emitted",
  );

  const queued = delivery.enqueue(queuedPrompt);
  await delay(200);
  assert(delivery.state().deliverable === false, "deliverable=false during take-over");
  assert(
    delivery.state().queue.find((i) => i.id === queued.id)?.status === "queued",
    "item stays queued during take-over",
  );

  assert(throwsGuard(() => host.submitPrompt("blocked")), "submitPrompt guarded");
  assert(throwsGuard(() => host.sendApprove()), "sendApprove guarded");
  assert(throwsGuard(() => host.sendDeny()), "sendDeny guarded");
  let stopGuarded = false;
  try {
    await host.stopRun();
  } catch (error) {
    stopGuarded = String(error?.message).includes("controlling the terminal");
  }
  assert(stopGuarded, "stopRun guarded");
  let controlGuarded = false;
  try {
    await host.applyControlChange({ kind: "permission", label: "x", codex: { preset: "fullAccess" } });
  } catch (error) {
    controlGuarded = String(error?.message).includes("controlling the terminal");
  }
  assert(controlGuarded, "applyControlChange guarded");

  // -- the one open path ------------------------------------------------------
  host.writeUserInput(userKeys);
  await delay(300);
  const logDuring = readLog();
  assert(logDuring.includes("hello-from-takeover"), "user keystrokes reach the PTY");
  assert(!logDuring.includes(queuedPrompt), "queued prompt never reaches the PTY during take-over");

  // -- hand back --------------------------------------------------------------
  assert(host.setUserControl(false) === false, "setUserControl(false) returns inactive");
  assert(
    events.some((e) => e.type === "terminal:user-control" && e.payload.active === false),
    "terminal:user-control release event emitted",
  );
  assert(throwsAny(() => host.writeUserInput("x")), "writeUserInput requires take-over");
  const afterRelease = delivery.state().queue.find((i) => i.id === queued.id);
  assert(afterRelease?.status === "queued", "item still queued (never failed) after hand-back");

  // guard lifted: submitPrompt now writes (fake CLI has no idle prompt, so
  // delivery itself stays gated — direct write proves only the guard lifted)
  host.submitPrompt("after-handback", { createRun: false });
  await delay(400);
  assert(readLog().includes("after-handback"), "submitPrompt flows after hand-back");

  const success = failures.length === 0;
  console.log(JSON.stringify({ success, failures, workspace }, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  host.dispose();
  await delay(200);
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function readLog() {
  return fs.existsSync(inputLogPath) ? fs.readFileSync(inputLogPath, "utf8") : "";
}

function throwsGuard(fn) {
  try {
    fn();
    return false;
  } catch (error) {
    return String(error?.message).includes("controlling the terminal") &&
      USER_CONTROL_GUARD_MESSAGE.includes("controlling the terminal");
  }
}

function throwsAny(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
