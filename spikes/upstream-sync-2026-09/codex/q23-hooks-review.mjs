// Q23 (2026-09 sync, SL-6) — the startup HOOKS-REVIEW screen, and whether
// Sonata's injected hooks can ever be rejected at boot.
//
// TWO UPSTREAM CHANGES, two questions:
//
//  B4 / the 0.148 startup rework. `bypass_hook_trust_for_startup_review` is
//  still `config.bypass_hook_trust && !is_persistent_resume` (tui/src/lib.rs),
//  and `review_is_needed` is `!bypass_hook_trust && review_needed_count > 0`
//  (startup_hooks_review.rs) — so Sonata's `--dangerously-bypass-hook-trust`
//  should suppress the screen outright. That is a SOURCE claim. The screen it
//  suppresses is a three-row selection list whose first row renders as
//  `› 1. Review hooks` — the composer glyph — under a footer
//  ("Press enter to confirm or esc to go back") that appears in NONE of the
//  codex `bootDialogHints`. If it can ever paint, Sonata's readiness scan reads
//  it as an idle composer. So the control arm here is not ceremony: it measures
//  what the guard would do if the flag were ever dropped.
//
//  #38394 — "a session REJECTS on an unloadable REQUIRED MANAGED hook"
//  (`hooks/src/registry.rs`: `Hooks::new` bails with "failed to load required
//  managed hooks"). SOURCE READ: `required_load_errors` is populated ONLY by
//  `append_managed_requirement_handlers`, whose source is
//  `config_layer_stack.requirements().managed_hooks` — the MANAGED REQUIREMENTS
//  layer. Sonata's `-p sonata` file is an ordinary config layer, so its hooks
//  can never carry `HookRequirement::Required`. The live half of that claim is
//  the `broken-shim` arm: Sonata's worst realistic hook failure (the shim files
//  gone) must still reach a composer.
//
// DIRECT node-pty, not TerminalHost, for the same reason as q22: two of these
// arms deliberately spawn argv Sonata would never emit, and driving them through
// the production host would blur what is being measured. Sonata's own readiness
// verdict is still the production function (`detectIdlePromptForProvider`) run
// over the captured stream.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  EXPECT_CODEX_VERSION,
  assertCodexVersion,
  codexVersion,
  detectIdlePromptForProvider,
  isCodexTrustDialog,
  runtime,
  seedCodexHome,
  sanitize,
  sleep,
  withCodexHome,
  writeCapture,
} from "./driver.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const { codexArgs, ensureCodexRuntimeSettings, codexProfilePath, CODEX_SONATA_PROFILE } = runtime;

const ROOT = "/private/tmp/sonata-sync-2026-09/codex-hooks-review";
const COLS = 120;
const ROWS = 40;
const WATCH_MS = 20_000;

/** The codex `bootDialogHints` set as terminal-host ships it. Walked against
 *  whatever screen each arm produces: a boot screen this vocabulary does not
 *  cover is a screen Sonata's readiness gate cannot hold. */
const BOOT_DIALOG_HINTS = [
  "press enter to continue",
  "yes, continue",
  "yes,continue",
  "no, quit",
  "no,quit",
];

const HOOKS_REVIEW_RE =
  /Hooks need review|Review hooks|Trust all and continue|Continue without trusting/i;

const ARMS = {
  production: {
    why: "Sonata's argv verbatim — the review screen must not paint",
    bypass: true,
    breakShims: false,
  },
  "no-bypass": {
    why: "CONTROL — the same argv with --dangerously-bypass-hook-trust removed, so the screen CAN paint and its guard coverage is measurable",
    bypass: false,
    breakShims: false,
  },
  "broken-shim": {
    why: "Sonata's argv with the shim FILES deleted — the worst realistic hook failure; #38394's fatal path must not fire",
    bypass: true,
    breakShims: true,
  },
};

