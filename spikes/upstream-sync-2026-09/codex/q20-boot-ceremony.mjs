// Q20 (2026-09 sync, SL-6) — the CODEX boot ceremony at 0.152.0, measured end
// to end under SONATA'S OWN spawn shape.
//
// QUESTION: between `startTask` and the first idle composer that actually
// accepts input, which interstitials can own the screen, when, and does Sonata's
// readiness gate (`acceptsPromptInput`) lie about any of them? Codex's 0.148
// startup was reworked (startup_prefetch / startup_hooks_review, B4) and the
// trust screen's trigger conditions moved upstream, so every claim in the
// inventory's codex boot rows is a HYPOTHESIS until a live frame says otherwise.
//
// WHY THE PRODUCTION TerminalHost: the question is about SONATA'S readiness, not
// codex's screen. `acceptsPromptInput()` short-circuits on the SessionStart hook
// — which only fires because Sonata injects a hook profile — so a bare-binary
// spawn (the 2026-08 rig) structurally cannot see the interesting failure.
//
// THREE ARMS, one variable each:
//   production        real CODEX_HOME + real ~/.sonata/bin + pretrustCwd set.
//                     The field case, byte-for-byte. The user's real profile
//                     file is snapshotted before and restored after, so the
//                     probe's own scratch cwd cannot linger in their ledger.
//   fresh-untrusted   isolated CODEX_HOME (auth seeded, NO config.toml) and
//                     pretrustCwd NULL → the directory-trust dialog MUST paint.
//                     This is the arm that catalogues the dialog and asks
//                     whether Sonata's boot guard still holds readiness shut
//                     while it is up.
//   fresh-pretrusted  the same isolated home WITH Sonata's ledger entry → the
//                     dialog must NOT paint. This is the live half of the
//                     pre-trust verification: it proves a `[projects."<cwd>"]`
//                     `trust_level = "trusted"` block in a `-p sonata` PROFILE
//                     layer still suppresses the screen at 0.152.0.
//
// Scratch lives in /private/tmp (never the agent scratchpad, whose path embeds
// the username): these frames become findings and the pre-push fence scans blob
// content.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  CodexBoot,
  EXPECT_CODEX_VERSION,
  assertCodexVersion,
  codexVersion,
  cleanTerminal,
  compact,
  detectIdlePromptForProvider,
  isCodexTrustDialog,
  seedCodexHome,
  sanitize,
  sleep,
  writeCapture,
} from "./driver.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const ROOT = "/private/tmp/sonata-sync-2026-09/codex-boot";
const COLS = 120;
const ROWS = 40;
/** How long to keep watching AFTER the composer first accepts input. Codex's
 *  update prompt and model-migration screen are both post-bootstrap, so the
 *  window has to outlast the app-server handshake rather than stop at it. */
const POST_READY_WATCH_MS = 45_000;
const BOOT_BUDGET_MS = 90_000;

