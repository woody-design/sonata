// S1 (2026-09 sync, SL-10) — the CLAUDE `/` slash-picker pool re-walk at 2.1.258.
//
// QUESTION. `shared/slash/builtins.ts` is a version-pinned SNAPSHOT of what the
// CLI's own `/` picker offers (neither CLI exposes a machine-readable command
// list — re-verified 2026-07-14). It was last pinned at 2.1.212. The 2026-08
// walk was paint-noisy and only changelog-confirmed deltas were taken, so the
// snapshot has been drifting for ~46 releases. Measure the pool the CLI actually
// offers this account, at the current binary, from the live picker.
//
// WHY IT MATTERS MORE THAN IT USED TO. 2.1.236 removed the fuzzy match on
// SUBMIT. Before that, a stale snapshot name that had been renamed upstream
// still near-matched and the CLI ran the successor; now the same name ERRORS.
// The snapshot's degradation contract (submit never consults the registry — S3,
// 2026-07-27) still holds for MISSING commands, but a WRONG name is no longer
// forgiven by the CLI. Removals and renames are now the load-bearing half of a
// refresh, not the cosmetic half.
//
// READ-ONLY BY CONSTRUCTION. This probe never submits a slash command and never
// presses Enter on a picker row: every visit ends in Esc, and the composer is
// cleared with backspaces. It also brackets itself with a byte-identity check on
// the user's `~/.claude/settings.json` — a drift there would be a probe BUG
// (something got executed), reported loudly rather than restored quietly.
//
// ─── PICKER GEOMETRY, MEASURED BY THIS PROBE'S FIRST RUN ────────────────────
// Two facts about 2.1.258's picker were discovered by running it, and both
// invalidated the first version's stopping rules — recorded here because they
// are the reason the walk is shaped the way it is:
//
//   1. THE WINDOW IS FOUR LINES, NOT FOUR ITEMS. At cols=120 a long description
//      wraps and the picker showed TWO commands; the same window showed four
//      when the descriptions fit on one line. So the probe runs WIDE
//      (cols=200) — not for prettier captures, but because width buys visible
//      items per frame, which is the only thing that bounds the walk.
//   2. THE FILTER IS STILL FUZZY (subsequence, not prefix): `/e` matched
//      `/orchestration` and `/g` matched `/architect`. 2.1.236's removal was on
//      SUBMIT, not on the picker. So a prefix sweep is NOT a small exact list
//      and must be walked like the bare list.
//   3. THERE IS NO `❯` ON PICKER ROWS. Focus is carried by colour alone, so the
//      first version's wrap/stall detection (built on a focused-label read, the
//      q12 idiom) never fired and the walk simply burned its step budget. The
//      stop rule here is GROWTH-based instead: stop after K consecutive Downs
//      that add no new name. That rule needs no focus channel at all and is the
//      honest one for a union-scan.
//
// TWO INDEPENDENT CHANNELS, because "did we see the WHOLE pool?" is exactly the
// question a single scrolling walk cannot answer honestly:
//
//   A. WHOLE-SCAN DOWN-WALK on a bare `/`.
//   B. PREFIX SWEEP: `/<c>` for every c in a–z and 0–9, each one walked to
//      exhaustion the same way. A name channel A's scroll missed still has to
//      show up under a letter it contains.
//   C. NAME PROBES: type a full candidate name and record whether the picker
//      offers an EXACT row. This is the channel that answers the alias and
//      removal hypotheses (`/review`, `/checkpoint`, `/stats`, `/ultraplan`…) —
//      a fuzzy-matched neighbour is not an exact hit, and post-2.1.236 a name
//      with no exact row is a name that would ERROR on submit.
//
// The union of A and B is the measured pool; the capture records which channel
// saw each name, so a name seen by only one is visible as such rather than
// silently averaged in.
//
// GRID SCANNING RULE. Only lines ABOVE the composer's first horizontal rule are
// picker rows. That one rule excludes the composer's own echoed query (`❯ /a`,
// which the first run mistook for a command named `/a`), the Remote Control
// `/rc` pill on the status line, and the mode footer — all three of which sit
// BELOW the rule and all three of which polluted the first run's pool.
//
// CURATION BOUNDARY (carried from builtins.ts): only FIRST-PARTY CLI builtins
// are snapshotted. The live picker also carries the user's PERSONAL skills and
// INSTALLED PLUGIN commands, which are per-environment. Personal skills are
// subtracted by enumerating them off disk (~/.claude/skills, ~/.claude/commands)
// and the list is printed in the capture, so the classification is auditable
// rather than asserted; plugin commands are subtracted on their namespaced
// `plugin:command` spelling. CLI-BUNDLED skills (`/code-review`, `/simplify`,
// `/run`, …) are NOT subtracted — they ship with the binary, are present on
// every install, and the existing snapshot already carries them.
//
// Scratch lives in /private/tmp (never the agent scratchpad, whose path embeds
// the username): these frames become findings and the pre-push fence scans blob
// CONTENT.
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
const ROOT = "/private/tmp/sonata-sync-2026-09/slash-pool-claude";
const COLS = 200;
const ROWS = 40;

