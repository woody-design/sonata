// Q36 (2026-09 sync, SL-18) — the claude fullscreen-offer BANNER, live.
//
// QUESTION: does the SL-18 surface actually fire against a real claude boot
// parked on the fullscreen-renderer offer — the watchdog raising
// `claude-fullscreen-offer:detected` while the boot latch holds, and the
// grid-watch retiring it with `claude-fullscreen-offer:cleared` the moment the
// HUMAN answers in the terminal — or does it only work on fixtures?
//
// The smoke (tests/smoke/claude-boot-interstitial.mjs §4–6) pins the surface on
// MEASURED frames through a real TaskScreenModel. What it cannot pin is the
// wiring in wall-clock time: that the 4s watchdog lands INSIDE a real offer
// window rather than before it paints or after it is answered, and that the
// answering repaint actually arms the coalesced approval scan the clearing pass
// rides. Both are timing claims about a live pty. This probe measures them.
//
// WHY A REAL TerminalHost: the same reason q8/q9 use one — the question is about
// SONATA's state machine, not the CLI's screen. This drives `dist/` with the
// production spawn shape (injected --settings, statusLine, hooks), arms the real
// boot watchdog, and reads the real event stream.
//
// RE-ARMING (q8 arm B, verbatim): the offer is one-time per account and this
// machine's has been answered (`fullscreenUpsellSeenCount` 3 ≥ the binary's cap
// of 3, and `settings.json` records `tui: "fullscreen"`). A COPY of the config
// under a scratch `CLAUDE_CONFIG_DIR` — which `ptyEnvironment` deliberately
// preserves while stripping every `CLAUDE_CODE_*` — zeroes the counter and drops
// the recorded answer. The real `~/.claude` is never written. The TRIGGER is
// arranged; the FRAME, the timings, and every event below are real.
//
// FIDELITY LIMIT, inherited and restated rather than glossed: the copy boots
// LOGGED OUT (credentials live in the macOS Keychain keyed to the DEFAULT config
// dir), so the header reads API-billing and the composer's footer says
// `Not logged in`. The renderer offer is a CLIENT-SIDE choice and is unaffected —
// which is exactly why this arm is valid for THIS question and would not be for
// an account-gated one.
//
// THE ANSWER IS THE PROBE STANDING IN FOR THE HUMAN, and it goes through
// `writeUserInput` — the same host method the CLI window's xterm `onData` calls
// for a keystroke, i.e. the user's own channel. It is `Down` then `Enter`, which
// selects `2. Not now`: a real answer that leaves the process alone (the affirm
// row re-execs the CLI in place — measured F8 — which would confound the timing
// this probe is here to read). Sonata's own paths never write here; the probe
// asserts that directly by recording EVERY byte reaching the pty and checking the
// window between the offer appearing and the probe's own keystrokes is empty.
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path
// embeds the username): the capture becomes a finding and the pre-push leak
// fence scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { Terminal } = require("@xterm/headless");
const { TerminalHost } = require(APP_DIR + "dist/runtime");

const ROOT = "/private/tmp/sonata-sync-2026-09/fullscreen-offer-banner";
const COLS = 120;
const ROWS = 40;
/** Budget for the offer to paint AND the 4s watchdog to elapse. A healthy boot
 *  reaches the composer at ~1.4s and the offer paints at ~0.94s (F7), so this is
 *  ~5× the whole window it is waiting on. */
const DETECT_BUDGET_MS = 30_000;
/** Budget for the answering repaint to reach the clearing pass. That pass rides
 *  the 120ms approval-scan cadence, so anything past a second here is a finding. */
const CLEAR_BUDGET_MS = 20_000;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();

const out = {
  probe: "q36-fullscreen-offer-banner-live",
  version,
  // Recorded, never asserted: the fixtures this surface was built on are 2.1.257
  // and the binary has since moved. A drift here is context for reading the
  // numbers below, not a reason to refuse.
  fixtureVersion: "2.1.257",
  events: [],
  writes: [],
  timeline: {},
  verdicts: {},
};

