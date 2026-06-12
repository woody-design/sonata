// Slice B smoke — ambient modal detection + the speaking gate.
// A fake CLI paints a static panel at startup (no slash, no run). Asserts:
// ambient arming after the quiescence window, delivery blocked by STATE,
// wedge signal fires (injected threshold), dismissModal refuses ambient
// panels (zero Esc bytes), and a native take-over answer clears the modal
// from screen evidence.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DeliveryController, TerminalHost } = require("../../dist/runtime");

const taskId = "task-modal-ambient-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-modal-ambient-"));
const scriptPath = path.join(workspace, "fake-panel-cli.mjs");
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
process.stdout.write("Session preamble text\\n");
process.stdout.write("A native panel headline\\n");
process.stdout.write("\\u276F 1. Option one\\n");
process.stdout.write("  2. Option two\\n");
process.stdout.write("\\n");
process.stdout.write("Esc to cancel\\n");
process.stdin.on("data", (data) => {
  fs.appendFileSync(inputLogPath, data);
  if (data.includes("1")) {
    process.stdout.write("\\nchoice accepted\\n");
    process.stdout.write("\\u25C9 composer back\\n");
    process.stdout.write("\\u2190 for agents\\n");
  }
});
`,
  "utf8",
);

const events = [];
const host = new TerminalHost({
  taskId,
  provider: "claude",
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type !== "pty:data") {
      events.push(event);
    }
  },
});
const delivery = new DeliveryController({
  taskId,
  provider: "claude",
  terminalHost: host,
  eventSink: (event) => events.push(event),
  hasLiveTranscriptSource: () => false,
  wedgeAfterMs: 1200,
  wedgeCheckIntervalMs: 250,
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
    rows: 20,
    cols: 100,
  });

  // Ambient arming: 1.2s confirm + 0.6s quiet — allow margin.
  await waitUntil(() => host.isModalActive(), 6000, "ambient modal arming");
  const armEvent = events.find((e) => e.type === "modal:state" && e.payload.active);
  assert(armEvent?.payload.origin === "ambient", "modal origin is ambient");

  const queued = delivery.enqueue("blocked behind the panel");
  await delay(300);
  assert(delivery.state().deliverable === false, "deliverable=false while panel up");
  assert(delivery.state().modalActive === true, "delivery state reports modalActive");
  assert(
    delivery.state().queue.find((i) => i.id === queued.id)?.status === "queued",
    "item stays queued behind the panel",
  );
  assert(
    throwsWith(() => host.submitPrompt("direct"), "interactive panel"),
    "submitPrompt guarded by panel state",
  );

  // Wedge: queued + blocked + not understandably busy ≥ threshold.
  await waitUntil(() => delivery.state().wedgedSince !== null, 4000, "wedge signal");
  assert(delivery.state().wedgedSince !== null, "wedgedSince set");

  // Ambient panels never get Esc.
  const dismissed = await host.dismissModal();
  assert(dismissed === false, "dismissModal refuses ambient panel");
  assert(!readLog().includes(""), "no Esc byte ever written");

  // Native answer via take-over clears from screen evidence.
  host.setUserControl(true);
  host.writeUserInput("1");
  await waitUntil(() => !host.isModalActive(), 4000, "modal cleared by native answer");
  host.setUserControl(false);
  const clearEvent = events.find((e) => e.type === "modal:state" && !e.payload.active);
  assert(Boolean(clearEvent), "modal:state clear event emitted");
  assert(
    delivery.state().queue.find((i) => i.id === queued.id)?.status === "queued",
    "item never failed through the whole episode",
  );

  const success = failures.length === 0;
  console.log(JSON.stringify({ success, failures }, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  delivery.dispose();
  host.dispose();
  await delay(200);
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function readLog() {
  return fs.existsSync(inputLogPath) ? fs.readFileSync(inputLogPath, "utf8") : "";
}

function throwsWith(fn, fragment) {
  try {
    fn();
    return false;
  } catch (error) {
    return String(error?.message).toLowerCase().includes(fragment);
  }
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
