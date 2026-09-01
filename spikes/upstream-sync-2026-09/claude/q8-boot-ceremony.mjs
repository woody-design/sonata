// Q8 (2026-09 sync, SL-3) — the claude BOOT CEREMONY, measured end to end.
//
// QUESTION: between `spawn` and the first TRUE idle composer, which
// interstitials can own the screen under SONATA'S OWN spawn shape, on which
// side of the alternate-screen switch do they paint, and does Sonata's
// readiness gate (`acceptsPromptInput`) lie about any of them?
//
// The changelog's candidates (fullscreen offer, auto-mode offer,
// managed-settings approval, update notice, usage-credits prompt, plugin/LSP
// suggestions) are HYPOTHESES. This probe measures which of them actually
// paint. A candidate that never appears is recorded as a measured NO-OP with
// its capture — that reasoning is a deliverable too.
//
// WHY A REAL TerminalHost AND NOT THE SPIKE Probe: the question is about
// SONATA'S readiness, not the CLI's screen. `acceptsPromptInput()` short-
// circuits TRUE on the SessionStart hook (terminal-host.ts), which the spike
// driver's bare spawn never delivers — so a bare-spawn measurement could not
// see the interesting failure at all. This drives `dist/` with the production
// args (injected --settings, statusLine, hooks) and samples the real gate.
//
// TWO ARMS, one variable (the config dir):
//   A  production  — the real CLAUDE_CONFIG_DIR (Woody's account state).
//                    What actually happens in the field today.
//   B  rearmed     — a COPY of that config in scratch, with the one-time-offer
//                    counters reset, so offers this account has already
//                    exhausted paint again and their frames can be measured.
//                    The TRIGGER is arranged; the FRAME is real.
// Arm B never touches the real config: the copy is written under
// /private/tmp and handed over via `extraEnv.CLAUDE_CONFIG_DIR`, which
// `ptyEnvironment` deliberately preserves (it strips every CLAUDE_CODE_*).
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path
// embeds the username): these frames become findings/fixtures and the pre-push
// leak fence scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { Terminal } = require("@xterm/headless");
const { TerminalHost, detectIdlePromptForProvider } = require(APP_DIR + "dist/runtime");

const EXPECT_VERSION = "2.1.257";
const ROOT = "/private/tmp/sonata-sync-2026-09/boot-ceremony";
const COLS = 120;
const ROWS = 40;
/** How long to keep watching AFTER the composer first accepts input. The
 *  changelog's update notice is claimed at ~10s post-launch and the credits
 *  prompt at 60s, so the window has to outlast both. */