const HOME = os.homedir();
const USER = os.userInfo().username;
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value)
    .split(HOME)
    .join("$HOME")
    .split(USER_MUNGED)
    .join("-$USER_MUNGED-")
    .split(USER)
    .join("$USER");

// ─── version pin ────────────────────────────────────────────────────────────
// START drift aborts (nothing measured yet, nothing to lose). END drift RECORDS
// itself, lets the capture save, and exits non-zero afterwards — the SL-4 method
// note: a mid-run auto-update must not throw away a completed measurement.
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

// ─── mutation fence ─────────────────────────────────────────────────────────
const USER_SETTINGS = path.join(HOME, ".claude", "settings.json");
const settingsBefore = fs.existsSync(USER_SETTINGS) ? fs.readFileSync(USER_SETTINGS, "utf8") : null;

// ─── on-disk personal commands (the subtraction list) ───────────────────────
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
function personalCommandNames() {
  const names = new Map(); // name -> source
  for (const entry of safeReaddir(path.join(HOME, ".claude", "skills"))) {
    names.set(entry.name, "~/.claude/skills");
  }
  for (const entry of safeReaddir(path.join(HOME, ".claude", "commands"))) {
    if (entry.name.endsWith(".md")) names.set(entry.name.replace(/\.md$/, ""), "~/.claude/commands");
  }
  return names;
}

// ─── grid parsing ───────────────────────────────────────────────────────────
/**
 * Row shape (2.1.25x): two spaces of indent, the invocation, then a run of
 * spaces, then the description. No cursor glyph — focus is colour-only.
 * Alias folding (2.1.210) paints aliases in parentheses after the canonical
 * name, so the parse keeps a slot for them even though 2.1.258 turned out to
 * print none (see findings).
 */
const ROW_RE = /^\s{1,4}(\/[a-z0-9][a-z0-9:._-]*)((?:\s+\([a-z0-9 ,:._-]+\))?)\s{2,}(.*)$/i;
const RULE_RE = /^─{20,}/;

/** Command rows visible on the grid right now. Only the region ABOVE the
 *  composer's first horizontal rule counts (see GRID SCANNING RULE). */
function commandRows(screen) {
  const lines = screen.split("\n");
  const ruleAt = lines.findIndex((l) => RULE_RE.test(l.trim()));
  const region = ruleAt >= 0 ? lines.slice(0, ruleAt) : lines;
  const out = [];
  for (const raw of region) {
    const line = raw.replace(/\s+$/, "");
    const m = ROW_RE.exec(line);
    if (!m) continue;
    out.push({
      name: m[1].slice(1),
      aliases: m[2] ? m[2].trim().replace(/^\(|\)$/g, "").split(/[,\s]+/).filter(Boolean) : [],
      description: m[3].trim(),
      text: line.trim().replace(/\s{2,}/g, "  "),
    });
  }
  return out;
}

/** Clear the composer without submitting. */
async function clearComposer(p, chars) {
  for (let i = 0; i < chars + 4; i++) p.write("\x7f");
  await sleep(350);
}

/**
 * Down-walk the OPEN picker, unioning every row seen into `into`.
 *
 * Stop rule is GROWTH-based (see geometry note 3): quit after `patience`
 * consecutive Downs that contribute no new name. A scrolling list that has
 * reached its end stops changing, and a list that wraps stops contributing —
 * both terminate here, and neither needs a focus channel the CLI no longer
 * paints.
 */
