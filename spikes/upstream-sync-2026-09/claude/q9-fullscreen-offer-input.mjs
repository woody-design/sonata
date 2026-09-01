// Q9 (2026-09 sync, SL-3) — the fullscreen-renderer offer: what it does with
// input, and what answering it does to SONATA'S SPAWN.
//
// q8 measured that the offer exists, paints on the NORMAL screen between the
// trust grant and the alt-screen switch, and that `acceptsPromptInput()` stays
// false while it is up. This probe answers the three questions a GUARD depends
// on:
//
//   B  invisible capture — does the screen swallow a printable keypress the way
//      the changelog claims the managed-settings prompt does? (If it does, no
//      guard can make it safe and the finding goes back to Woody as policy.)
//   C  what a DELIVERY would do — bracketed paste + CR is exactly what Sonata
//      writes when the boot latch opens. At this screen the CR answers the
//      FOCUSED row, which is `1. Yes, try it`. Measured end to end, including
//      whether the process survives and whether Sonata's spawn flags do.
//   D  the safe answer — `2. Not now` reaches the composer.
//
// Every case runs against a COPY of the config in /private/tmp with the offer
// re-armed (see q8's rearmConfig rationale); the real ~/.claude is never
// written. The copy is logged out (Keychain credentials are keyed to the
// default config dir) — irrelevant here, because the renderer offer is a
// client-side choice, and case C's question is about the PROCESS, not the
// account.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { Terminal } = require("@xterm/headless");
const { TerminalHost, BRACKETED_PASTE_START, BRACKETED_PASTE_END } = require(APP_DIR + "dist/runtime");