const POST_READY_WATCH_MS = 90_000;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  value.split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
if (!version.startsWith(EXPECT_VERSION)) {
  console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION}`, version }));
  process.exit(2);
}

// ─── the candidate catalog ────────────────────────────────────────────────
// Every needle is a HYPOTHESIS sourced from the changelog and from strings in
// the 2.1.257 binary (presence-only evidence). The probe's job is to say which
// ones a live boot actually paints. Compacted forms are matched too, because a
// grid row can wrap and the pty stream collapses spacing.
const CANDIDATES = [
  { id: "trust-dialog", why: "SL-1, handled — catalogued for its place in the sequence", re: /Quick safety check|Yes, I trust this folder/i },
  { id: "fullscreen-offer", why: "changelog: accepting RESTARTS the process and drops spawn flags", re: /Try the new fullscreen renderer\?|Yes, try it/i },
  { id: "fullscreen-fallback-notice", why: "binary strings: renderer failed to start, classic renderer in use", re: /fullscreen renderer (didn't finish starting|has repeatedly failed)/i },
  { id: "auto-mode-offer", why: "changelog: one-time 'make auto mode your default'", re: /Make auto mode your default permission mode\?/i },
  { id: "managed-settings-approval", why: "changelog: captured the first keypress while invisible", re: /Managed settings (require approval|need your review)/i },
  { id: "update-installed-notice", why: "changelog: ~10s post-launch", re: /Update installed|Restart to apply/i },
  { id: "usage-credits-prompt", why: "changelog: Fable first use; auto-selects a fallback after 60s", re: /usage credits/i },
  { id: "plugin-notice", why: "MEASURED incidentally in q5's post-turn tail", re: /Plugin updated:|\/reload-plugins/i },
  { id: "plugin-recommendation", why: "binary strings: a modal with 'Yes, install' rows", re: /Plugin recommendation|suggests installing a plugin|Would you like to install it\?/i },
  { id: "api-spend-notice", why: "binary strings: 'Got it, thanks!' acknowledgement modal", re: /You've spent \$\d+ on the Anthropic API|Got it, thanks!/i },
  { id: "lsp-suggestion", why: "changelog: plugin/LSP install suggestions", re: /language server|install the recommended/i },
  { id: "login-ceremony", why: "a logged-out spawn is a different ceremony entirely (SL-x)", re: /Select login method|Log in with your Claude account/i },
  { id: "release-notes", why: "'What's new' interstitials churn every release", re: /What's new in Claude Code|Release notes/i },
  // Shape-level needles: anything that PAINTS LIKE A MODAL. These catch an
  // interstitial the changelog never mentioned — the whole point of a sweep.
  { id: "shape:enter-to-confirm", why: "generic modal footer", re: /Enter to confirm/i },
  { id: "shape:esc-to-cancel", why: "generic modal footer", re: /Esc to cancel/i },
  { id: "shape:yes-no-rows", why: "generic two-row consent", re: /❯\s*(Yes|No)\b/ },
];

async function run(armName) {
  const runRoot = path.join(ROOT, armName);
  fs.rmSync(runRoot, { recursive: true, force: true });
  const workspace = path.join(runRoot, `fresh-${Date.now()}`);
  const runtimeDir = path.join(runRoot, "runtime");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const extraEnv = REARM_ARMS[armName]
    ? { CLAUDE_CONFIG_DIR: rearmConfig(runRoot, armName) }
    : undefined;

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

  const t0 = Date.now();
  const at = () => Date.now() - t0;
  /** Which screen buffer the CLI is painting on RIGHT NOW, tracked off the
   *  stream: `?1049h` enters the alternate screen, `?1049l` leaves it. F3
   *  measured 2.1.252 switching AFTER the trust grant, so an interstitial's
   *  side of that switch is a real distinguishing fact about it. */
  let altScreen = false;
  let raw = "";
  const stream = [];
  const events = [];
  let ptyExited = false;
  let exitInfo = null;

  const host = new TerminalHost({
    taskId: `task-q8-boot-${armName}`,
    provider: "claude",
    defaultWorkspace: workspace,
    eventSink: (event) => {
      if (event.type === "pty:data") {
        const data = event.payload.data;
        raw += data;
        term.write(data);
        for (const match of data.matchAll(/\x1b\[\?1049([hl])/g)) {
          altScreen = match[1] === "h";
          stream.push({ atMs: at(), marker: match[1] === "h" ? "ALT-SCREEN ENTER (?1049h)" : "ALT-SCREEN LEAVE (?1049l)" });
        }
        return;
      }
      if (event.type === "report:updated") return;
      if (event.type === "pty:exit") {
        ptyExited = true;
        exitInfo = event.payload;
      }
      events.push({ atMs: at(), type: event.type, payload: compactPayload(event) });
    },
  });

  const out = {
    arm: armName,
    version,
    workspace: workspace.replace(/fresh-\d+$/, "fresh-<ts>"),
    configDir: extraEnv?.CLAUDE_CONFIG_DIR ?? "<real ~/.claude>",
    rearmSpec: REARM_ARMS[armName] ?? null,
    frames: [],
    candidateFirstSeen: {},
    readyTransitions: [],
    stream,
    events,
  };

  try {
    host.startTask({
      // Sonata's OWN spawn shape — no command/args override, so buildArgs
      // injects the real --settings (statusLine + hooks). approvalBroker is
      // left UNSET on purpose: that is broker-OFF at the host (an explicit
      // `true` is required), which is the mode whose scrape can see the trust
      // screen at all. Production's broker-ON mode is measured separately in q9.
      cwd: workspace,
      runtimeDir,
      permissionMode: "default",
      rows: ROWS,
      cols: COLS,
      ...(extraEnv ? { extraEnv } : {}),
    });

    let lastFrame = null;
    let lastReady = null;
    let readyAt = null;
    let trustAnswered = false;

    const deadline = Date.now() + 60_000; // boot budget until first ready
    for (;;) {
      const now = Date.now();
      if (readyAt === null && now > deadline) break;
      if (readyAt !== null && now - readyAt > POST_READY_WATCH_MS) break;
      if (ptyExited) break;

      const frameText = screen();
      const ready = host.acceptsPromptInput();

      // Candidate first-sightings, recorded against the SCREEN (a state query
      // belongs on the grid — D-1) and, separately, the raw stream, so an
      // interstitial that flashes between two samples is still caught.
      for (const candidate of CANDIDATES) {
        if (out.candidateFirstSeen[candidate.id]) continue;
        const onGrid = matches(candidate.re, frameText);
        const onStream = matches(candidate.re, raw);
        if (!onGrid && !onStream) continue;
        out.candidateFirstSeen[candidate.id] = {
          atMs: at(),
          why: candidate.why,
          channel: onGrid ? (onStream ? "grid+stream" : "grid") : "stream-only",
          altScreen,
          sonataReadyWhileOnScreen: onGrid ? ready : null,
          matchedLines: matchedLines(candidate.re, frameText),
        };
      }

      if (ready !== lastReady) {
        out.readyTransitions.push({
          atMs: at(),
          acceptsPromptInput: ready,
          altScreen,
          rawScrape: detectIdlePromptForProvider(raw, "claude"),
          gridScrape: detectIdlePromptForProvider(frameText, "claude"),
          screen: frameText,
        });
        lastReady = ready;
        if (ready && readyAt === null) readyAt = now;
      }

      if (frameText !== lastFrame) {
        out.frames.push({ atMs: at(), altScreen, acceptsPromptInput: ready, screen: frameText });
        lastFrame = frameText;
      }

      // Answer the trust dialog with the COMMITTED production walk — the same
      // path a user's Approve tap takes. Never a blind key (SL-1).
      if (!trustAnswered && events.some((e) => e.type === "approval:detected" && e.payload?.kind === "workspace-trust")) {
        trustAnswered = true;
        out.trustAnsweredAtMs = at();
        void host.sendApprove().catch((error) => {
          out.trustApproveError = String(error?.message ?? error);
        });
      }

      await delay(150);
    }

    out.reachedReady = lastReady === true;
    out.readyAtMs = readyAt === null ? null : readyAt - t0;
    out.ptyExited = ptyExited;
    out.exitInfo = exitInfo;

    // ─── composer input ARMING ─────────────────────────────────────────────
    // SL-1 measured a ≤500ms arming window on the TRUST dialog (a Down at +0ms
    // was swallowed). Does the COMPOSER have one of its own? Sonata's boot
    // latch opens on `acceptsPromptInput()`, so a composer that is on screen
    // but not yet listening is a silently-dropped first prompt.
    if (out.reachedReady && !ptyExited) {
      out.composerArming = await measureComposerArming(host, screen);
    }
  } catch (error) {
    out.error = String(error?.message ?? error);
    out.screenAtFailure = screen();
  } finally {
    host.dispose();
  }

  return out;
}

/** Type a marker one character at a time and record, per character, whether it
 *  had echoed into the composer by the time the next one went out. A swallow
 *  shows up as a gap between "written" and "echoed". */
async function measureComposerArming(host, screen) {
  const marker = "SONATAARM";
  const perChar = [];
  for (const ch of marker) {
    const wroteAt = Date.now();
    host.writeRaw(ch);
    await delay(120);
    perChar.push({ ch, echoedWithinMs: screenHasMarkerPrefix(screen(), marker, perChar.length + 1) ? Date.now() - wroteAt : null });
  }
  await delay(800);
  const settled = screen();
  const landed = settled.replace(/\s+/g, "").includes(marker);
  // Leave the composer clean: erase exactly what was typed. No Enter — this
  // probe never submits anything to the model.
  for (let i = 0; i < marker.length; i++) host.writeRaw("\x7f");
  await delay(500);
  return {
    marker,
    perChar,
    allCharsLanded: landed,
    firstCharEchoedInMs: perChar[0]?.echoedWithinMs ?? null,
    swallowedChars: perChar.filter((entry) => entry.echoedWithinMs === null).length,
    composerAfterErase: screen().split("\n").filter((line) => line.includes("❯")).map((line) => line.trimEnd()),
  };
}

function screenHasMarkerPrefix(text, marker, count) {
  return text.replace(/\s+/g, "").includes(marker.slice(0, count));
}

/** Reset the one-time-offer bookkeeping in a COPY of the user's config so
 *  offers this account already exhausted paint again.
 *
 *  Read from ~/.claude.json at 2.1.257 (`jq keys`): `fullscreenUpsellSeenCount`
 *  is 3 and the binary's gate is `(fullscreenUpsellSeenCount ?? 0) >= 3 →
 *  don't show`; the auto-mode offer is fenced by two booleans that are both
 *  already true. Those readings are GREP/CONFIG evidence — hypotheses about
 *  the TRIGGER. What this arm measures is the FRAME, which is real. */