async function walkOpenPicker(p, into, { stepMs = 170, maxSteps = 400, patience = 8 } = {}) {
  let steps = 0;
  let dry = 0;
  for (const row of commandRows(p.screen())) if (!into.has(row.name)) into.set(row.name, row);
  for (let i = 1; i <= maxSteps; i++) {
    p.write(KEYS.down);
    await sleep(stepMs);
    steps = i;
    let grew = false;
    for (const row of commandRows(p.screen())) {
      if (!into.has(row.name)) {
        into.set(row.name, row);
        grew = true;
      }
    }
    dry = grew ? 0 : dry + 1;
    if (dry >= patience) break;
  }
  return { steps, endedDry: dry >= patience };
}

// ─── channel A ──────────────────────────────────────────────────────────────
async function downWalk(p, cap) {
  await p.type("/", 30);
  await sleep(1300);
  cap.frame(p, "A — picker OPEN on bare `/`", { attrs: true });
  const seen = new Map();
  const walk = await walkOpenPicker(p, seen, { stepMs: 170, maxSteps: 400, patience: 10 });
  cap.frame(p, "A — picker at the END of the Down walk");
  cap.add(
    `A — bare-\`/\` walk (steps=${walk.steps}, endedDry=${walk.endedDry}, names=${seen.size})`,
    [...seen.values()].map((r) => `  | ${r.text}`).join("\n"),
  );
  p.write(KEYS.esc);
  await sleep(400);
  await clearComposer(p, 1);
  return { seen, walk };
}

// ─── channel B ──────────────────────────────────────────────────────────────
const PREFIXES = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

async function prefixSweep(p, cap) {
  const seen = new Map();
  const notes = [];
  for (const c of PREFIXES) {
    await p.type(`/${c}`, 25);
    await sleep(600);
    const local = new Map();
    const walk = await walkOpenPicker(p, local, { stepMs: 140, maxSteps: 120, patience: 6 });
    for (const [name, row] of local) if (!seen.has(name)) seen.set(name, row);
    notes.push(
      `/${c}  names=${local.size} (steps=${walk.steps}, endedDry=${walk.endedDry})\n` +
        [...local.values()].map((r) => `        | ${r.text}`).join("\n"),
    );
    p.write(KEYS.esc);
    await sleep(280);
    await clearComposer(p, 2);
  }
  cap.add("B — prefix sweep (a–z, 0–9), each walked to exhaustion", notes.join("\n"));
  return seen;
}

// ─── channel C ──────────────────────────────────────────────────────────────
// Full-name probes for the hypotheses this slice has to settle. An EXACT row is
// the evidence; a fuzzy neighbour is not. Post-2.1.236 a candidate with no exact
// row is a name that would ERROR on submit, which is what makes this channel the
// load-bearing one for removals and renames.
const NAME_PROBES = [
  // Changelog hypotheses for this slice.
  "review", "code-review", "ultraplan", "ultrareview",
  // Alias spellings the snapshot still carries as known-but-unlisted (2.1.210
  // folded them under a canonical name; whether they are still ACCEPTED is the
  // question the fuzzy-match removal turned from cosmetic into load-bearing).
  "checkpoint", "undo", "stats", "cost", "bashes", "quit", "plugins",
  // Snapshot entries channel A/B did not return — each one has to be either
  // confirmed present or recorded as gone.
  "deep-research", "recap", "artifact-design", "rc", "pwd", "cwd",
];

