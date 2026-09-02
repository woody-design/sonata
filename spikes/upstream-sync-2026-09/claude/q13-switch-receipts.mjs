// Q13 (2026-09 sync, SL-4) — the SWITCH RECEIPTS and the per-model EFFORT
// memory at 2.1.258.
//
// QUESTION (SL-4 objectives 2 + 3). `parseClaudeControlReceipt` is the only
// thing that turns Sonata's `/model x` / `/effort y` inject into a settled
// switch; its three needles were measured at 2.1.214 and last re-stamped at
// 2.1.220. Since then the tail gained "for new sessions", `/effort` became
// per-model memory (2.1.251), and model names started rendering as code. Measure
// the verbatim receipts, and measure what a model switch does to the effort the
// CLI reports — because Sonata's session menu reads BOTH off the statusline
// mirror (`usage-adapters.ts` → `model.display_name` / `effort.level`), and a
// stale mirror is a menu that marks the wrong current value.
//
// EVERY receipt is run through the PRODUCTION parser (dist), not eyeballed: the
// question is not "what does the line say" but "does our parser settle on it".
//
// ── THIS PROBE MUTATES USER STATE, DELIBERATELY AND UNDER A FENCE ────────────
// `/model x` rewrites the user's GLOBAL default model (`~/.claude/settings.json`
// `model` / `effortLevel`) — the known wart SL-4 leaves in place. There is no
// isolated-config alternative: SL-3 measured that a non-default CLAUDE_CONFIG_DIR
// boots LOGGED OUT (Keychain creds are keyed to the default dir), and a logged-out
// CLI has no model list to switch between. So the probe snapshots the file's
// BYTES up front, restores them after the pty is dead, and reports the round trip.
// The diff it observed on the way is itself evidence (which keys a switch writes).
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
const {
  ensureClaudeRuntimeSettings,
  parseClaudeControlReceipt,
  claudeCacheMissDialogOpen,
  claudeCacheMissCancelled,
} = require(APP_DIR + "dist/runtime");

const { Probe, Capture, KEYS, sleep } = await import("../../upstream-sync-2026-08/claude/driver.mjs");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/switch-receipts";
const COLS = 120;
const ROWS = 40;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

// The version pin. A START drift aborts before anything is measured (there is
// nothing to lose). An END drift must NOT exit before the capture is written —
// the 2026-09-01 auto-update from 2.1.257 to 2.1.258 landed mid-run and the
// original hard exit discarded a completed measurement along with the drift it
// was reporting. So the end pin RECORDS the drift, lets the caller save, and the
// process exits non-zero afterwards: the run is still unusable, but its evidence
// survives to say so.
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
const claudeJsonBefore = fs.readFileSync(path.join(HOME, ".claude.json"), "utf8");

/** The keys of ~/.claude.json that mention effort/model, so the per-model effort
 *  memory (2.1.251) can be located without dumping a file full of user data. */
function effortKeysOfClaudeJson() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(HOME, ".claude.json"), "utf8"));
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (/effort/i.test(key)) out[key] = value;
    }
    return out;
  } catch {
    return { unreadable: true };
  }
}

function userSettingsSubset() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USER_SETTINGS, "utf8"));
    return { model: parsed.model ?? null, effortLevel: parsed.effortLevel ?? null };
  } catch {
    return { unreadable: true };
  }
}

// ─── the statusline MIRROR, read exactly the way production reads it ─────────

let usageDir = "";
/** The freshest statusLine payload the sink wrote, reduced to the two fields
 *  Sonata's session menu keys on. Null when the CLI has not ticked yet. */
function mirror() {
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
    return {
      displayName: payload?.model?.display_name ?? null,
      modelId: payload?.model?.id ?? null,
      effort: payload?.effort?.level ?? payload?.effort ?? null,
    };
  } catch {
    return { unreadable: true };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

const CURSOR = "❯";

function pickerOpen(screen) {
  return /^\s*Select model\s*$/m.test(screen);
}

/** Bottom-up (see q12): the echoed `❯ /model` transcript line would otherwise
 *  win over the live picker cursor row. */
function focusedRow(screen) {
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith(CURSOR)) continue;
    const label = t.slice(CURSOR.length).trim().replace(/\s+/g, " ");
    if (label) return label;
  }
  return null;
}

