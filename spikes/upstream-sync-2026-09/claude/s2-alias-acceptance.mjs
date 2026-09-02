// S2 (2026-09 sync, SL-10) — do the CLAUDE alias spellings still WORK at
// 2.1.258, and which of the measured picker names does the CLI itself call a
// SKILL?
//
// WHY THIS EXISTS. S1 measured the picker pool and settled every PRESENCE
// question, but it left two the picker structurally cannot answer:
//
//   1. ACCEPTANCE ≠ OFFERING. `builtins.ts` carries seven alias spellings
//      (`/checkpoint` `/undo` `/stats` `/cost` `/bashes` `/quit` `/plugins`) as
//      "known but unlisted", justified in the doc comment as "an honest record
//      of what the CLI ACCEPTS". S1 measured that none of them has an exact
//      picker row any more — which is NOT the same claim, because 2.1.210 folded
//      aliases under a canonical row, so an accepted alias could be unlisted BY
//      DESIGN. The only way to tell "folded" from "gone" is to submit it. And
//      the answer now matters in a way it did not before: 2.1.236 removed the
//      fuzzy match on submit, so a name the CLI no longer knows ERRORS instead
//      of running its successor.
//   2. UNIVERSAL ≠ PER-ENVIRONMENT. The snapshot's curation boundary excludes
//      the user's personal skills and installed plugins because they are
//      per-environment. S1 subtracted both by their on-disk / namespaced
//      evidence, leaving ~35 names the snapshot has never carried. `/skills` is
//      the CLI's own answer to "which of these are skills", and it is the only
//      first-party channel for it — the binary is compiled, so there is no
//      bundled-skills directory to read.
//
// CONTROL FIRST. The rejection shape is measured on a name that cannot exist
// (`/zzz-not-a-command-sl10`) before any candidate is judged against it.
// Without that arm, "it errored" is an assumption about a string.
//
// ─── ONE PROCESS PER CANDIDATE (corrected design) ───────────────────────────
// The first version of this probe ran every arm in ONE session and produced
// garbage, in two measured ways worth recording because they are the reason for
// the rewrite:
//   • WITH THE PICKER OPEN, ENTER SELECTS A ROW — it does not submit the typed
//     text. `/review` was fuzzy-matched to a neighbour and Enter opened that
//     command's panel, so the arm measured the neighbour, not `/review`. Every
//     submit here therefore presses Esc to dismiss the picker FIRST, and records
//     the composer line it is about to submit so the capture proves what was
//     sent.
//   • A PANEL ONE ARM OPENS IS INHERITED BY THE NEXT. Backspace-clearing a
//     composer that a panel is eating keystrokes from left fragments behind
//     ("❯ t", "❯ do") that submitted as PROSE and started real turns. Esc-based
//     cleanup is not strong enough to make arms independent.
// A fresh spawn per candidate costs ~10s and buys unambiguous attribution. The
// scratch cwd is shared, so only the first spawn meets the trust dialog.
//
// MUTATION POSTURE. Every candidate is submitted for real, so this is NOT
// read-only the way S1 is. Bounded by an isolated scratch cwd with production
// runtime settings and a byte-identity fence on `~/.claude/settings.json`.
//
// Scratch lives in /private/tmp; captures are sanitized on BOTH username forms.
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
const ROOT = "/private/tmp/sonata-sync-2026-09/slash-alias-claude";
const COLS = 200;
const ROWS = 40;

const HOME = os.homedir();
const USER = os.userInfo().username;
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-").split(USER).join("$USER");