const EXPECT_VERSION = "2.1.257";
const ROOT = "/private/tmp/sonata-sync-2026-09/fullscreen-offer";
const COLS = 120;
const ROWS = 40;
const OFFER_RE = /Try the new fullscreen renderer\?/;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  value.split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
if (!version.startsWith(EXPECT_VERSION)) {
  console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION}`, version }));
  process.exit(2);
}

const cases = {};
cases.B = await caseInvisibleCapture();
cases.C = await caseDeliveryIntoOffer();
cases.D = await caseSafeDecline();

const out = { version, cases };
const outPath = path.join(OUT_DIR, "q9-fullscreen-offer-input.capture.txt");
fs.writeFileSync(outPath, sanitize(JSON.stringify(out, null, 2)));
console.log(sanitize(JSON.stringify(summarize(out), null, 2)));
console.log(`\nwrote ${outPath}`);
process.exit(0);

// ── B: does the offer swallow a printable keypress? ─────────────────────────
async function caseInvisibleCapture() {
  const session = await bootToOffer("invisible-capture");
  try {
    const before = session.screen();
    // A printable char that answers NOTHING here: the rows are addressed by
    // `1`/`2` and confirmed with Enter, so `x` is the honest no-op probe.
    session.host.writeRaw("x");
    await delay(900);
    const after = session.screen();
    const changedOnScreen = before !== after;

    // Now leave the offer by the SAFE door and look for `x` in the composer. If
    // the offer buffered the keypress invisibly, it lands there.
    session.host.writeRaw("2");
    await delay(300);
    session.host.writeRaw("\r");
    const reached = await session.waitFor(/❯/, 30_000, { afterAltScreen: true });
    await delay(1500);
    const composer = session.screen();
    return {
      name: "a printable keypress at the offer",
      screenChanged: changedOnScreen,
      reachedComposer: reached,
      keystrokeResurfacedInComposer: /❯\s*x/.test(composer),
      offerScreen: before,
      screenAfterKeypress: after,
      composerScreen: composer,
    };
  } finally {
    session.dispose();
  }
}

// ── C: what a Sonata DELIVERY does at the offer ─────────────────────────────
async function caseDeliveryIntoOffer() {
  const session = await bootToOffer("delivery-into-offer");
  try {
    const argvBefore = psArgs(session.pid);
    const offerScreen = session.screen();
    // Byte-for-byte what DeliveryController writes at an open boot latch: a
    // bracketed paste, then the submit CR.
    const payload = "SONATA_DELIVERY_INTO_OFFER";
    session.host.writeRaw(`${BRACKETED_PASTE_START}${payload}${BRACKETED_PASTE_END}`);
    await delay(400);
    const afterPaste = session.screen();
    session.host.writeRaw("\r");
    await delay(6000);
    const afterEnter = session.screen();
    const argvAfter = psArgs(session.pid);
    await delay(4000);
    return {
      name: "bracketed paste + CR at the offer (what delivery writes)",
      pid: session.pid,
      argvBefore,
      argvAfter,
      argvSurvived: argvBefore !== null && argvBefore === argvAfter,
      processStillAlive: argvAfter !== null,
      ptyExited: session.state.ptyExited,
      pasteVisibleOnOffer: afterPaste.includes(payload),
      offerAnsweredByTheEnter: !OFFER_RE.test(afterEnter),
      payloadReachedAComposer: /❯\s*SONATA_DELIVERY_INTO_OFFER/.test(afterEnter) || afterEnter.includes(payload),
      settingsAfter: readScratchSettings(session.configDir),
      offerScreen,
      screenAfterPaste: afterPaste,
      screenAfterEnter: afterEnter,
      finalScreen: session.screen(),
    };
  } finally {
    session.dispose();
  }
}

// ── D: the safe answer reaches a composer ───────────────────────────────────
async function caseSafeDecline() {
  const session = await bootToOffer("safe-decline");
  try {
    session.host.writeRaw("2");
    await delay(300);
    const focused = session.screen();
    session.host.writeRaw("\r");
    const reached = await session.waitFor(/❯/, 30_000, { afterAltScreen: true });
    await delay(1500);
    return {
      name: "answer `2. Not now` and reach the composer",
      digitMovedTheCursor: /❯\s*2\.\s*Not now/.test(focused),
      reachedComposer: reached,
      readyAfter: session.host.acceptsPromptInput(),
      settingsAfter: readScratchSettings(session.configDir),
      screenAfterDigit: focused,
      finalScreen: session.screen(),
    };
  } finally {
    session.dispose();
  }
}

// ── harness ─────────────────────────────────────────────────────────────────

/** Spawn with Sonata's production args against a freshly re-armed config copy,
 *  answer the trust dialog with the committed production walk, and stop at the
 *  fullscreen offer. */
async function bootToOffer(name) {
  const runRoot = path.join(ROOT, name);
  fs.rmSync(runRoot, { recursive: true, force: true });
  const workspace = path.join(runRoot, "workspace");
  const runtimeDir = path.join(runRoot, "runtime");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const configDir = rearmConfig(runRoot);

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

  const state = { ptyExited: false, altScreenEntered: false };
  const events = [];
  const host = new TerminalHost({
    taskId: `task-q9-${name}`,
    provider: "claude",
    defaultWorkspace: workspace,
    eventSink: (event) => {
      if (event.type === "pty:data") {
        term.write(event.payload.data);
        if (event.payload.data.includes("\x1b[?1049h")) state.altScreenEntered = true;
        return;
      }
      if (event.type === "pty:exit") state.ptyExited = true;
      events.push(event);
    },
  });

  const started = host.startTask({
    cwd: workspace,
    runtimeDir,
    permissionMode: "default",
    rows: ROWS,
    cols: COLS,
    extraEnv: { CLAUDE_CONFIG_DIR: configDir },
  });

  const session = {
    host,
    screen,
    state,
    configDir,
    pid: started.pid,
    dispose: () => host.dispose(),
    waitFor: async (re, timeoutMs, { afterAltScreen = false } = {}) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((!afterAltScreen || state.altScreenEntered) && re.test(screen())) return true;
        if (state.ptyExited) return false;
        await delay(120);
      }
      return false;
    },
  };

  // Trust, via the committed production walk.
  const deadline = Date.now() + 60_000;
  let trustAnswered = false;
  while (Date.now() < deadline) {
    if (!trustAnswered && events.some((e) => e.type === "approval:detected" && e.payload.kind === "workspace-trust")) {
      trustAnswered = true;
      void host.sendApprove().catch(() => {});
    }
    if (OFFER_RE.test(screen())) break;
    if (state.ptyExited) break;
    await delay(120);
  }
  if (!OFFER_RE.test(screen())) {
    host.dispose();
    throw new Error(`q9/${name}: the fullscreen offer never painted.\n\n${sanitize(screen())}`);
  }
  // Past the arming window the trust dialog showed (SL-1: a key at +0ms is
  // swallowed). Same courtesy here, so a swallow in case B is a real finding
  // about the offer and not about our timing.
  await delay(1200);
  return session;
}

function rearmConfig(runRoot) {
  const configDir = path.join(runRoot, "claude-config");
  fs.mkdirSync(configDir, { recursive: true });
  const source = JSON.parse(fs.readFileSync(path.join(HOME, ".claude.json"), "utf8"));
  fs.writeFileSync(
    path.join(configDir, ".claude.json"),
    JSON.stringify({ ...source, fullscreenUpsellSeenCount: 0 }),
  );
  const settingsPath = path.join(HOME, ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    delete settings.tui;
    fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(settings, null, 2));
  }
  return configDir;
}

/** The scratch config's own record of what the offer decided. */
function readScratchSettings(configDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8")).tui ?? null;
  } catch {
    return null;
  }
}

/** The live argv of the spawned CLI. If accepting the offer re-execs the
 *  process, this is where Sonata's `--settings`/`--session-id` would go
 *  missing; if it exits, this returns null. */
function psArgs(pid) {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function summarize(out) {
  return {
    version: out.version,
    B_invisibleCapture: {
      screenChanged: out.cases.B.screenChanged,
      keystrokeResurfacedInComposer: out.cases.B.keystrokeResurfacedInComposer,
      reachedComposer: out.cases.B.reachedComposer,
    },
    C_deliveryIntoOffer: {
      pasteVisibleOnOffer: out.cases.C.pasteVisibleOnOffer,
      offerAnsweredByTheEnter: out.cases.C.offerAnsweredByTheEnter,
      payloadReachedAComposer: out.cases.C.payloadReachedAComposer,
      processStillAlive: out.cases.C.processStillAlive,
      ptyExited: out.cases.C.ptyExited,
      argvSurvived: out.cases.C.argvSurvived,
      argvBefore: out.cases.C.argvBefore,
      argvAfter: out.cases.C.argvAfter,
      tuiSettingAfter: out.cases.C.settingsAfter,
    },
    D_safeDecline: {
      digitMovedTheCursor: out.cases.D.digitMovedTheCursor,
      reachedComposer: out.cases.D.reachedComposer,
      readyAfter: out.cases.D.readyAfter,
      tuiSettingAfter: out.cases.D.settingsAfter,
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
