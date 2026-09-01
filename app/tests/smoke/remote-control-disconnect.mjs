// Smoke: does TerminalHost's integrated state detection flip RC to OFF when the
// session is DISCONNECTED in claude's own native panel (the in-app path)? Drives
// real `claude`: connect via injectRemoteControl, then open the panel and select
// "Disconnect this session", asserting a remote-control:state {active:false}.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalHost } = require("../../dist/runtime");

const taskId = "task-rc-disconnect-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-rc-disc-smoke-"));

let rawTail = "";
let trustApproved = false;
const rcStates = [];

const host = new TerminalHost({
  taskId,
  provider: "claude",
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data") {
      rawTail = `${rawTail}${event.payload.data}`.slice(-64 * 1024);
      return;
    }
    if (event.type === "approval:detected" && event.payload.kind === "workspace-trust") {
      trustApproved = true;
      // See claude-terminalhost.mjs: awaitable walk, sync dispatch — log, never
      // leave an unhandled rejection.
      void host.sendApprove().catch((error) => console.error("sendApprove failed:", error));
    }
    if (event.type === "remote-control:state") {
      rcStates.push({ active: event.payload.active, url: event.payload.url, at: Date.now() });
    }
  },
});

try {
  host.startTask({ cwd: workspace, permissionMode: "default", rows: 36, cols: 120 });
  // Boot readiness = the structural composer gate (the boot-latch fence),
  // same as production's delivery pump. `task:ready` no longer fires at boot
  // (the between-runs poller was retired in S6 — it only rides quiescence
  // run completions now).
  await waitUntil(() => trustApproved || host.acceptsPromptInput(), 120000, "Claude startup");
  await waitUntil(() => host.acceptsPromptInput(), 120000, "Claude accepts input");

  // Connect.
  host.injectRemoteControl();
  await waitUntil(() => rcStates.some((s) => s.active && s.url), 45000, "RC connected (url)");

  // Open claude's native panel, then navigate Up Up to "Disconnect this session" + Enter.
  host.injectRemoteControl();
  await delay(1400);
  host.writeRaw("\x1b[A");
  await delay(600);
  host.writeRaw("\x1b[A");
  await delay(600);
  host.writeRaw("\r");

  await waitUntil(() => rcStates.some((s) => !s.active), 30000, "RC disconnected (state off)");

  const connected = rcStates.find((s) => s.active && s.url);
  const disconnected = rcStates.find((s, i) => !s.active && i > rcStates.indexOf(connected));
  const sawDisconnectLine = cleanish(rawTail).includes("Remote Control disconnected");
  const success = Boolean(connected) && Boolean(disconnected) && sawDisconnectLine;

  console.log(
    JSON.stringify(
      {
        connected: Boolean(connected),
        disconnectedStateEvent: Boolean(disconnected),
        sawDisconnectLine,
        rcStateSequence: rcStates.map((s) => (s.active ? "on" : "off")),
        success,
      },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
} finally {
  host.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
}

function cleanish(text) {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, " ");
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
