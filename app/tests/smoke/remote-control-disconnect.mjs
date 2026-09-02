// Smoke: does TerminalHost's integrated state detection flip RC to OFF when the
// session is DISCONNECTED in claude's own native panel (the in-app path)? Drives
// real `claude`: connect via injectRemoteControl, then open the panel and select
// "Disconnect this session", asserting a remote-control:state {active:false}.
//
// RE-DERIVED at claude 2.1.258 (upstream sync 2026-09-01, SL-11; probes
// rc3/rc5/rc6). Three things this test used to assume are no longer true, and
// each cost it a way to fail silently:
//
//  1. The session link no longer arrives whole in the pty stream — the
//     differential repaint elides characters already correct on the grid, so
//     the URL is read off `screenModel` now (see findRemoteControlUrlOnScreen).
//     That is what this test was failing on: MEASURED, injecting at the
//     composer edge, the stream never produced the link in 45s while the grid
//     had it at +761ms. It is asserted here through the production host, not
//     re-implemented.
//  2. `injectRemoteControl()` can REFUSE (no-process / panel-open / busy). The
//     old version dropped the return value, so a refusal read as a timeout on a
//     completely different assertion. It is checked now.
//  3. The panel walk was three blind keystrokes. The panel's row order is
//     measured stable (Disconnect / Show QR code / Continue, cursor on
//     Continue), but a blind Enter on a moved menu would answer the WRONG row —
//     and on this panel one of the wrong rows is a QR code and the other is a
//     no-op, so it would look like a detection failure. The walk verifies the
//     focused row on a real grid before committing, the same discipline the
//     trust-dialog walk uses.
//
// Context worth knowing while reading a failure: RC can already be CONNECTED at
// boot without `--remote-control` — auto-start resolves from org policy / a
// server-side default that Sonata does not control (SL-11 objective 4). Either
// way the injection lands on the panel, so this test does not depend on which;
// it records what it saw.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  TerminalHost,
  compactRemoteControlScan,
  hasRemoteControlDisconnect,
  normalizeTerminalDimensions,
} = require("../../dist/runtime");
const { TaskScreenModel } = require("../../dist/runtime/terminal-host/task-screen-model");

const taskId = "task-rc-disconnect-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-rc-disc-smoke-"));
const ROWS = 36;
const COLS = 120;

let rawTail = "";
let trustApproved = false;
const rcStates = [];
// The test's own grid, fed the same bytes the host feeds its screen model — so
// the panel walk can SEE the focused row instead of counting keystrokes.
const screen = new TaskScreenModel(normalizeTerminalDimensions(COLS, ROWS));

const host = new TerminalHost({
  taskId,
  provider: "claude",
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data") {
      rawTail = `${rawTail}${event.payload.data}`.slice(-64 * 1024);
      screen.write(event.payload.data);
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
  host.startTask({ cwd: workspace, permissionMode: "default", rows: ROWS, cols: COLS });
  // Boot readiness = the structural composer gate (the boot-latch fence),
  // same as production's delivery pump. `task:ready` no longer fires at boot
  // (the between-runs poller was retired in S6 — it only rides quiescence
  // run completions now).
  await waitUntil(() => trustApproved || host.acceptsPromptInput(), 120000, "Claude startup");
  await waitUntil(() => host.acceptsPromptInput(), 120000, "Claude accepts input");
  // Whether the boot connected RC on its own. Recorded, never asserted: it is
  // decided by org policy / a server-side default, so pinning it would make
  // this test fail on someone else's rollout.
  const autoStartedAtBoot = /connecting…/.test(cleanish(rawTail));

  // ONE injection. At 2.1.258 `/remote-control` connects AND opens the native
  // panel in the same move (MEASURED, rc3/rc5 — and it is what production's
  // `manageRemoteControl` relies on). A second injection is not a second panel:
  // it DISMISSES the open one and types `/remote-control` into the composer
  // behind it, which is what the old two-inject version did — every keystroke
  // after that went to a composer, not a menu.
  assertInject(host.injectRemoteControl(), "connect + open panel");
  await waitUntil(() => rcStates.some((s) => s.active && s.url), 45000, "RC connected (url)");
  // …but do not ASSUME the panel: rc3 measured one reconnect that came back with
  // the banner and no panel. Ask for it, and only re-inject if it is genuinely
  // absent — once, so a panel-less build fails loudly instead of looping.
  await ensurePanelOpen();
  const panelBefore = panelRows();
  await walkToDisconnectRow();
  host.writeRaw("\r");

  await waitUntil(() => rcStates.some((s) => !s.active), 30000, "RC disconnected (state off)");

  const connected = rcStates.find((s) => s.active && s.url);
  const disconnected = rcStates.find((s, i) => !s.active && i > rcStates.indexOf(connected));
  // The OFF signal must be legible in the STREAM — that is the channel
  // detectRemoteControlState reads it on, and (unlike the link) it must stay
  // there: the grid keeps showing this line long after a reconnect. Asserted
  // through the PRODUCTION predicate, not a hand-rolled substring: claude
  // word-POSITIONS this line, so the receipt reaches the stream with no spaces
  // in it at all and a `includes("Remote Control disconnected")` on
  // whitespace-collapsed text is looking for a form that is not sent.
  const sawDisconnectLine = hasRemoteControlDisconnect(compactRemoteControlScan(rawTail));
  const success = Boolean(connected) && Boolean(disconnected) && sawDisconnectLine;

  console.log(
    JSON.stringify(
      {
        autoStartedAtBoot,
        connected: Boolean(connected),
        disconnectedStateEvent: Boolean(disconnected),
        sawDisconnectLine,
        panelRowsBeforeWalk: panelBefore,
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
  screen.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
}

/** A refusal is a distinct failure from a timeout — say which one happened. */
function assertInject(result, what) {
  if (!result?.ok) {
    throw new Error(`injectRemoteControl refused (${what}): ${JSON.stringify(result)}`);
  }
}

/** claude's RC panel rows as the grid renders them, or null when the panel is
 *  not on screen. MEASURED at 2.1.258 (rc3): a heading, the session-link line,
 *  then Disconnect / Show QR code / Continue with `❯` on Continue. */
function panelRows() {
  const rows = screen
    .viewportText()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /Disconnect this session|Show QR code|Continue$/.test(line));
  return rows.some((line) => /Disconnect this session/.test(line)) ? rows : null;
}

/** The panel is normally already up from the connect injection; if it is not,
 *  ask once more. Bounded on purpose — a second injection while the panel IS up
 *  would close it, so this must never become a retry loop. */
async function ensurePanelOpen() {
  if (await settles(() => panelRows() !== null, 6000)) {
    return;
  }
  assertInject(host.injectRemoteControl(), "open panel (retry)");
  await waitUntil(() => panelRows() !== null, 20000, "RC panel on screen");
}

/** Like waitUntil but returns false on expiry instead of throwing. */
async function settles(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(200);
  }
  return false;
}

/** Press Up until `❯` sits on "Disconnect this session", re-reading the grid
 *  after each press. Bounded, and it fails naming the rows it could see — a
 *  panel that changed shape must not present as a detection bug. */
async function walkToDisconnectRow() {
  const focused = () =>
    screen
      .viewportText()
      .split("\n")
      .some((line) => /❯\s*Disconnect this session/.test(line));
  for (let i = 0; i < 6 && !focused(); i++) {
    host.writeRaw("\x1b[A");
    await delay(600);
  }
  if (!focused()) {
    throw new Error(`Could not focus "Disconnect this session"; panel rows: ${JSON.stringify(panelRows())}`);
  }
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