function screenOf(term) {
  const buffer = term.buffer.active;
  const lines = [];
  for (let y = 0; y < term.rows; y += 1) {
    const line = buffer.getLine(buffer.viewportY + y);
    lines.push(line ? line.translateToString(true) : "");
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

async function run(armName) {
  const spec = ARMS[armName];
  const runRoot = path.join(ROOT, armName);
  fs.rmSync(runRoot, { recursive: true, force: true });
  const workspace = path.join(runRoot, "workspace");
  const binDir = path.join(runRoot, "bin");
  fs.mkdirSync(workspace, { recursive: true });
  const codexHome = seedCodexHome(path.join(runRoot, "codex-home"));

  const out = { arm: armName, why: spec.why, version: codexVersion(), workspace, codexHome };

  let args;
  await withCodexHome(codexHome, async () => {
    // Pre-trust the cwd exactly as production does, so the DIRECTORY-trust
    // screen cannot appear and confound the hooks question.
    ensureCodexRuntimeSettings({ binDir, pretrustCwd: workspace });
    out.profile = fs.readFileSync(codexProfilePath(), "utf8");
    const full = codexArgs({
      cwd: workspace,
      permissionMode: "ask-for-approval",
      profile: CODEX_SONATA_PROFILE,
    });
    // The control arm strips ONE flag from the production argv rather than
    // rebuilding it, so nothing else can drift between the arms.
    args = spec.bypass ? full : full.filter((arg) => arg !== "--dangerously-bypass-hook-trust");
  });
  out.args = args;

  if (spec.breakShims) {
    out.shimsDeleted = [];
    for (const name of fs.readdirSync(binDir)) {
      fs.rmSync(path.join(binDir, name));
      out.shimsDeleted.push(name);
    }
  }

  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 4000 });
  let raw = "";
  const env = { ...process.env, CODEX_HOME: codexHome, TERM: "xterm-256color" };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|AI_AGENT|ANTHROPIC)/i.test(key)) delete env[key];
  }
  env.SONATA_RUNTIME_DIR = path.join(runRoot, "runtime");
  env.SONATA_NODE = process.execPath;
  fs.mkdirSync(env.SONATA_RUNTIME_DIR, { recursive: true });

  const t0 = Date.now();
  const child = pty.spawn("codex", args, {
    name: "xterm-256color",
    cols: COLS,
    rows: ROWS,
    cwd: workspace,
    env,
  });
  let exited = null;
  child.onData((data) => {
    raw += data;
    term.write(data);
  });
  child.onExit((exit) => {
    exited = { atMs: Date.now() - t0, ...exit };
  });

  const frames = [];
  let lastFrame = null;
  let hooksReviewFrame = null;
  let hooksReviewAtMs = null;
  let composerAtMs = null;
  try {
    const deadline = Date.now() + WATCH_MS;
    while (Date.now() < deadline) {
      const screen = screenOf(term);
      if (screen !== lastFrame) {
        frames.push({ atMs: Date.now() - t0, screen });
        lastFrame = screen;
      }
      if (hooksReviewFrame === null && HOOKS_REVIEW_RE.test(screen)) {
        hooksReviewFrame = screen;
        hooksReviewAtMs = Date.now() - t0;
      }
      if (composerAtMs === null && /Ask Codex to do anything/i.test(screen)) {
        composerAtMs = Date.now() - t0;
      }
      if (exited) break;
      // Both terminal states: a review screen owns the display until answered,
      // and a healthy boot settles at the composer. Neither needs the full watch.
      if (hooksReviewFrame !== null) break;
      if (composerAtMs !== null && Date.now() - t0 > composerAtMs + 3_000) break;
      await sleep(100);
    }
  } finally {
    child.kill();
    await sleep(400);
  }

  out.frames = frames;
  // The pty tail in production's own window shape, kept so the guard fix can be
  // A/B'd against REAL upstream bytes rather than a hand-written fixture.
  out.productionWindow = raw.slice(-16_000);
  out.hooksReviewRaised = hooksReviewFrame !== null;
  out.hooksReviewAtMs = hooksReviewAtMs;
  out.hooksReviewFrame = hooksReviewFrame;
  out.composerAtMs = composerAtMs;
  out.exited = exited;
  out.finalScreen = screenOf(term);
  out.trustDialogRaised = isCodexTrustDialog(out.finalScreen) || frames.some((f) => isCodexTrustDialog(f.screen));
  // #38394's fatal string, on the whole stream — a bail happens before any TUI.
  out.requiredManagedHookBail = /failed to load required managed hooks/i.test(raw);

  // Sonata's OWN readiness verdict at the moment the review screen owned the
  // display: the production function, over the production window shape.
  out.sonataReadinessAtHooksReview = hooksReviewFrame === null
    ? null
    : detectIdlePromptForProvider(raw, "codex");
  out.bootHintCoverage = hooksReviewFrame === null
    ? null
    : Object.fromEntries(
        BOOT_DIALOG_HINTS.map((needle) => [
          needle,
          {
            onScreen: hooksReviewFrame.toLowerCase().includes(needle),
            onStream: raw.toLowerCase().includes(needle),
          },
        ]),
      );
  return out;
}

assertCodexVersion("start");
const only = process.argv[2] ?? null;
const arms = only ? [only] : Object.keys(ARMS);
for (const arm of arms) {
  if (!ARMS[arm]) {
    console.error(`unknown arm ${arm}; expected one of ${Object.keys(ARMS).join(", ")}`);
    process.exit(64);
  }
}

const results = [];
for (const arm of arms) {
  results.push(await run(arm));
}
const endVersion = codexVersion();
const outPath = writeCapture(OUT_DIR, "q23-hooks-review.capture.txt", {
  probe: "q23-hooks-review",
  endVersion,
  versionDrift: endVersion.includes(EXPECT_CODEX_VERSION) ? null : `drifted to ${endVersion}`,
  results,
});
console.log(
  sanitize(
    JSON.stringify(
      results.map((result) => ({
        arm: result.arm,
        why: result.why,
        bypassInArgs: result.args.includes("--dangerously-bypass-hook-trust"),
        shimsDeleted: result.shimsDeleted ?? null,
        hooksReviewRaised: result.hooksReviewRaised,
        hooksReviewAtMs: result.hooksReviewAtMs,
        hooksReviewFrame: result.hooksReviewFrame,
        trustDialogRaised: result.trustDialogRaised,
        composerAtMs: result.composerAtMs,
        exited: result.exited,
        requiredManagedHookBail: result.requiredManagedHookBail,
        sonataReadinessAtHooksReview: result.sonataReadinessAtHooksReview,
        bootHintCoverage: result.bootHintCoverage,
      })),
      null,
      2,
    ),
  ),
);
console.log(`\nwrote ${outPath}`);
process.exit(results.some((result) => result.requiredManagedHookBail) ? 1 : 0);