function readVersion() {
  return execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
}
const version = (() => {
  const v = readVersion();
  if (!v.startsWith(EXPECT_VERSION)) {
    console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} (probe start)`, version: v }));
    process.exit(2);
  }
  return v;
})();

const USER_SETTINGS = path.join(HOME, ".claude", "settings.json");
const settingsBefore = fs.existsSync(USER_SETTINGS) ? fs.readFileSync(USER_SETTINGS, "utf8") : null;

// ─── one booted session ─────────────────────────────────────────────────────
async function boot(cwd, settingsPath) {
  const p = new Probe({
    cwd,
    rows: ROWS,
    cols: COLS,
    args: ["--permission-mode", "default", "--settings", settingsPath],
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
    await sleep(1800);
  }
  await p.waitFor(/for shortcuts|Welcome back|Try "|>\s*$/i, 60_000);
  await sleep(2500);
  return { probe: p, trustDialogSeen: trust };
}

/** The composer's current content — the line carrying the `❯ ` prompt BELOW the
 *  first horizontal rule. Recorded before every Enter so the capture proves
 *  which bytes were submitted. */
function composerLine(screen) {
  const lines = screen.split("\n");
  const ruleAt = lines.findIndex((l) => /^─{20,}/.test(l.trim()));
  if (ruleAt < 0) return null;
  for (let i = ruleAt + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("❯")) return t.slice(1).trim();
  }
  return null;
}

// ─── arm E: acceptance ──────────────────────────────────────────────────────
const CANDIDATES = [
  { name: "zzz-not-a-command-sl10", role: "CONTROL — cannot exist; defines the rejection shape" },
  { name: "review", role: "changelog hypothesis: renamed to /code-review. LISTED in Sonata's picker today" },
  { name: "ultraplan", role: "changelog hypothesis: removed. Never in Sonata's snapshot" },
  { name: "checkpoint", role: "snapshot alias of /rewind" },
  { name: "undo", role: "snapshot alias of /rewind" },
  { name: "stats", role: "snapshot alias of /usage" },
  { name: "cost", role: "snapshot alias of /usage" },
  { name: "bashes", role: "snapshot alias of /tasks" },
  { name: "plugins", role: "snapshot alias of /plugin" },
  { name: "quit", role: "snapshot alias of /exit — a success here EXITS the CLI, which is its own evidence" },
];

async function acceptanceArm(candidate, cwd, settingsPath, cap) {
  const { probe: p, trustDialogSeen } = await boot(cwd, settingsPath);
  try {
    const before = p.raw.length;
    await p.type(`/${candidate.name}`, 20);
    await sleep(900);
    // Dismiss the picker BEFORE Enter: with it open, Enter selects a row.
    p.write(KEYS.esc);
    await sleep(700);
    const submitting = composerLine(p.screen());
    p.write(KEYS.enter);
    await sleep(5000);
    const screen = p.screen();
    const delta = p.raw.slice(before);
    const rejected = new RegExp(`Unknown command:\\s*/${candidate.name}\\b`).test(screen);
    cap.frame(p, `E — /${candidate.name} — after submit  (${candidate.role})`);
    cap.add(
      `E — /${candidate.name} — verdict`,
      [
        `trustDialogSeen = ${trustDialogSeen}`,
        `composer at Enter = ${JSON.stringify(submitting)}`,
        `"Unknown command: /${candidate.name}" on screen = ${rejected}`,
        `pty exited = ${p.exited} ${p.exited ? JSON.stringify(p.exitInfo) : ""}`,
      ].join("\n"),
    );
    cap.addRaw(`E — /${candidate.name} RAW delta`, delta);
    return {
      name: candidate.name,
      role: candidate.role,
      submitted: submitting,
      submittedVerbatim: submitting === `/${candidate.name}`,
      rejected,
      exited: p.exited,
      exitInfo: p.exitInfo ?? null,
      tail: screen.split("\n").filter((l) => l.trim()).slice(-10),
    };
  } finally {
    p.kill();
    await sleep(500);
  }
}

// ─── arm S: what does the CLI itself call a SKILL? ──────────────────────────
async function skillsArm(cwd, settingsPath, cap) {
  const { probe: p } = await boot(cwd, settingsPath);
  try {
    await p.type("/skills", 25);
    await sleep(900);
    p.write(KEYS.enter);
    await sleep(4000);
    cap.frame(p, "S — /skills panel (as opened)");
    const lines = new Set();
    const absorb = () => {
      let grew = false;
      for (const raw of p.screen().split("\n")) {
        const line = raw.replace(/\s+$/, "");
        if (!line.trim()) continue;
        if (!lines.has(line)) {
          lines.add(line);
          grew = true;
        }
      }
      return grew;
    };
    absorb();
    let dry = 0;
    let steps = 0;
    for (let i = 1; i <= 200; i++) {
      p.write(KEYS.down);
      await sleep(160);
      steps = i;
      dry = absorb() ? 0 : dry + 1;
      if (dry >= 10) break;
    }
    cap.add(`S — /skills panel, unioned over ${steps} Downs`, [...lines].join("\n"));
    return { lines: [...lines], steps };
  } finally {
    p.kill();
    await sleep(500);
  }
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const cwd = path.join(ROOT, "acceptance");
  const runtimeDir = path.join(ROOT, "runtime");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const settingsPath = ensureClaudeRuntimeSettings(runtimeDir, {});

  const cap = new Capture(
    path.join(OUT_DIR, "s2-alias-acceptance.capture.txt"),
    `S2 — claude alias acceptance + /skills classification (claude ${version})`,
  );
  cap.add(
    "spawn shape",
    `claude --permission-mode default --settings <production runtime settings>\ncols=${COLS} rows=${ROWS}\nONE SPAWN PER ARM (see header)`,
  );

  const result = { version, ok: false, acceptance: [] };
  try {
    result.skills = await skillsArm(cwd, settingsPath, cap);
    for (const candidate of CANDIDATES) {
      result.acceptance.push(await acceptanceArm(candidate, cwd, settingsPath, cap));
    }
    cap.add(
      "E — SUMMARY",
      result.acceptance
        .map(
          (r) =>
            `  /${r.name.padEnd(24)} submittedVerbatim=${String(r.submittedVerbatim).padEnd(5)} rejected=${String(r.rejected).padEnd(5)} exited=${r.exited}`,
        )
        .join("\n"),
    );
    result.ok = true;
  } finally {
    const settingsAfter = fs.existsSync(USER_SETTINGS) ? fs.readFileSync(USER_SETTINGS, "utf8") : null;
    const untouched = settingsAfter === settingsBefore;
    cap.add("mutation fence — ~/.claude/settings.json byte-identical?", String(untouched));
    result.settingsUntouched = untouched;

    const endVersion = readVersion();
    result.endVersion = endVersion;
    result.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
    cap.add("version pin", `start=${version}\nend=${endVersion}\ndrift=${result.versionDrift}`);
    cap.save();
    fs.writeFileSync(cap.path, sanitize(fs.readFileSync(cap.path, "utf8")));
    fs.writeFileSync(path.join(OUT_DIR, "s2-alias-acceptance.json"), sanitize(JSON.stringify(result, null, 2)));
    console.log(
      JSON.stringify(
        {
          version: result.version,
          ok: result.ok,
          skillsLines: result.skills?.lines?.length,
          acceptance: result.acceptance.map((r) => ({
            name: r.name,
            submitted: r.submitted,
            rejected: r.rejected,
            exited: r.exited,
          })),
          settingsUntouched: result.settingsUntouched,
          versionDrift: result.versionDrift,
        },
        null,
        2,
      ),
    );
    if (result.versionDrift) process.exitCode = 3;
  }
}

await main();
