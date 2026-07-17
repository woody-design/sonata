// CLI Slice 4 — Problem 2 regression lock (live claude). The keystone bug: the
// FIRST /architect <multiline> in a new task hung (no turn). This drives the
// PRODUCTION TerminalHost + DeliveryController exactly as RuntimeController does,
// on a fresh untrusted cwd, enqueues `/architect <multiline>` before the
// composer is ready, and asserts a real model turn DISPATCHES.
//
// Runtime-level (not the GUI) so it is deterministic — no drawer/floor PTY
// repaint timing. The renderer→IPC→delivery handoff is covered by the GUI e2e
// (cli-slash-semantic). Together they cover prepend → compose → submit →
// dispatch end to end.
//
//   npm run e2e:cli-slash-dispatch
//
// Requires a logged-in `claude` (network).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalHost, DeliveryController, cleanTerminal } = require("../../dist/runtime");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-slash-dispatch-"));
const hooksDir = path.join(cwd, ".sonata", "hooks");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const MULTILINE = [
  "/architect I'm sketching a tiny two-way-door UI choice and want your instinct.",
  "",
  "Context:",
  "- low blast radius, easy to change later",
  "- no files need reading",
  "",
  "Give me a 2-sentence gut read. Do not read any files or run any tools.",
].join("\n");

function hookEvents() {
  try {
    return fs
      .readdirSync(hooksDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(hooksDir, f), "utf8")).hook_event_name ?? null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const ACTIVITY_RE = /esc to interrupt|✢|✳|✶|✻|✽|thinking|cerebrating|levitating|forming|accomplishing/i;

let raw = "";
const checks = {};

const host = new TerminalHost({
  taskId: "slash-dispatch",
  provider: "claude",
  defaultWorkspace: cwd,
  eventSink: (event) => {
    if (event.type === "pty:data") {
      raw = `${raw}${event.payload.data}`.slice(-1024 * 1024);
    }
    delivery.handleRuntimeEvent(event); // faithful to RuntimeController
  },
});
const delivery = new DeliveryController({
  taskId: "slash-dispatch",
  provider: "claude",
  terminalHost: host,
  eventSink: () => {},
  hasLiveTranscriptSource: () => false,
  // Keep this real-spawn dispatch e2e in its pre-fix behavior: no 500ms boot
  // grace, no auto Enter re-sends into the live CLI (the boot-race mechanisms
  // have their own fences).
  bootDeliveryGraceMs: 0,
  enterRetryDelaysMs: [],
});

try {
  host.startTask({ cwd, rows: 40, cols: 120 }); // production buildArgs → hooks injected
  const item = delivery.enqueue(MULTILINE);
  checks.enqueued = item.status === "queued";

  let trustHandled = false;
  let dispatchedAtMs = null;
  const t0 = Date.now();
  const deadline = t0 + 120000;
  while (Date.now() < deadline) {
    if (!trustHandled && host.isApprovalActive()) {
      try {
        host.sendApprove();
        trustHandled = true;
      } catch {
        // ignore — retry on the next tick
      }
    }
    const ev = hookEvents();
    if (
      ev.includes("UserPromptSubmit") ||
      ev.includes("PreToolUse") ||
      ev.includes("Stop") ||
      ACTIVITY_RE.test(cleanTerminal(raw))
    ) {
      dispatchedAtMs = Date.now() - t0;
      break;
    }
    await delay(250);
  }

  checks.dispatched = dispatchedAtMs !== null;
  checks.dispatchedAtMs = dispatchedAtMs;
  checks.userPromptSubmitFired = hookEvents().filter((e) => e === "UserPromptSubmit").length;

  const success = checks.enqueued && checks.dispatched;
  if (!success) {
    fs.writeFileSync(path.join(cwd, "screen.txt"), cleanTerminal(raw).slice(-16000), "utf8");
    checks.screen = path.join(cwd, "screen.txt");
  }
  console.log(JSON.stringify({ success, checks }, null, 2));
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ success: false, checks, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  delivery.dispose();
  host.dispose();
  await delay(500);
  if (process.exitCode === 0) {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  process.exit(process.exitCode);
}
