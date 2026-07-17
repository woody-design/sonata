// Smoke — the AtomicWriter (single-writer byte integrity). Post-send-is-send
// the ONLY invariant is: a human keystroke arriving mid automation-sequence
// buffers and flushes AFTER it, never interleaving (a split bracketed-paste
// frame is corruption). Delivery is NEVER held on "the human is typing"
// (that inference — isHumanHoldingInput — was deleted); isHumanActivelyTyping
// survives only to gate native-approval reconciliation, checked here too.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalHost } = require("../../dist/runtime");

const taskId = "task-terminal-arbitration-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-arbitration-"));
const scriptPath = path.join(workspace, "fake-cli.mjs");
const inputLogPath = path.join(workspace, "stdin.log");

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

const host = new TerminalHost({
  taskId,
  defaultWorkspace: workspace,
  eventSink: () => {},
});

const failures = [];
function assert(condition, label) {
  if (!condition) {
    failures.push(label);
  }
}
function readLog() {
  return fs.existsSync(inputLogPath) ? fs.readFileSync(inputLogPath, "utf8") : "";
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // A1 — the human types with NO take-over; keystrokes reach the PTY.
  let threw = false;
  try {
    host.writeUserInput("ls\r");
  } catch {
    threw = true;
  }
  assert(!threw, "writeUserInput does not throw without take-over");
  await delay(200);
  assert(readLog().includes("ls"), "user keystrokes reach the PTY without take-over");

  // A2 — typing marks the human as actively typing (delivery's pause signal).
  assert(host.isHumanActivelyTyping() === true, "isHumanActivelyTyping true right after a keystroke");

  // A4 — atomic buffer-flush: a keystroke during an automation write SEQUENCE
  // buffers and flushes AFTER it, so the two byte streams never interleave.
  fs.writeFileSync(inputLogPath, "", "utf8"); // reset the log for a clean ordering read
  host.submitPrompt("AUTOMATION", { createRun: false }); // schedules deferred text+Enter (lock held)
  host.writeUserInput("HUMAN\r"); // arrives mid-sequence → must buffer
  await delay(600); // let the deferred writes + flush complete
  const ordered = readLog();
  const autoAt = ordered.indexOf("AUTOMATION");
  const humanAt = ordered.indexOf("HUMAN");
  assert(autoAt !== -1, "automation paste reached the PTY");
  assert(humanAt !== -1, "buffered human keystrokes flushed to the PTY");
  assert(
    autoAt !== -1 && humanAt !== -1 && autoAt < humanAt,
    "human keystrokes flush AFTER the automation sequence (no interleave)",
  );

  // A3 — after the activity window elapses with no keystroke, the human is no
  // longer "actively typing". (Send-is-send: this does NOT hold delivery — it
  // only gates the native-approval reconciliation pass. Window is 3500ms.)
  await delay(3700);
  assert(
    host.isHumanActivelyTyping() === false,
    "isHumanActivelyTyping false after the activity window elapses",
  );

  // A6 — terminal AUTO-REPLIES (xterm's answers to the CLI's queries) must NOT
  // count as human typing. A redrawing TUI emits cursor-position reports (DSR)
  // constantly; if they marked the human active, the approval-reconciliation
  // pass would fire forever. They still reach the PTY.
  fs.writeFileSync(inputLogPath, "", "utf8");
  host.writeUserInput("\x1b[24;80R"); // DSR cursor-position report
  host.writeUserInput("\x1b[?1;2c"); // device attributes
  assert(
    host.isHumanActivelyTyping() === false,
    "terminal auto-replies (DSR / device attributes) do NOT mark the human active",
  );
  await delay(150);
  assert(readLog().includes("24;80R"), "auto-replies still reach the PTY (the CLI asked)");
  // …but a real keystroke right after still does mark active.
  host.writeUserInput("x");
  assert(host.isHumanActivelyTyping() === true, "a real keystroke after an auto-reply marks active");

  const success = failures.length === 0;
  console.log(JSON.stringify({ success, failures, workspace }, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  host.dispose();
  await delay(200);
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