const runRoot = path.join(ROOT, "rearmed");
fs.rmSync(runRoot, { recursive: true, force: true });
const workspace = path.join(runRoot, `fresh-${Date.now()}`);
const runtimeDir = path.join(runRoot, "runtime");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(runtimeDir, { recursive: true });

const configDir = rearmConfig(runRoot);
out.configDir = sanitize(configDir);

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 4000 });
const screen = () => {
  const buffer = term.buffer.active;
  const lines = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    lines.push(line ? line.translateToString(true) : "");
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
};

const t0 = Date.now();
const at = () => Date.now() - t0;
let ptyExited = false;
let trustAnswered = false;

const host = new TerminalHost({
  taskId: "task-q36-fullscreen-offer-banner",
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
    if (event.type === "pty:exit") {
      ptyExited = true;
    }
    out.events.push({ atMs: at(), type: event.type });
  },
});

try {
  host.startTask({
    // Sonata's OWN spawn shape — no command/args override, so buildArgs injects
    // the real --settings (statusLine + hooks). `approvalBroker` left UNSET =
    // broker-OFF at the host, the mode whose scrape can see the trust screen at
    // all (q8's choice, for the same reason).
    cwd: workspace,
    runtimeDir,
    permissionMode: "default",
    rows: ROWS,
    cols: COLS,
    extraEnv: { CLAUDE_CONFIG_DIR: configDir },
  });

  // Record EVERY byte that reaches the pty, whoever writes it. Wrapped after
  // startTask so the wrapper sees the live process; this is the live counterpart
  // of the smoke's byte-level RED LINE assertion.
  const proc = host.ptyProcess;
  const innerWrite = proc.write.bind(proc);
  proc.write = (data) => {
    out.writes.push({ atMs: at(), bytes: JSON.stringify(data).slice(0, 200) });
    return innerWrite(data);
  };

  // ─── phase 1: the offer paints, the latch holds, the watchdog speaks ──────
  let offerFirstSeenAtMs = null;
  let readyWhileOfferOpen = null;
  const detectDeadline = Date.now() + DETECT_BUDGET_MS;
  for (;;) {
    if (ptyExited) break;
    if (Date.now() > detectDeadline) break;

    if (offerFirstSeenAtMs === null && host.isFullscreenOfferOpen()) {
      offerFirstSeenAtMs = at();
      // The SL-3 hold, read at the instant the offer owns the grid. This is the
      // fact the banner exists to explain, so the probe records it rather than
      // assuming it.
      readyWhileOfferOpen = host.acceptsPromptInput();
      out.offerFrame = sanitize(screen());
    }

    if (detected()) break;

    // Answer the workspace-trust dialog with the COMMITTED production walk — the
    // same path a user's Approve tap takes, never a blind key (SL-1). The offer
    // paints AFTER the trust grant, so without this the ceremony never reaches it.
    if (
      !trustAnswered &&
      out.events.some((e) => e.type === "approval:detected")
    ) {
      trustAnswered = true;
      out.timeline.trustAnsweredAtMs = at();
      void host.sendApprove().catch((error) => {
        out.trustApproveError = sanitize(error?.message ?? error);
      });
    }

    await delay(100);
  }

  out.timeline.offerFirstSeenAtMs = offerFirstSeenAtMs;
  out.timeline.detectedAtMs = detected()?.atMs ?? null;
  out.readyWhileOfferOpen = readyWhileOfferOpen;

  // ─── phase 2: the HUMAN answers, the banner retires ───────────────────────
  if (detected()) {
    const writesBeforeAnswer = out.writes.length;
    // Down, then Enter → `2. Not now`. Through `writeUserInput`, the human's own
    // channel. Two calls with a beat between them, because SL-1 measured a ≤500ms
    // input-arming window on the neighbouring trust dialog and a swallowed Down
    // would leave the cursor on the affirm row, whose Enter re-execs the CLI.
    out.timeline.answerAtMs = at();
    host.writeUserInput("\x1b[B");
    await delay(400);
    host.writeUserInput("\r");
    out.answerWrites = out.writes.slice(writesBeforeAnswer).map((w) => w.bytes);

    const clearDeadline = Date.now() + CLEAR_BUDGET_MS;
    for (;;) {
      if (cleared() || ptyExited) break;
      if (Date.now() > clearDeadline) break;
      await delay(100);
    }
    out.timeline.clearedAtMs = cleared()?.atMs ?? null;
    out.postAnswerFrame = sanitize(screen());
  }

  // ─── verdicts ─────────────────────────────────────────────────────────────
  const detectedEvents = out.events.filter((e) => e.type === "claude-fullscreen-offer:detected");
  const clearedEvents = out.events.filter((e) => e.type === "claude-fullscreen-offer:cleared");

  out.verdicts.offerReproduced = offerFirstSeenAtMs !== null;
  out.verdicts.latchHeldOnOffer = readyWhileOfferOpen === false;
  out.verdicts.detectedExactlyOnce = detectedEvents.length === 1;
  out.verdicts.clearedExactlyOnce = clearedEvents.length === 1;
  out.verdicts.clearedAfterAnswer =
    out.timeline.clearedAtMs !== null &&
    out.timeline.answerAtMs !== undefined &&
    out.timeline.clearedAtMs >= out.timeline.answerAtMs;
  // The live RED LINE: between the offer owning the grid and the probe's own two
  // keystrokes, NOTHING reached the pty. (Sonata's trust-dialog walk writes
  // earlier, at ~0.8s — a legitimate write to a different screen, and outside
  // this window by construction.)
  out.verdicts.noSonataWriteWhileOfferOpen =
    offerFirstSeenAtMs === null ||
    out.timeline.answerAtMs === undefined ||
    out.writes.every(
      (w) => w.atMs < offerFirstSeenAtMs || w.atMs >= out.timeline.answerAtMs,
    );
  out.verdicts.offerGoneAfterAnswer = !host.isFullscreenOfferOpen();

  out.success = Object.values(out.verdicts).every(Boolean);
} catch (error) {
  out.success = false;
  out.error = sanitize(error?.stack ?? error);
} finally {
  host.dispose();
  fs.rmSync(runRoot, { recursive: true, force: true });
}