/** The `<glyph> <effort> · /effort` hint the composer footer paints, verbatim.
 *  The GLYPH tracks the level (measured: `○ low`, `◐ medium`), so the needle
 *  cannot be one glyph — it is the `· /effort` suffix that identifies the line. */
function effortHint(screen) {
  const match = screen.match(/([○◐◑◒◓●])\s*([^\n·]*?)\s*·\s*\/effort/);
  return match ? `${match[1]} ${match[2].trim()}` : null;
}

/** The `⎿ …` receipt lines currently on the grid, newest last. */
function receiptLines(screen) {
  return screen
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("⎿"));
}

// `CONTROL_SWITCH_SCAN_LIMIT` from tui-parsers-claude.ts. Restated (not imported)
// so a probe that silently followed a future change to the constant cannot
// pretend it re-measured the shape it actually measured.
const SCAN_LIMIT = 4096;

/** The live production ladder, armed per switch (see q14). Null when idle. */
let armed = null;

/**
 * Run one slash command exactly the way `writeClaudeValueCommand` runs it, and
 * read the verdict exactly the way `detectControlSwitchReceipt` reads it.
 *
 * BOTH halves of that matter, and q14 is why. Production writes the command as
 * ONE pty write, arms the watch immediately after (so the repaint the write
 * provokes lands inside the window), submits with a raw `\r` 120ms later, then
 * feeds ONE CHUNK AT A TIME into a rolling 4096-char window and acts on the
 * FIRST chunk that yields a verdict. Reading the whole delta once at the end —
 * what this probe's first cut did — is a different question with a different
 * answer: it saw `failed` on two switches that had plainly succeeded, because an
 * unbounded delta eventually contains a repaint of an OLD `Model '…' not found`
 * line. The ladder below is production's, so its verdicts are production's.
 */