async function nameProbes(p, cap) {
  const results = [];
  for (const name of NAME_PROBES) {
    await p.type(`/${name}`, 20);
    await sleep(750);
    const rows = commandRows(p.screen());
    const exact = rows.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null;
    results.push({
      name,
      exact: Boolean(exact),
      description: exact?.description ?? null,
      offered: rows.map((r) => r.name),
    });
    p.write(KEYS.esc);
    await sleep(250);
    await clearComposer(p, name.length + 1);
  }
  cap.add(
    "C — full-name probes (exact row present?)",
    results
      .map((r) => `  /${r.name.padEnd(20)} exact=${String(r.exact).padEnd(5)} offered=[${r.offered.join(", ")}]${r.description ? `\n      ${r.description}` : ""}`)
      .join("\n"),
  );
  return results;
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const cwd = path.join(ROOT, "walk");
  const runtimeDir = path.join(ROOT, "runtime");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const settingsPath = ensureClaudeRuntimeSettings(runtimeDir, {});

  const cap = new Capture(
    path.join(OUT_DIR, "s1-slash-pool.capture.txt"),
    `S1 — claude /-picker pool walk (claude ${version})`,
  );
  cap.add(
    "spawn shape",
    `claude --permission-mode default --settings <production runtime settings>\ncols=${COLS} rows=${ROWS}\ncwd=${sanitize(cwd)} (outside any project: no PROJECT skills in the pool)`,
  );

  const onDisk = personalCommandNames();
  cap.add(
    "curation boundary — on-disk personal commands (subtracted from the measured pool)",
    [...onDisk.entries()].sort().map(([n, src]) => `  ${n.padEnd(34)} ${src}`).join("\n") || "  (none)",
  );

  const p = new Probe({
    cwd,
    rows: ROWS,
    cols: COLS,
    args: ["--permission-mode", "default", "--settings", settingsPath],
  });
  const result = { version, ok: false };
  try {
    const trust = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
    if (trust) {
      cap.frame(p, "boot — trust dialog");
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        p.write(KEYS.down);
        await sleep(350);
        if (p.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l))) break;
      }
      p.write(KEYS.enter);
      await sleep(1800);
    }
    const composer = await p.waitFor(/for shortcuts|Welcome back|Try "|>\s*$/i, 60_000);
    cap.add("boot — reached composer?", `${composer} (trustDialogSeen=${trust})`);
    await sleep(2500);

    const a = await downWalk(p, cap);
    const b = await prefixSweep(p, cap);
    const c = await nameProbes(p, cap);

    const union = new Map();
    for (const [name, row] of a.seen) union.set(name, { ...row, channels: ["A"] });
    for (const [name, row] of b) {
      const existing = union.get(name);
      if (existing) existing.channels.push("B");
      else union.set(name, { ...row, channels: ["B"] });
    }

    const builtins = [];
    const excluded = [];
    for (const [name, row] of [...union.entries()].sort()) {
      const personal = onDisk.get(name);
      const plugin = name.includes(":") ? `plugin (namespaced ${name.split(":")[0]})` : null;
      if (personal || plugin) excluded.push({ name, source: personal ?? plugin, ...row });
      else builtins.push({ name, ...row });
    }

    cap.add(
      "MEASURED POOL — first-party CLI commands (personal skills + plugins subtracted)",
      builtins.map((r) => `  ${r.channels.join("").padEnd(2)}  /${r.name}\n        ${r.description}`).join("\n"),
    );
    cap.add(
      "MEASURED POOL — excluded as personal skill / plugin",
      excluded.map((r) => `  ${r.channels.join("").padEnd(2)}  /${r.name}  [${r.source}]`).join("\n") || "  (none)",
    );

    result.ok = true;
    result.walk = { channelA: a.seen.size, channelAsteps: a.walk.steps, channelAendedDry: a.walk.endedDry, channelB: b.size };
    result.builtins = builtins.map((r) => ({
      name: r.name,
      aliases: r.aliases,
      description: r.description,
      channels: r.channels.join(""),
    }));
    result.excluded = excluded.map((r) => ({ name: r.name, source: r.source }));
    result.nameProbes = c;
  } finally {
    p.kill();
    const settingsAfter = fs.existsSync(USER_SETTINGS) ? fs.readFileSync(USER_SETTINGS, "utf8") : null;
    const untouched = settingsAfter === settingsBefore;
    cap.add("mutation fence — ~/.claude/settings.json byte-identical?", String(untouched));
    result.settingsUntouched = untouched;

    const endVersion = readVersion();
    result.endVersion = endVersion;
    result.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
    cap.add("version pin", `start=${version}\nend=${endVersion}\ndrift=${result.versionDrift}`);
    cap.save();
    // The 2026-08 Capture sanitizes $HOME only. This program's rule is BOTH
    // username forms (the munged `-Users-<user>-` runtime-dir spelling and the
    // bare name), so re-sanitize the written bytes before they can be committed.
    fs.writeFileSync(cap.path, sanitize(fs.readFileSync(cap.path, "utf8")));
    fs.writeFileSync(path.join(OUT_DIR, "s1-slash-pool.json"), sanitize(JSON.stringify(result, null, 2)));
    console.log(
      JSON.stringify(
        { ...result, builtins: result.builtins?.length, excluded: result.excluded?.length, nameProbes: undefined },
        null,
        2,
      ),
    );
    if (result.versionDrift) process.exitCode = 3;
  }
}

await main();