const capture = path.join(OUT_DIR, "q36-fullscreen-offer-banner-live.capture.txt");
fs.writeFileSync(capture, JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    {
      probe: out.probe,
      version: out.version,
      success: out.success,
      timeline: out.timeline,
      verdicts: out.verdicts,
      error: out.error ?? null,
      capture: capture.split("/").slice(-1)[0],
    },
    null,
    2,
  ),
);
process.exit(out.success ? 0 : 1);

function detected() {
  return out.events.find((e) => e.type === "claude-fullscreen-offer:detected") ?? null;
}

function cleared() {
  return out.events.find((e) => e.type === "claude-fullscreen-offer:cleared") ?? null;
}

/** q8 arm B, verbatim: a COPY of the config home with the one-time renderer
 *  offer's counter zeroed and its recorded answer dropped. `CLAUDE_CONFIG_DIR`
 *  relocates the whole config home, `.claude.json` included. The real `~/.claude`
 *  is read and never written. */
function rearmConfig(root) {
  const dir = path.join(root, "claude-config");
  fs.mkdirSync(dir, { recursive: true });
  const source = JSON.parse(fs.readFileSync(path.join(HOME, ".claude.json"), "utf8"));
  fs.writeFileSync(
    path.join(dir, ".claude.json"),
    JSON.stringify({
      ...source,
      fullscreenUpsellSeenCount: 0,
      passesUpsellSeenCount: 0,
      hasResetAutoModeOptInForDefaultOffer: false,
      hasSeenAutoModeEntryWarning: false,
      announcementImpressions: {},
      seenNotifications: {},
    }),
  );
  const settingsPath = path.join(HOME, ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    // `tui: "fullscreen"` is the offer's RECORDED ANSWER — this account took it,
    // which is why the offer does not paint in the field. Deleted so the offer
    // has something to ask about.
    delete settings.tui;
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  }
  return dir;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