// The two re-armed arms. Both copy the config; they differ in WHAT they reset,
// so a candidate that paints in one and not the other is attributable.
//
// FIDELITY LIMIT, MEASURED — a scratch CLAUDE_CONFIG_DIR is LOGGED OUT. This
// account keeps its credentials in the macOS Keychain keyed to the DEFAULT
// config dir, so `claude auth status --json` under the copy reports
// `loggedIn:false, authMethod:"none"` and the boot header reads "API Usage
// Billing" instead of "Claude Max". Client-side interstitials (the renderer
// offer, the release-notes notice) are unaffected and their frames are real;
// anything ACCOUNT-GATED (the auto-mode offer, the usage-credits prompt,
// managed settings) is NOT validly measured in these arms, and a NOT-SEEN
// there is not evidence of absence for those.
const REARM_ARMS = {
  rearmed: {
    why: "re-arm the one-time RENDERER offer this account exhausted (fullscreenUpsellSeenCount 3 >= the binary's cap of 3) and clear its recorded answer",
    config: {
      fullscreenUpsellSeenCount: 0,
      passesUpsellSeenCount: 0,
      hasResetAutoModeOptInForDefaultOffer: false,
      hasSeenAutoModeEntryWarning: false,
      lastReleaseNotesSeen: "2.1.100",
      announcementImpressions: {},
      seenNotifications: {},
    },
    // `tui: "fullscreen"` is the offer's RECORDED ANSWER — this account took
    // it, which is why F3 found fullscreen simply ON with no offer. Deleted so
    // the offer has something to ask about.
    deleteSettings: ["tui"],
  },
  "notes-only": {
    why: "the PRODUCTION-REACHABLE case: every auto-update leaves lastReleaseNotesSeen stale, so this notice paints for a real user on the next launch. Renderer answer left INTACT so the notice is measured alone.",
    config: { lastReleaseNotesSeen: "2.1.100" },
    deleteSettings: [],
  },
};

