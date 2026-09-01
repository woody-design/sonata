// Q10 (2026-09 sync, SL-3) — why does `tests/smoke/native-image-attachments.mjs`
// not reach a claude composer?
//
// SL-1 recorded it as pre-existing collateral ("never answers the new trust
// dialog — SL-3"). But the smoke ALREADY listens for `approval:detected` and
// calls `sendApprove()`, and SL-1 landed the grid-verified walk that call now
// uses — so the claim needs re-measuring against the current build rather than
// re-asserting.
//
// This mirrors the smoke's `startHost("claude", …)` BYTE FOR BYTE (same cwd
// class — `os.tmpdir()` mkdtemp, same start options, same approval listener,
// same readiness wait) and reports WHERE it stops, with the frame. It runs only
// the claude half: the smoke's codex half is broken at 0.152.0 for unrelated
// reasons (SL-6/7/8) and eats the whole time budget before claude is reached,
// which is itself part of why this went unmeasured.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { TerminalHost, cleanTerminal } = require(APP_DIR + "dist/runtime");

const EXPECT_VERSION = "2.1.257";
const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  value.split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
if (!version.startsWith(EXPECT_VERSION)) {
  console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION}`, version }));
  process.exit(2);
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-native-image-smoke-"));
const workspace = path.join(workspaceRoot, "claude-image-delivery");
fs.mkdirSync(workspace, { recursive: true });

let exited = false;
let raw = "";
const timeline = [];
const t0 = Date.now();
const at = () => Date.now() - t0;

let host = null;
const host_ = new TerminalHost({
  taskId: "native-image-claude-image-delivery",
  provider: "claude",
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data") {
      raw = `${raw}${event.payload.data}`.slice(-96_000);
      return;
    }
    if (event.type === "report:updated") return;
    if (event.type === "pty:exit") exited = true;
    timeline.push({ atMs: at(), type: event.type, kind: event.payload?.kind ?? null, decision: event.payload?.decision ?? null });
    // Byte-identical to the smoke's listener.
    if (event.type === "approval:detected" && event.payload.kind === "workspace-trust") {
      setTimeout(() => {
        void host.sendApprove().catch((error) => timeline.push({ atMs: at(), type: "sendApprove:error", error: String(error?.message ?? error) }));
      }, 0);
    }
  },
});
host = host_;

const result = { version, workspace: workspace.replace(workspaceRoot, "<mkdtemp>") };
try {
  // The smoke's own claude start options.
  host.startTask({
    cwd: workspace,
    rows: 42,
    cols: 140,
    permissionMode: "default",
    model: "opus",
    reasoningEffort: "xhigh",
  });

  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline && !ready && !exited) {
    ready = host.acceptsPromptInput();
    await delay(250);
  }
  result.reachedReady = ready;
  result.readyAtMs = ready ? at() : null;
  result.ptyExited = exited;
  result.timeline = timeline;
  result.approvalDetected = timeline.some((e) => e.type === "approval:detected");
  result.approvalDecision = timeline.find((e) => e.type === "approval:decision")?.decision ?? null;
  result.brokerOn = host.approvalBrokerOn ?? null;
  result.tail = cleanTerminal(raw).slice(-2500);
} catch (error) {
  result.error = String(error?.message ?? error);
} finally {
  host.dispose();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

const outPath = path.join(OUT_DIR, "q10-image-smoke-claude-boot.capture.txt");
fs.writeFileSync(outPath, sanitize(JSON.stringify(result, null, 2)));
console.log(sanitize(JSON.stringify(result, null, 2)));
console.log(`\nwrote ${outPath}`);
process.exit(result.reachedReady ? 0 : 1);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
