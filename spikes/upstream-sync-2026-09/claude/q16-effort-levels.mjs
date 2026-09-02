// Q16 (2026-09 sync, SL-4) — the claude EFFORT LEVEL set, and the models that
// have no effort axis at all.
//
// QUESTION (SL-4 objective 4, the `REASONING_OPTIONS` half). Sonata offers
// claude Low / Medium / High / Extra High / Max. Q13 exercised only low / medium
// / high; the top two tiers have never been re-measured on this binary, and Q13
// turned up a second question it could not answer: **Haiku reports NO effort at
// all** (`effort: null` in the statusline payload, and the boot banner prints
// `Haiku 4.5 · Claude Max` with no `with <x> effort` segment) while STILL
// printing a success receipt for `/effort high`. So "the CLI accepted it" is not
// evidence the model has the axis, and Sonata's launch menu currently offers a
// Reasoning section for a model that has none.
//
// Two questions, two arms:
//   S — mid-session `/effort <tier>` on Sonnet, for every tier Sonata offers
//       plus a bogus one (the parser's comment claims a `/effort` failure
//       receipt is unreachable — that claim is either measured here or dropped).
//   L — LAUNCH-time `--effort <tier> --model <m>`, which is the shape Sonata
//       actually spawns with (`claudeArgs`). A tier the CLI rejects at launch is
//       a broken task, not a mislabelled menu, so it is measured separately from
//       the mid-session form.
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
const { ensureClaudeRuntimeSettings, parseClaudeControlReceipt } = require(APP_DIR + "dist/runtime");

const { Probe, Capture, KEYS, sleep } = await import("../../upstream-sync-2026-08/claude/driver.mjs");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/effort-levels";
const COLS = 120;
const ROWS = 40;
const SCAN_LIMIT = 4096;

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

let usageDir = "";
function mirrorEffort() {
  let newest = null;
  let newestAt = 0;
  for (const entry of fs.readdirSync(usageDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith("claude-") || !entry.name.endsWith(".json")) continue;
    const full = path.join(usageDir, entry.name);
    const at = fs.statSync(full).mtimeMs;
    if (at > newestAt) {
      newestAt = at;
      newest = full;
    }
  }
  if (!newest) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(newest, "utf8"));
    return { effort: payload?.effort?.level ?? payload?.effort ?? null, display: payload?.model?.display_name ?? null };
  } catch {
    return { unreadable: true };
  }
}

/** The banner's model line: `<display name>[ with <effort> effort] · <plan>`. */
function bannerModelLine(screen) {
  for (const line of screen.split("\n")) {
    const t = line.replace(/[▐▛█▝▜▀▔]/g, "").trim();
    if (/·\s*Claude\s/.test(t)) return t;
  }
  return null;
}
function receiptLines(screen) {
  return screen.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("⎿"));
}

async function bootProbe(cwd, runtimeDir, extraArgs) {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const settingsPath = ensureClaudeRuntimeSettings(runtimeDir, {});
  const p = new Probe({
    cwd,
    rows: ROWS,
    cols: COLS,
    args: ["--permission-mode", "default", "--settings", settingsPath, ...extraArgs],
  });
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
  await sleep(2500);
  return { p, ready };
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const cap = new Capture(
    path.join(OUT_DIR, "q16-effort-levels.capture.txt"),
    `Q16 — claude effort tiers + the no-effort models (claude ${version})`,
  );
  const results = { version, session: [], launch: [] };

  // ── S: mid-session /effort on Sonnet ──────────────────────────────────────
  const runtimeDir = path.join(ROOT, "s-runtime");
  usageDir = path.join(runtimeDir, "usage");
  const { p, ready } = await bootProbe(path.join(ROOT, "s"), runtimeDir, ["--model", "sonnet"]);
  let armed = null;
  p.pty.onData((chunk) => {
    if (!armed) return;
    armed.scan = (armed.scan + chunk).slice(-SCAN_LIMIT);
    if (armed.verdict) return;
    const verdict = parseClaudeControlReceipt(armed.scan, armed.kind);
    if (verdict) armed.verdict = verdict;
  });
  try {
    if (!ready) throw new Error("S arm never reached a composer");
    cap.frame(p, "S — boot (--model sonnet)");
    // The tier list is the CLI's OWN enumeration, learned from the bogus arm on
    // the first q16 run: `Invalid argument: <x>. Valid options are: low, medium,
    // high, xhigh, max, ultracode, auto`. `ultracode` and `auto` are measured
    // here because "the CLI names it as valid" is not the same claim as "this
    // account may use it" — an entitlement refusal would look like a receipt.
    for (const tier of ["low", "medium", "high", "xhigh", "max", "ultracode", "auto", "bogus-tier"]) {
      armed = { kind: "effort", scan: "", verdict: null };
      p.write(`/effort ${tier}`);
      await sleep(120);
      p.write("\r");
      await sleep(6000);
      const snapshot = armed;
      armed = null;
      cap.frame(p, `S — after \`/effort ${tier}\``);
      const entry = {
        tier,
        parserVerdict: snapshot.verdict,
        lastReceipt: receiptLines(p.screen()).slice(-1)[0] ?? null,
        bannerModelLine: bannerModelLine(p.screen()),
        mirror: mirrorEffort(),
      };
      cap.add(`S — /effort ${tier} verdict`, JSON.stringify(entry, null, 2));
      results.session.push(entry);
    }
  } finally {
    p.kill();
    await sleep(600);
  }

  // ── L: launch-time --effort, the shape claudeArgs actually spawns ─────────
  for (const [model, effort] of [
    ["sonnet", "xhigh"],
    ["sonnet", "max"],
    ["haiku", "xhigh"],
    ["haiku", "high"],
    ["opus[1m]", "max"],
  ]) {
    const label = `L-${model.replace(/[^a-z0-9]/gi, "")}-${effort}`;
    const rd = path.join(ROOT, `${label}-runtime`);
    usageDir = path.join(rd, "usage");
    const { p: lp, ready: lready } = await bootProbe(path.join(ROOT, label), rd, [
      "--model", model, "--effort", effort,
    ]);
    try {
      cap.frame(lp, `${label} — boot frame`);
      const entry = {
        label,
        model,
        effort,
        ready: lready,
        exited: lp.exited,
        exitInfo: lp.exitInfo ?? null,
        bannerModelLine: bannerModelLine(lp.screen()),
        mirror: mirrorEffort(),
        // Anything on the boot frame that reads like a rejection.
        complaintLines: lp
          .screen()
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /invalid|unsupported|not supported|unknown|error|not found/i.test(l)),
      };
      cap.add(`${label} — verdict`, JSON.stringify(entry, null, 2));
      results.launch.push(entry);
    } finally {
      lp.kill();
      await sleep(600);
    }
  }

  results.userSettingsUnchangedDuring = fs.readFileSync(USER_SETTINGS, "utf8") === settingsBefore;
  fs.writeFileSync(USER_SETTINGS, settingsBefore, "utf8");
  results.userSettingsRestored = fs.readFileSync(USER_SETTINGS, "utf8") === settingsBefore;
  const endVersion = readVersion();
  results.versionAtEnd = endVersion;
  results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
  cap.add("fence", JSON.stringify({ during: results.userSettingsUnchangedDuring, endVersion }, null, 2));
  cap.save();
  console.log(sanitize(JSON.stringify(results, null, 2)));
  if (results.versionDrift) process.exitCode = 2;
}

main().catch((error) => {
  console.error(sanitize(String(error?.stack ?? error)));
  process.exit(1);
});