// ─── the candidate catalog ────────────────────────────────────────────────
// Every needle is a HYPOTHESIS read off the tag-pinned source (`rust-v0.152.0`,
// shallow clone) — presence in the source is not evidence a live boot paints it.
// The probe's job is to say which ones actually appear under the production
// spawn. A candidate that never shows is recorded as a measured NO-OP with its
// capture; that reasoning is a deliverable too.
const CANDIDATES = [
  {
    id: "trust-dialog",
    why: "onboarding/trust_directory.rs — the screen Sonata pre-trusts away",
    re: /Do you trust the contents of this directory\?|\d\.\s*Yes, continue\b/i,
  },
  {
    id: "hooks-review",
    why: "startup_hooks_review.rs — REWORKED at 0.148 (B4); a 3-row screen whose row 1 cursor is `›`",
    re: /Hooks need review|Trust all and continue|Continue without trusting|Review hooks/i,
  },
  {
    id: "bypass-hook-trust-warning",
    why: "app/tests snapshot — the banner Sonata's own --dangerously-bypass-hook-trust raises",
    re: /dangerously-bypass-hook-trust. is enabled|Enabled hooks may run without/i,
  },
  {
    id: "login-onboarding",
    why: "0.148 rework: 'onboarding appears when authentication is missing'",
    re: /Sign in with ChatGPT|Sign in with Device Code|Use an OpenAI API key|Finish signing in via your browser/i,
  },
  { id: "welcome", why: "onboarding/welcome.rs", re: /Welcome to Codex/i },
  {
    id: "update-prompt",
    why: "update_prompt.rs — Sonata suppresses it via check_for_update_on_startup=false ONLY when it owns updates",
    re: /Update available!|Skip until next version|Update now \(runs/i,
  },
  {
    id: "model-migration",
    why: "model_migration.rs — a full-screen 'Try new model' / 'Use existing model' picker",
    re: /Codex just got an upgrade|Try new model|Use existing model/i,
  },
  {
    id: "cwd-prompt",
    why: "cwd_prompt.rs — a resume-time working-directory chooser",
    re: /Choose working directory to|Use session directory|Always use current directory/i,
  },
  { id: "unarchive-prompt", why: "unarchive_prompt.rs", re: /This conversation is archived/i },
  {
    id: "external-agent-migration",
    why: "external_agent_config_migration — an import wizard that can own the boot screen",
    re: /Import selected|Customize selection|Import skills from/i,
  },
  {
    id: "full-access-consent",
    why: "the 2026-08 headline dialog — not a boot screen, but it shares the row grammar",
    re: /Enable full access\?/i,
  },
  {
    id: "config-load-error",
    why: "a config the CLI cannot load exits before any composer",
    re: /Error loading config\.toml|Error loading configuration/i,
  },
  // Shape-level needles: anything that PAINTS LIKE A MODAL. These catch an
  // interstitial the source read never suggested — the point of a sweep.
  {
    id: "shape:enter-confirm-esc-back",
    why: "generic codex modal footer (hooks review, full-access consent, pickers)",
    re: /Press enter to confirm or esc to go back/i,
  },
  {
    id: "shape:press-enter-to-continue",
    why: "the trust dialog's footer, and a bootDialogHints needle",
    re: /Press enter to continue/i,
  },
  {
    id: "shape:numbered-cursor-row",
    why: "`› 1. …` — codex's selection-list grammar, and the glyph collision that makes a boot list look like a composer",
    re: /›\s*\d\.\s/,
  },
];

/** The codex `bootDialogHints` set as terminal-host ships it TODAY. Re-walked
 *  against live frames rather than grepped: presence-only evidence is not
 *  acceptance (the 2026-08 lesson). */
const BOOT_DIALOG_HINTS = [
  "press enter to continue",
  "yes, continue",
  "yes,continue",
  "no, quit",
  "no,quit",
];

const ARMS = {
  production: {
    why: "the field case — real CODEX_HOME, real ~/.sonata/bin, pretrustCwd set exactly as runtime-controller's policy sets it",
    isolate: false,
    pretrust: true,
  },
  "fresh-untrusted": {
    why: "isolated CODEX_HOME, auth seeded, NO ledger — the trust dialog must paint",
    isolate: true,
    pretrust: false,
  },
  "fresh-pretrusted": {
    why: "the same isolated home WITH Sonata's ledger entry — the dialog must not paint",
    isolate: true,
    pretrust: true,
  },
};

async function run(armName) {
  const spec = ARMS[armName];
  const runRoot = path.join(ROOT, armName);
  fs.rmSync(runRoot, { recursive: true, force: true });
  const workspace = path.join(runRoot, "workspace");
  const runtimeDir = path.join(runRoot, "runtime");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const realCodexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const codexHome = spec.isolate ? seedCodexHome(path.join(runRoot, "codex-home")) : null;
  // The production arm uses the REAL shim dir, so the hook command strings in the
  // profile are the ones the user's own sessions carry (write-if-changed then
  // touches nothing). Isolated arms get their own so the profile they write is
  // provably self-contained.
  const binDir = spec.isolate
    ? path.join(runRoot, "bin")
    : path.join(os.homedir(), ".sonata", "bin");

  // The production arm regenerates the user's REAL sonata.config.toml (that is
  // what a production spawn does). Snapshot it so the probe's scratch cwd cannot
  // linger in their ledger afterwards.
  const realProfilePath = path.join(realCodexHome, "sonata.config.toml");
  const profileBackup =
    !spec.isolate && fs.existsSync(realProfilePath)
      ? fs.readFileSync(realProfilePath, "utf8")
      : null;

  const boot = new CodexBoot({
    taskId: `task-q20-${armName}`,
    cwd: workspace,
    runtimeDir,
    binDir,
    pretrustCwd: spec.pretrust ? workspace : null,
    codexHome,
    rows: ROWS,
    cols: COLS,
    // Production runs the codex approval broker ON.
    approvalBroker: true,
  });

  const out = {
    arm: armName,
    why: spec.why,
    version: codexVersion(),
    workspace,
    codexHome: codexHome ?? "<real ~/.codex>",
    binDir,
    pretrustCwd: spec.pretrust ? workspace : null,
    args: null,
    profileToml: null,
    /** The pty tail EXACTLY as production's readiness scan sees it, snapshotted
     *  at the two instants that decide the boot guard: the first frame the trust
     *  dialog owns, and the first instant Sonata calls the composer ready. */
    rawAtDialog: null,
    rawAtFirstReady: null,
    frames: [],
    candidateFirstSeen: {},
    readyTransitions: [],
    events: null,
    trustDialogGridVerdicts: [],
    bootHintWalk: null,
    composerArming: null,
  };

  try {
    const started = await boot.start();
    out.args = started.args;
    out.command = started.command;
    // What `ensureCodexRuntimeSettings` actually wrote for this spawn — the
    // ledger half is the artifact objective 3 is about.
    const profilePath = path.join(codexHome ?? realCodexHome, "sonata.config.toml");
    out.profileToml = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf8") : null;

    let lastFrame = null;
    let lastReady = null;
    let readyAt = null;
    const deadline = Date.now() + BOOT_BUDGET_MS;
    for (;;) {
      const now = Date.now();
      if (readyAt === null && now > deadline) break;
      if (readyAt !== null && now - readyAt > POST_READY_WATCH_MS) break;
      if (boot.ptyExited) break;

      const frameText = boot.screen();
      const ready = boot.ready();

      for (const candidate of CANDIDATES) {
        if (out.candidateFirstSeen[candidate.id]) continue;
        const onGrid = matches(candidate.re, frameText);
        const onStream = matches(candidate.re, boot.raw);
        if (!onGrid && !onStream) continue;
        out.candidateFirstSeen[candidate.id] = {
          atMs: boot.at(),
          why: candidate.why,
          channel: onGrid ? (onStream ? "grid+stream" : "grid") : "stream-only",
          sonataReadyWhileOnScreen: onGrid ? ready : null,
          matchedLines: matchedLines(candidate.re, frameText),
        };
      }

      // The production trust-dialog predicate, on the channel it is contracted
      // to read (D-1: a state query belongs on the grid).
      const trustOnGrid = isCodexTrustDialog(frameText);
      if (trustOnGrid && out.rawAtDialog === null) {
        out.rawAtDialog = boot.raw;
      }
      if (
        trustOnGrid !==
        (out.trustDialogGridVerdicts.at(-1)?.isCodexTrustDialog ?? null)
      ) {
        out.trustDialogGridVerdicts.push({
          atMs: boot.at(),
          isCodexTrustDialog: trustOnGrid,
          acceptsPromptInput: ready,
        });
      }

      if (ready !== lastReady) {
        out.readyTransitions.push({
          atMs: boot.at(),
          acceptsPromptInput: ready,
          rawScrape: detectIdlePromptForProvider(boot.raw, "codex"),
          gridScrape: detectIdlePromptForProvider(frameText, "codex"),
          screen: frameText,
        });
        lastReady = ready;
        if (ready && readyAt === null) {
          readyAt = now;
          out.rawAtFirstReady = boot.raw;
        }
      }

      if (frameText !== lastFrame) {
        out.frames.push({ atMs: boot.at(), acceptsPromptInput: ready, screen: frameText });
        lastFrame = frameText;
      }

      await sleep(120);
    }

    out.reachedReady = lastReady === true;
    out.readyAtMs = readyAt === null ? null : readyAt - boot.t0;
    out.ptyExited = boot.ptyExited;
    out.exitInfo = boot.exitInfo;
    out.events = boot.events;

    // ── the bootDialogHints re-walk ────────────────────────────────────────
    // Against LIVE frames, in BOTH the forms the production needle scan uses:
    // the raw window and the fully-compacted one. Run over the frame that
    // carried the dialog when there was one, and over the whole stream
    // otherwise, so a NOT-FOUND is attributable.
    out.bootHintWalk = walkBootHints(out, boot);

    // ── composer input ARMING ──────────────────────────────────────────────
    // #38641 hardened codex against buffered input at startup, and every
    // interactive screen now calls `discard_pending_input_before_interactive_
    // screen()`. So: once Sonata's gate says the composer accepts input, does
    // it? A composer that is painted but not yet listening is a silently
    // dropped first prompt.
    if (out.reachedReady && !boot.ptyExited) {
      out.composerArming = await measureComposerArming(boot);
    }
  } catch (error) {
    out.error = String(error?.stack ?? error?.message ?? error);
    out.screenAtFailure = boot.screen();
  } finally {
    boot.dispose();
    await sleep(400);
    if (profileBackup !== null) {
      // Restore the user's ledger byte-for-byte. A production spawn legitimately
      // folds its cwd in; a PROBE's scratch cwd has no business surviving it.
      fs.writeFileSync(realProfilePath, profileBackup, "utf8");
    }
  }

  out.scrollback = boot.scrollback();
  return out;
}

/**
 * Walk each `bootDialogHints` needle over the LIVE evidence.
 *
 * THE HAYSTACK IS PRODUCTION'S, not a convenient one. `detectIdlePrompt` builds
 * it as `cleanTerminal(rawTail).slice(-8000).toLowerCase()` — cleaned and
 * lowercased but NOT whitespace-stripped — and then matches each hint together
 * with `compactText(hint)` against that one haystack. So a space-bearing needle
 * ("no, quit") and its comma-tight twin ("no,quit") are two DIFFERENT bets about
 * how the paint stream renders the row, and only the stream can settle them. A
 * walk that compacted the haystack instead would report both as alive and prove
 * nothing (the first draft of this probe did exactly that).
 *
 * The window is snapshotted at the instant the dialog owned the grid, so the
 * verdict is the one production's readiness scan would have reached then —
 * not one assembled from the whole session afterwards.
 */
function walkBootHints(out, boot) {
  const dialogFrame =
    out.frames.find((frame) => isCodexTrustDialog(frame.screen))?.screen ?? null;
  const productionWindow = (raw) =>
    raw === null ? null : cleanTerminal(raw).slice(-8000).toLowerCase();
  const haystacks = {
    // The two production windows, at the two instants that matter.
    "PRODUCTION rawTail @ dialog": productionWindow(out.rawAtDialog),
    "PRODUCTION rawTail @ first-ready": productionWindow(out.rawAtFirstReady),
    // Reference channels — NOT what the guard reads, kept so a needle that is
    // alive on the grid but dead on the stream is attributable rather than just
    // absent.
    "reference dialog-frame(grid)": dialogFrame === null ? null : dialogFrame.toLowerCase(),
    "reference stream(whole run)": productionWindow(boot.raw),
  };
  const walk = { dialogFramePresent: dialogFrame !== null, needles: {} };
  for (const needle of BOOT_DIALOG_HINTS) {
    walk.needles[needle] = Object.fromEntries(
      Object.entries(haystacks).map(([label, hay]) => [
        label,
        hay === null ? null : hay.includes(needle),
      ]),
    );
  }
  // The guard is an ORDERING claim, not a presence claim: a needle only holds
  // readiness while it sits AFTER the last composer glyph. Record the verdict
  // the production scan actually reached on the snapshotted windows.
  walk.productionVerdictAtDialog =
    out.rawAtDialog === null ? null : detectIdlePromptForProvider(out.rawAtDialog, "codex");
  walk.productionVerdictAtFirstReady =
    out.rawAtFirstReady === null
      ? null
      : detectIdlePromptForProvider(out.rawAtFirstReady, "codex");
  walk.screenAtFirstReady =
    out.frames.find((frame) => frame.acceptsPromptInput)?.screen ?? null;
  if (dialogFrame !== null) {
    // Row order and the DEFAULT row. The claude trust dialog flipped its default
    // to the decline row at 2.1.252 and a blind Enter then killed the session;
    // this reads codex's equivalent off the live frame rather than assuming.
    walk.optionRows = dialogFrame
      .split("\n")
      .filter((line) => /\d\.\s*(Yes, continue|No, quit)/i.test(line))
      .map((line) => line.trimEnd());
    walk.cursorRow =
      dialogFrame.split("\n").find((line) => /[›❯>]\s*\d\.\s/.test(line))?.trimEnd() ?? null;
    walk.questionLine =
      dialogFrame.split("\n").find((line) => /Do you trust the contents/i.test(line))?.trimEnd() ??
      null;
  }
  return walk;
}

/** Type a marker one character at a time through the production write path and
 *  record, per character, whether it had echoed by the time the next went out.
 *  A swallow shows as a gap between "written" and "echoed". Nothing is ever
 *  submitted — the marker is erased with backspaces at the end. */
async function measureComposerArming(boot) {
  const marker = "SONATAARM";
  const perChar = [];
  for (const ch of marker) {
    const wroteAt = Date.now();
    boot.host.writeRaw(ch);
    await sleep(120);
    perChar.push({
      ch,
      echoedWithinMs: compact(boot.screen()).includes(marker.slice(0, perChar.length + 1))
        ? Date.now() - wroteAt
        : null,
    });
  }
  await sleep(800);
  const landed = compact(boot.screen()).includes(marker);
  for (let i = 0; i < marker.length; i += 1) boot.host.writeRaw("\x7f");
  await sleep(600);
  return {
    marker,
    perChar,
    allCharsLanded: landed,
    firstCharEchoedInMs: perChar[0]?.echoedWithinMs ?? null,
    swallowedChars: perChar.filter((entry) => entry.echoedWithinMs === null).length,
    composerAfterErase: boot
      .screen()
      .split("\n")
      .filter((line) => /[›»❯>]/.test(line))
      .map((line) => line.trimEnd())
      .slice(-4),
  };
}

function matches(re, text) {
  return re.test(text) || re.test(text.replace(/\s+/g, " "));
}

function matchedLines(re, text) {
  return text
    .split("\n")
    .filter((line) => re.test(line))
    .map((line) => line.trimEnd())
    .slice(0, 8);
}

function summarize(out) {
  return {
    arm: out.arm,
    version: out.version,
    codexHome: out.codexHome,
    pretrustCwd: out.pretrustCwd,
    args: out.args,
    reachedReady: out.reachedReady,
    readyAtMs: out.readyAtMs,
    ptyExited: out.ptyExited,
    exitInfo: out.exitInfo,
    frameCount: out.frames.length,
    candidates: Object.fromEntries(
      CANDIDATES.map((candidate) => [
        candidate.id,
        out.candidateFirstSeen[candidate.id]
          ? {
              atMs: out.candidateFirstSeen[candidate.id].atMs,
              channel: out.candidateFirstSeen[candidate.id].channel,
              sonataReadyWhileOnScreen:
                out.candidateFirstSeen[candidate.id].sonataReadyWhileOnScreen,
              lines: out.candidateFirstSeen[candidate.id].matchedLines,
            }
          : "NOT SEEN",
      ]),
    ),
    trustDialogGridVerdicts: out.trustDialogGridVerdicts,
    bootHintWalk: out.bootHintWalk,
    codexTrustDialogEvents: (out.events ?? []).filter((event) =>
      event.type.startsWith("codex-trust-dialog"),
    ),
    hookSessionStart: (out.events ?? []).find((event) => event.type === "cli-hooks:liveness") ?? null,
    composerArming: out.composerArming
      ? {
          allCharsLanded: out.composerArming.allCharsLanded,
          firstCharEchoedInMs: out.composerArming.firstCharEchoedInMs,
          swallowedChars: out.composerArming.swallowedChars,
          composerAfterErase: out.composerArming.composerAfterErase,
        }
      : null,
    error: out.error ?? null,
  };
}

const arm = process.argv[2] ?? "production";
if (!ARMS[arm]) {
  console.error(`unknown arm ${arm}; expected one of ${Object.keys(ARMS).join(", ")}`);
  process.exit(64);
}
assertCodexVersion("start");
const result = await run(arm);
// END pin: RECORD the drift and still save the capture (SL-4 method note).
const endVersion = codexVersion();
result.endVersion = endVersion;
result.versionDrift = endVersion.includes(EXPECT_CODEX_VERSION)
  ? null
  : `codex drifted off ${EXPECT_CODEX_VERSION} mid-run: ${endVersion}`;
const outPath = writeCapture(OUT_DIR, `q20-boot-ceremony.${arm}.capture.txt`, result);
console.log(sanitize(JSON.stringify(summarize(result), null, 2)));
console.log(`\nwrote ${outPath}`);
process.exit(result.reachedReady && !result.versionDrift ? 0 : 1);
