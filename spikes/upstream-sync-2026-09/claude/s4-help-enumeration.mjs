// S4 (2026-09 sync, SL-10) — an UNCAPPED enumeration of the claude command
// pool at 2.1.258, because S1's two picker channels turned out to share a cap.
//
// WHY. S1 ran two independent channels and they agreed to the name: the bare-`/`
// walk and the a–z/0–9 prefix sweep each returned exactly 120 names, zero
// channel-exclusive. That looked like strong convergence. It was actually a
// SHARED CEILING, and channel C is what exposed it: `/artifact-design` returns
// an exact picker row when you type its whole name, and appears in NEITHER
// broad channel. Re-reading S1's own numbers confirms the shape —
//
//     bare `/`  → 120 names, walk ended dry
//     /a → 116   /c → 111   /d → 103   /i → 115   /n → 113   /o → 114
//     /r → 109   /s → 115   /u → 107   /e → 118*  /t → 118*      (* truncated)
//
// — nothing anywhere returns more than 120, the bare list stops growing at
// exactly 120, and a name provably in the pool is absent from all of it. Two
// channels that share a ceiling are ONE channel measured twice; convergence
// between them is not evidence of completeness. So S1's pool is a LOWER BOUND,
// and this probe goes looking for the rest.
//
// THE UNCAPPED CHANNEL. `/help` is the CLI's own enumeration, and it is not
// ranked or clipped the way the picker is. MEASURED (first run of this probe):
// at 2.1.258 `/help` opens a TABBED panel — `Help │ General │ Commands │ Custom
// commands` — whose landing tab is shortcuts and prose, which is why the first
// run parsed ZERO command rows and briefly looked like "`/help` does not
// enumerate". The enumeration lives one tab over. So the panel is walked by tab
// AND by row: Tab to advance, a growth-stopped Down walk inside each tab, and
// the union taken across all of them. Walking every tab rather than hunting for
// the right one costs seconds and removes a guess about which key selects.
//
// THE FAMILY SWEEP (second arm, cheap insurance). Every name S1 did find is
// queried at its FAMILY STEM — `/artifact`, `/design`, `/install`, `/reload`,
// `/remote`, `/usage`, `/auto`, `/run`, `/web`, `/work`, … — which is exactly
// the query shape that surfaced `/artifact-design`: narrow enough that the whole
// family fits under the cap. It cannot find a name with no sibling, which is why
// it is the insurance and `/help` is the channel.
//
// READ-ONLY-ish: `/help` prints; nothing is configured, and the user's
// `~/.claude/settings.json` is fenced byte-for-byte.
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
const ROOT = "/private/tmp/sonata-sync-2026-09/slash-help-claude";
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

// ─── grid parsing (S1's rule, minus the region restriction) ────────────────
// `/help` renders into the TRANSCRIPT, which is above the composer rule just
// like the picker, so the same region rule applies; the row shape is the same
// two-space-indent + invocation + gap + description.
const ROW_RE = /^\s{1,6}(\/[a-z0-9][a-z0-9:._-]*)((?:\s+\([a-z0-9 ,:._|/-]+\))?)\s{2,}(.*)$/i;
const RULE_RE = /^─{20,}/;

function rowsFrom(text) {
  const lines = text.split("\n");
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (RULE_RE.test(line.trim())) continue;
    const m = ROW_RE.exec(line);
    if (!m) continue;
    out.push({
      name: m[1].slice(1),
      aliases: m[2] ? m[2].trim().replace(/^\(|\)$/g, "").split(/[,\s|/]+/).filter(Boolean) : [],
      description: m[3].trim(),
      text: line.trim().replace(/\s{2,}/g, "  "),
    });
  }
  return out;
}

/**
 * `/help`'s Commands tab uses a DIFFERENT row shape from the picker's: the
 * invocation sits alone on its line behind a selection marker, and the
 * description is indented on the NEXT line —
 *
 *       /add-dir
 *         Add a new working directory
 *     ❯ /branch
 *         Create a branch of the current conversation at this point
 *
 * The picker's one-line `name  gap  description` regex matches none of it, which
 * is why the first tab-walk read zero rows off a tab that was plainly showing
 * them and stopped after its patience ran out.
 */
const HELP_NAME_RE = /^\s{0,6}[❯↓↑>]?\s{1,6}(\/[a-z0-9][a-z0-9:._-]*)\s*$/i;

function helpRowsFrom(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HELP_NAME_RE.exec(lines[i].replace(/\s+$/, ""));
    if (!m) continue;
    const next = (lines[i + 1] ?? "").trim();
    // The description line is indented further than the name and is not itself
    // another command row; anything else means the name stood alone (clipped at
    // a viewport edge) and the description is simply unknown for that read.
    const description = next && !HELP_NAME_RE.test(lines[i + 1] ?? "") ? next : "";
    out.push({ name: m[1].slice(1), aliases: [], description, text: `${m[1]}  ${description}` });
  }
  return out;
}

/** The full xterm scrollback, not just the viewport — `/help` is many screens. */
function scrollback(p) {
  const b = p.term.buffer.active;
  const lines = [];
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y);
    lines.push(line ? line.translateToString(true) : "");
  }
  return lines.join("\n");
}