async function runCommand(p, cap, label, command, { kind = null, settleMs = 6000 } = {}) {
  const before = p.raw.length;
  armed = kind
    ? { kind, scan: "", chunks: 0, verdict: null, verdictChunk: null, verdictWindow: "" }
    : null;
  p.write(command);
  await sleep(120);
  p.write("\r");
  await sleep(settleMs);
  const snapshot = armed;
  armed = null;
  const delta = p.raw.slice(before);
  cap.frame(p, `${label} — after \`${command}\``);
  cap.addRaw(`${label} — RAW delta`, delta);
  const result = {
    label,
    command,
    kind,
    // Production semantics: rolling window, first verdict wins.
    parserVerdict: snapshot?.verdict ?? null,
    verdictChunk: snapshot?.verdictChunk ?? null,
    // The contrast: the same parser over the WHOLE unbounded delta. Kept as a
    // column rather than dropped, because where the two disagree is exactly the
    // repaint hazard q14 characterises.
    parserVerdictWholeDelta: kind ? parseClaudeControlReceipt(delta, kind) : null,
    receiptLines: receiptLines(p.screen()),
    effortHint: effortHint(p.screen()),
    mirror: mirror(),
    userSettings: userSettingsSubset(),
    cacheMissDialogOpen: claudeCacheMissDialogOpen(p.screen()),
  };
  cap.add(`${label} — verdict`, JSON.stringify(result, null, 2));
  if (snapshot?.verdictWindow) {
    cap.addRaw(`${label} — the window that produced the verdict`, snapshot.verdictWindow);
  }
  return result;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const cwd = path.join(ROOT, "session");
  const runtimeDir = path.join(ROOT, "runtime");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const settingsPath = ensureClaudeRuntimeSettings(runtimeDir, {});
  usageDir = path.join(runtimeDir, "usage");

  const cap = new Capture(
    path.join(OUT_DIR, "q13-switch-receipts.capture.txt"),
    `Q13 — /model + /effort receipts and per-model effort (claude ${version})`,
  );
  cap.add(
    "user state BEFORE (the fence)",
    JSON.stringify({ settings: userSettingsSubset(), effortKeys: effortKeysOfClaudeJson() }, null, 2),
  );

  const p = new Probe({
    cwd,
    rows: ROWS,
    cols: COLS,
    args: ["--permission-mode", "default", "--settings", settingsPath],
  });
  // The production ladder's tap (see runCommand).
  p.pty.onData((chunk) => {
    if (!armed) return;
    armed.chunks += 1;
    armed.scan = (armed.scan + chunk).slice(-SCAN_LIMIT);
    if (armed.verdict) return;
    const verdict = parseClaudeControlReceipt(armed.scan, armed.kind);
    if (verdict) {
      armed.verdict = verdict;
      armed.verdictChunk = armed.chunks;
      armed.verdictWindow = armed.scan;
    }
  });

  const results = { version, arms: [], picker: [], history: null, notes: [] };
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
    if (!ready) throw new Error("never reached a composer");
    await sleep(3000);
    cap.frame(p, "boot — idle composer");
    results.bootMirror = mirror();
    results.bootEffortHint = effortHint(p.screen());

    // ── A. arg-form receipts, EMPTY history (no cache-miss dialog expected) ──
    results.arms.push(await runCommand(p, cap, "A1 /model sonnet", "/model sonnet", { kind: "model" }));
    results.arms.push(await runCommand(p, cap, "A2 /effort low", "/effort low", { kind: "effort" }));
    results.arms.push(
      await runCommand(p, cap, "A3 /model bogus-model-xyz", "/model bogus-model-xyz", { kind: "model" }),
    );
    results.arms.push(await runCommand(p, cap, "A4 /model opus", "/model opus", { kind: "model" }));
    // The user's own settings carry `opus[1m]`; does the bracketed alias round-trip
    // through the slash form? (2.1.248 renders names as CODE — `[1m]` is literal.)
    results.arms.push(await runCommand(p, cap, "A5 /model opus[1m]", "/model opus[1m]", { kind: "model" }));
    results.arms.push(await runCommand(p, cap, "A6 /model fable", "/model fable", { kind: "model" }));
    results.arms.push(await runCommand(p, cap, "A7 /model haiku", "/model haiku", { kind: "model" }));

    // ── B. per-model effort memory (2.1.251) ────────────────────────────────
    // Set a distinctive effort on haiku, switch away, switch back. If effort is
    // per-model, the round trip restores it and the mirror must follow BOTH legs.
    results.arms.push(await runCommand(p, cap, "B1 /effort high (on haiku)", "/effort high", { kind: "effort" }));
    results.arms.push(await runCommand(p, cap, "B2 /model sonnet", "/model sonnet", { kind: "model" }));
    results.arms.push(await runCommand(p, cap, "B3 /effort low (on sonnet)", "/effort low", { kind: "effort" }));
    results.arms.push(await runCommand(p, cap, "B4 /model haiku (back)", "/model haiku", { kind: "model" }));
    results.arms.push(await runCommand(p, cap, "B5 /model sonnet (back)", "/model sonnet", { kind: "model" }));
    results.effortKeysAfterB = effortKeysOfClaudeJson();

    // ── C. picker-form receipts: Enter (set default) vs `s` (session only) ───
    for (const [label, key, steps] of [
      ["C1 picker Enter", "\r", 2],
      ["C2 picker s", "s", 1],
    ]) {
      const before = p.raw.length;
      await p.type("/model", 25);
      await sleep(600);
      p.write(KEYS.enter);
      await sleep(1400);
      const opened = pickerOpen(p.screen());
      const from = focusedRow(p.screen());
      for (let i = 0; i < steps; i++) {
        p.write(KEYS.down);
        await sleep(350);
      }
      const target = focusedRow(p.screen());
      cap.frame(p, `${label} — picker focused on target`);
      p.write(key);
      await sleep(6000);
      const delta = p.raw.slice(before);
      cap.frame(p, `${label} — after ${JSON.stringify(key)}`);
      cap.addRaw(`${label} — RAW delta`, delta);
      const entry = {
        label,
        opened,
        from,
        target,
        key: JSON.stringify(key),
        parserVerdict: parseClaudeControlReceipt(delta, "model"),
        receiptLines: receiptLines(p.screen()),
        effortHint: effortHint(p.screen()),
        mirror: mirror(),
        userSettings: userSettingsSubset(),
        stillOpen: pickerOpen(p.screen()),
      };
      cap.add(`${label} — verdict`, JSON.stringify(entry, null, 2));
      results.picker.push(entry);
    }

    // ── D. cache-miss confirm dialog, on a session WITH history ─────────────
    // One cheap real turn, then a switch. S7's parked-dialog relay depends on
    // this dialog still existing in the shape `claudeCacheMissDialogOpen` keys on.
    const turnBefore = p.raw.length;
    p.paste("Reply with exactly: ok");
    await sleep(400);
    p.write("\r");
    await p.waitFor(/✻|✳|✶|✽/, 60_000);
    await sleep(25_000);
    cap.frame(p, "D — after one real turn");
    cap.addRaw("D — turn RAW delta", p.raw.slice(turnBefore).slice(-4000));

    const dBefore = p.raw.length;
    await p.type("/model opus", 25);
    await sleep(600);
    p.write("\r");
    await sleep(6000);
    const dDelta = p.raw.slice(dBefore);
    cap.frame(p, "D — after `/model opus` on a session WITH history");
    cap.addRaw("D — RAW delta", dDelta);
    const dialogOpen = claudeCacheMissDialogOpen(p.screen());
    results.history = {
      cacheMissDialogOpen: dialogOpen,
      screenParserVerdict: parseClaudeControlReceipt(dDelta, "model"),
      receiptLines: receiptLines(p.screen()),
      focused: focusedRow(p.screen()),
      mirror: mirror(),
    };
    if (dialogOpen) {
      // Cancel it — never leave a modal answered by a guess.
      p.write(KEYS.esc);
      await sleep(2500);
      cap.frame(p, "D — after Esc on the cache-miss dialog");
      results.history.cancelledCleanly = !claudeCacheMissDialogOpen(p.screen());
      results.history.cancelReceiptParsed = claudeCacheMissCancelled(p.raw.slice(dBefore), "model");
      results.history.receiptLinesAfterCancel = receiptLines(p.screen());
    }
  } finally {
    cap.frame(p, "final — screen at teardown");
    p.kill();
    await sleep(800);
    const settingsDuring = fs.readFileSync(USER_SETTINGS, "utf8");
    results.userSettingsMutated = settingsDuring !== settingsBefore;
    results.userSettingsAfterProbe = userSettingsSubset();
    results.effortKeysAfterProbe = effortKeysOfClaudeJson();
    fs.writeFileSync(USER_SETTINGS, settingsBefore, "utf8");
    results.userSettingsRestored = fs.readFileSync(USER_SETTINGS, "utf8") === settingsBefore;
    results.claudeJsonChanged = fs.readFileSync(path.join(HOME, ".claude.json"), "utf8") !== claudeJsonBefore;
    cap.add(
      "user state AFTER (the fence)",
      JSON.stringify(
        {
          mutated: results.userSettingsMutated,
          afterProbe: results.userSettingsAfterProbe,
          restored: results.userSettingsRestored,
          effortKeys: results.effortKeysAfterProbe,
          claudeJsonChanged: results.claudeJsonChanged,
        },
        null,
        2,
      ),
    );
    const endVersion = readVersion();
    results.versionAtEnd = endVersion;
    results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
    cap.add("binary version at probe end", `${endVersion}${results.versionDrift ? "  *** DRIFTED — this run is NOT a valid measurement ***" : ""}`);
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