function rearmConfig(runRoot, armName) {
  const spec = REARM_ARMS[armName];
  const configDir = path.join(runRoot, "claude-config");
  fs.mkdirSync(configDir, { recursive: true });
  // CLAUDE_CONFIG_DIR relocates the whole config home, `.claude.json` included.
  const source = JSON.parse(fs.readFileSync(path.join(HOME, ".claude.json"), "utf8"));
  fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ ...source, ...spec.config }));
  const settingsPath = path.join(HOME, ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    for (const key of spec.deleteSettings) delete settings[key];
    fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(settings, null, 2));
  }
  return configDir;
}

function matches(re, text) {
  return re.test(text) || re.test(text.replace(/\s+/g, " "));
}

function matchedLines(re, text) {
  return text
    .split("\n")
    .filter((line) => re.test(line))
    .map((line) => line.trimEnd())
    .slice(0, 6);
}

function compactPayload(event) {
  const payload = event.payload ?? {};
  const keep = {};
  for (const key of ["kind", "decision", "encodedAs", "previousKind", "reason", "exitCode", "signal", "sonataInitiated"]) {
    if (payload[key] !== undefined) keep[key] = payload[key];
  }
  return keep;
}

function summarize(out) {
  return {
    arm: out.arm,
    version: out.version,
    configDir: out.configDir,
    reachedReady: out.reachedReady,
    readyAtMs: out.readyAtMs,
    trustAnsweredAtMs: out.trustAnsweredAtMs ?? null,
    ptyExited: out.ptyExited,
    frameCount: out.frames.length,
    candidates: Object.fromEntries(
      CANDIDATES.map((candidate) => [
        candidate.id,
        out.candidateFirstSeen[candidate.id]
          ? {
              atMs: out.candidateFirstSeen[candidate.id].atMs,
              channel: out.candidateFirstSeen[candidate.id].channel,
              altScreen: out.candidateFirstSeen[candidate.id].altScreen,
              sonataReadyWhileOnScreen: out.candidateFirstSeen[candidate.id].sonataReadyWhileOnScreen,
              lines: out.candidateFirstSeen[candidate.id].matchedLines,
            }
          : "NOT SEEN",
      ]),
    ),
    composerArming: out.composerArming
      ? {
          allCharsLanded: out.composerArming.allCharsLanded,
          firstCharEchoedInMs: out.composerArming.firstCharEchoedInMs,
          swallowedChars: out.composerArming.swallowedChars,
        }
      : null,
    error: out.error ?? null,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Entry point last: `run` reaches the REARM_* consts below it, so the call has
// to sit past their initialization.
const arm = process.argv[2] ?? "production";
const result = await run(arm);
const outPath = path.join(OUT_DIR, `q8-boot-ceremony.${arm}.capture.txt`);
fs.writeFileSync(outPath, sanitize(JSON.stringify(result, null, 2)));
console.log(sanitize(JSON.stringify(summarize(result), null, 2)));
console.log(`\nwrote ${outPath}`);
process.exit(result.reachedReady ? 0 : 1);