async function clearComposer(p, chars) {
  for (let i = 0; i < chars + 5; i++) p.write("\x7f");
  await sleep(300);
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const cwd = path.join(ROOT, "help");
  const runtimeDir = path.join(ROOT, "runtime");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const settingsPath = ensureClaudeRuntimeSettings(runtimeDir, {});

  const cap = new Capture(
    path.join(OUT_DIR, "s4-help-enumeration.capture.txt"),
    `S4 — claude /help enumeration + family sweep (claude ${version})`,
  );
  cap.add("spawn shape", `claude --permission-mode default --settings <production runtime settings>\ncols=${COLS} rows=${ROWS}`);

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

    // ─── arm H: /help ─────────────────────────────────────────────────────
    await p.type("/help", 25);
    await sleep(900);
    p.write(KEYS.esc); // dismiss the picker so Enter submits the typed text
    await sleep(600);
    p.write(KEYS.enter);
    await sleep(6000);
    cap.frame(p, "H — /help, landing tab");

    const helpFound = new Map();
    const absorbHelp = () => {
      let grew = false;
      // Read the VIEWPORT: the panel repaints in place, so a row's description
      // is only adjacent to its name in the current frame.
      for (const row of helpRowsFrom(p.screen())) {
        const existing = helpFound.get(row.name);
        if (!existing) {
          helpFound.set(row.name, row);
          grew = true;
        } else if (!existing.description && row.description) {
          // A name first seen clipped at a viewport edge gets its description
          // the next time it is painted whole.
          helpFound.set(row.name, row);
        }
      }
      return grew;
    };
    const tabTrace = [];
    for (let tab = 0; tab < 5; tab++) {
      if (tab > 0) {
        p.write(KEYS.tab);
        await sleep(1200);
      }
      const header = p.screen().split("\n").find((l) => /Help\b/.test(l))?.trim() ?? "(no header row)";
      const before = helpFound.size;
      absorbHelp();
      let dry = 0;
      let steps = 0;
      for (let i = 1; i <= 400; i++) {
        p.write(KEYS.down);
        await sleep(110);
        steps = i;
        dry = absorbHelp() ? 0 : dry + 1;
        if (dry >= 15) break;
      }
      cap.frame(p, `H — /help tab ${tab} after ${steps} Downs`);
      tabTrace.push(`tab ${tab}  header=${JSON.stringify(header)}  steps=${steps}  new names=${helpFound.size - before}  running total=${helpFound.size}`);
    }
    cap.add("H — tab walk", tabTrace.join("\n"));
    cap.add("H — /help, FULL SCROLLBACK", scrollback(p));
    const helpRows = [...helpFound.values()];
    cap.add(
      `H — /help parsed rows (${helpRows.length})`,
      helpRows.map((r) => `  | ${r.text}`).join("\n") || "  (none — /help does not enumerate commands at this version)",
    );
    p.write(KEYS.esc);
    await sleep(600);
    await clearComposer(p, 6);

    // ─── arm F: family sweep ──────────────────────────────────────────────
    const s1 = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "s1-slash-pool.json"), "utf8"));
    const known = new Set(s1.builtins.map((b) => b.name));
    // Stems: the part before the first `-`, for every hyphenated name S1 found,
    // plus the short whole names that plausibly head a family.
    const stems = new Set();
    for (const name of known) {
      if (name.includes("-")) stems.add(name.split("-")[0]);
      if (name.length <= 7) stems.add(name);
    }
    const familyNotes = [];
    const found = new Map();
    for (const stem of [...stems].sort()) {
      await p.type(`/${stem}`, 18);
      await sleep(650);
      const rows = rowsFrom(p.screen().split("\n").slice(0, p.screen().split("\n").findIndex((l) => RULE_RE.test(l.trim())) + 1 || undefined).join("\n"));
      const names = [];
      for (const row of rows) {
        names.push(row.name);
        if (!found.has(row.name)) found.set(row.name, row);
      }
      const novel = names.filter((n) => !known.has(n) && !n.includes(":"));
      familyNotes.push(`/${stem.padEnd(16)} → [${names.join(", ")}]${novel.length ? `   NOVEL: ${novel.join(", ")}` : ""}`);
      p.write(KEYS.esc);
      await sleep(220);
      await clearComposer(p, stem.length + 1);
    }
    cap.add("F — family sweep (stems derived from S1's names)", familyNotes.join("\n"));

    const novel = [...found.values()].filter((r) => !known.has(r.name));
    cap.add(
      "F — names NOT in S1's pool",
      novel.map((r) => `  /${r.name}\n        ${r.description}`).join("\n") || "  (none)",
    );

    result.ok = true;
    result.helpRows = helpRows.map((r) => ({ name: r.name, aliases: r.aliases, description: r.description }));
    result.helpEnumerates = helpRows.length > 10;
    result.familyNovel = novel.map((r) => ({ name: r.name, aliases: r.aliases, description: r.description }));
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
    fs.writeFileSync(cap.path, sanitize(fs.readFileSync(cap.path, "utf8")));
    fs.writeFileSync(path.join(OUT_DIR, "s4-help-enumeration.json"), sanitize(JSON.stringify(result, null, 2)));
    console.log(
      JSON.stringify(
        {
          version: result.version,
          ok: result.ok,
          helpRows: result.helpRows?.length,
          helpEnumerates: result.helpEnumerates,
          familyNovel: result.familyNovel?.map((r) => r.name),
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
