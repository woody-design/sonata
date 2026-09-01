// Q4 (2026-09 sync, SL-1) — the FIX, exercised against the real binary.
//
// q3 measured the dialog and proved both of Sonata's old approve keys exit the
// CLI. This drives the PRODUCTION code — a real `TerminalHost` from `dist/`,
// spawning a real `claude` with Sonata's own args — through the whole path a
// user's Approve tap takes: detect → surface → `sendApprove()` → grid-verified
// walk → confirm. Pass = trust actually granted, session alive, composer up.
//
// It also writes the two MEASURED grid frames the smoke fixtures are pinned on:
//   trust-2.1.252.txt                — the dialog as painted (❯ on "No, exit")
//   trust-2.1.252-affirm-focused.txt — after the walk's arrow (❯ on the affirm row)
// Both are captured from THIS session's screen model input, so they are the
// bytes production actually parses.
//
// Scratch dir is /private/tmp/... (not the agent scratchpad, whose path embeds
// the username): these frames become TRACKED test fixtures and the pre-push
// leak fence scans blob content.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { Terminal } = require("@xterm/headless");
const { TerminalHost } = require(APP_DIR + "dist/runtime");

const EXPECT_VERSION = "2.1.252";
const ROOT = "/private/tmp/sonata-sync-2026-09/trust-fix-live";
const COLS = 120;
const ROWS = 40;

const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
if (!version.startsWith(EXPECT_VERSION)) {
  console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION}`, version }));
  process.exit(2);
}

fs.rmSync(ROOT, { recursive: true, force: true });
const workspace = path.join(ROOT, `fresh-${Date.now()}`);
const runtimeDir = path.join(ROOT, "runtime");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(runtimeDir, { recursive: true });

// A local mirror of the grid, fed from the host's own pty:data events — the
// probe's only window onto what the host is parsing (the screen model is private).
const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 4000 });
const screen = () => {
  const b = term.buffer.active;
  const lines = [];
  for (let y = 0; y < term.rows; y++) {
    const line = b.getLine(b.viewportY + y);
    lines.push(line ? line.translateToString(true) : "");
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
};

const events = [];
let ptyExited = false;
const host = new TerminalHost({
  taskId: "task-q4-trust-fix-live",
  provider: "claude",
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data") {
      term.write(event.payload.data);
      return;
    }
    if (event.type === "report:updated") {
      return;
    }
    // `pty:exit` is the event terminal-host emits — the whole point of this
    // probe is that the CLI does NOT exit, so the spelling has to be right.
    if (event.type === "pty:exit") {
      ptyExited = true;
    }
    events.push(event);
  },
});

const result = { version, workspace: workspace.replace(/fresh-\d+$/, "fresh-<ts>") };
try {
  host.startTask({
    // Sonata's OWN spawn shape: no command/args override, so buildArgs injects
    // the real --settings (statusLine included — the F5 suppressor is present,
    // exactly as in the field).
    approvalBroker: false, // native-approval mode: the scrape/keys path this slice fixes
    cwd: workspace,
    runtimeDir,
    permissionMode: "default",
    rows: ROWS,
    cols: COLS,
  });

  const detected = await waitUntil(
    () => events.find((e) => e.type === "approval:detected" && e.payload.kind === "workspace-trust"),
    60_000,
    "workspace-trust approval:detected",
  );
  result.detectedChoices = detected.payload.choices?.map((c) => `${c.decision}:${c.encodedAs}`);

  // The dialog as painted, before ANY key — fixture #1.
  const virgin = screen();
  fs.writeFileSync(path.join(OUT_DIR, "q4-grid-virgin.txt"), virgin);
  result.virginRows = optionRowSummary(virgin);

  // Watch for the walk's arrow landing so the affirm-focused frame can be
  // captured mid-walk — fixture #2. Polls the mirror while sendApprove runs.
  let affirmFrame = null;
  const watcher = setInterval(() => {
    if (affirmFrame) return;
    const s = screen();
    if (/❯\s*Yes, I trust this folder/.test(s)) affirmFrame = s;
  }, 40);

  const approveStartedAt = Date.now();
  await host.sendApprove();
  result.approveResolvedInMs = Date.now() - approveStartedAt;
  clearInterval(watcher);
  if (affirmFrame) {
    fs.writeFileSync(path.join(OUT_DIR, "q4-grid-affirm-focused.txt"), affirmFrame);
    result.affirmRows = optionRowSummary(affirmFrame);
  }

  const decision = await waitUntil(
    () =>
      events.find(
        (e) =>
          e.type === "approval:decision" &&
          e.payload.previousKind === "workspace-trust" &&
          e.payload.decision === "approve",
      ),
    10_000,
    "approval:decision(approve)",
  );
  result.decisionEncodedAs = decision.payload.encodedAs;

  // Trust granted = the CLI moved past the dialog into its session, and did NOT
  // exit. `? for shortcuts` is suppressed by Sonata's statusLine (F5), so the
  // landing evidence is the boot header + the composer frame.
  const reachedSession = await waitUntil(
    () => (/Claude Code v/.test(screen()) || /for agents/.test(screen()) ? true : null),
    30_000,
    "post-trust session screen",
  );
  await delay(1500);
  result.reachedSession = Boolean(reachedSession);
  result.ptyExited = ptyExited;
  result.trustRowsGone = !/Quick safety check/.test(screen());
  result.finalScreen = screen();

  result.success =
    result.decisionEncodedAs === "grid-verified Arrow + CR" &&
    result.reachedSession &&
    result.trustRowsGone &&
    !result.ptyExited;
} catch (error) {
  result.success = false;
  result.error = String(error && error.message ? error.message : error);
  result.screenAtFailure = screen();
} finally {
  host.dispose();
}

fs.writeFileSync(path.join(OUT_DIR, "q4-trust-fix-live.capture.txt"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.success ? 0 : 1);

function optionRowSummary(text) {
  return text
    .split("\n")
    .filter((l) => /No, exit|Yes, I trust this folder/.test(l))
    .map((l) => l.trimEnd());
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
