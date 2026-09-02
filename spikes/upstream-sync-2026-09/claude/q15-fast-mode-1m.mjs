// Q15 (2026-09 sync, SL-4) — is native FAST MODE offered on `opus[1m]`?
//
// QUESTION (SL-4 objective 4, the `speedOptionsForModel` half). Q12 measured
// that the live `/model` picker's ONLY Opus row is `Opus (1M context)`
// (`opus[1m]`), a model id Sonata's `MODEL_OPTIONS.claude` does not carry. Adding
// it forces a decision on `CLAUDE_FAST_MODELS`, which today is exactly
// `{"opus"}`: does the 1M variant accept Sonata's `fastMode` injection, or would
// offering Fast there promise a launch combination the CLI cannot honour?
//
// The existing gate's own comment says the non-Opus behaviour (auto-switch vs
// error) is UNVERIFIED and unreachable while the gate holds — so the honest way
// to widen the gate is to measure the widened case, not to reason that "1M Opus
// is still Opus". Four arms, one variable each:
//   F1 opus      + fastMode   (the known-good control — the gate's current member)
//   F2 opus[1m]  + fastMode   (the candidate)
//   F3 opus[1m]  no fastMode  (the baseline this is compared against)
//   F4 haiku     + fastMode   (the negative control: a model the gate excludes,
//                              to show what a REFUSED fast mode looks like — so
//                              F2's verdict is read against a known negative and
//                              not against an absence of evidence)
//
// EVIDENCE. Fast mode has no flag and prints no receipt; it rides in the
// injected `--settings` file. The observable is the boot banner's model line
// (`<model> with <effort> effort · <plan>`) plus the whole first frame, captured
// verbatim per arm and diffed — if the CLI refuses or downgrades, that line is
// where it says so.
//
// READ-ONLY. No `/model`, no picker, no Enter on any row: the arms differ only
// in spawn flags, so the user's global default is never rewritten. The settings
// fence still asserts it.
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path
// embeds the username): these frames become findings and the pre-push leak fence
// scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { ensureClaudeRuntimeSettings } = require(APP_DIR + "dist/runtime");

const { Probe, Capture, KEYS, sleep } = await import("../../upstream-sync-2026-08/claude/driver.mjs");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/fast-mode-1m";
const COLS = 120;
const ROWS = 40;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

function readVersion() {
  return execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
}
function pinVersionOrExit() {
  const version = readVersion();
  if (!version.startsWith(EXPECT_VERSION)) {
    console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} (probe start)`, version }));
    process.exit(2);
  }
  return version;
}
const version = pinVersionOrExit();

const USER_SETTINGS = path.join(HOME, ".claude", "settings.json");
const settingsBefore = fs.readFileSync(USER_SETTINGS, "utf8");

/** The banner's model line: `<display name> with <effort> effort · <plan>`. */
function bannerModelLine(screen) {
  for (const line of screen.split("\n")) {
    const t = line.replace(/[▐▛█▝▜▀▔]/g, "").trim();
    if (/\bwith\b.*\beffort\b/.test(t)) return t;
  }
  return null;
}

async function arm(cap, results, { label, model, fastMode }) {
  const cwd = path.join(ROOT, label);
  const runtimeDir = path.join(ROOT, `${label}-runtime`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const settingsPath = ensureClaudeRuntimeSettings(runtimeDir, { fastMode });
  const injected = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const p = new Probe({
    cwd,
    rows: ROWS,
    cols: COLS,
    args: ["--permission-mode", "default", "--settings", settingsPath, "--model", model],
  });
  try {
    const trust = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
    if (trust) {
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        p.write(KEYS.down);
        await sleep(350);
        if (p.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l))) break;
      }
      p.write(KEYS.enter);
      await sleep(1500);
    }
    const ready = await p.waitFor(/(⏸|⏵⏵)\s*(manual|plan|accept edits|auto)/i, 60_000);
    await sleep(3000);
    cap.frame(p, `${label} — boot frame (--model ${model}, fastMode=${fastMode})`, { attrs: true });
    const screen = p.screen();
    const entry = {
      label,
      model,
      fastMode,
      injectedFastModeKey: injected.fastMode ?? null,
      ready,
      bannerModelLine: bannerModelLine(screen),
      // Any line naming fast/speed anywhere on the boot frame, verbatim.
      speedLines: screen
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /fast|speed|priority/i.test(l)),
      exited: p.exited,
    };
    cap.add(`${label} — verdict`, JSON.stringify(entry, null, 2));
    results.arms.push(entry);
  } finally {
    p.kill();
    await sleep(600);
  }
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const cap = new Capture(
    path.join(OUT_DIR, "q15-fast-mode-1m.capture.txt"),
    `Q15 — native fast mode on opus[1m] (claude ${version})`,
  );
  const results = { version, arms: [] };
  try {
    await arm(cap, results, { label: "F1-opus-fast", model: "opus", fastMode: true });
    await arm(cap, results, { label: "F2-opus1m-fast", model: "opus[1m]", fastMode: true });
    await arm(cap, results, { label: "F3-opus1m-standard", model: "opus[1m]", fastMode: false });
    await arm(cap, results, { label: "F4-haiku-fast", model: "haiku", fastMode: true });
  } finally {
    results.userSettingsUnchanged = fs.readFileSync(USER_SETTINGS, "utf8") === settingsBefore;
    const endVersion = readVersion();
    results.versionAtEnd = endVersion;
    results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
    cap.add(
      "fence",
      JSON.stringify({ userSettingsUnchanged: results.userSettingsUnchanged, endVersion }, null, 2),
    );
    cap.save();
    console.log(sanitize(JSON.stringify(results, null, 2)));
    if (results.versionDrift) {
      process.exitCode = 2;
    }
  }
}

main().catch((error) => {
  console.error(sanitize(String(error?.stack ?? error)));
  process.exit(1);
});
