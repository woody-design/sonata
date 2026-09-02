// S3 (2026-09 sync, SL-10) — the CODEX `/` slash-picker pool re-walk at 0.152.1.
//
// QUESTION. `shared/slash/builtins.ts` pins its codex half at 0.144.5. Codex has
// since moved through 0.146 → 0.152 (ratatui 0.30, a rollout→state-DB
// migration, and a reworked 0.148 startup), and the changelog triage carries
// three unverified deltas for this surface: `/export` NEW, `/cd` `/pwd` `/cwd`
// NEW, and `/copy` changed from a one-shot to a picker. Measure the pool the
// binary actually offers.
//
// WHY THE PRODUCTION TerminalHost RATHER THAN A BARE SPAWN. Codex's composer is
// only reachable through the boot ceremony SL-6 measured (`-p sonata` profile,
// hook-trust flag, `--no-alt-screen`, the pre-trust ledger). The 2026-08 rig
// spawned the bare binary with an isolated CODEX_HOME and had to re-answer the
// trust screen on every arm; SL-6's `CodexBoot` reaches an idle composer under
// the FIELD spawn shape and exposes `ready()` as the production readiness gate,
// so "the composer is accepting input" is Sonata's own answer rather than a
// screen-scrape guess. This probe drives that rig unmodified — it is shared with
// the concurrently-running SL-7 and is deliberately not edited here; the two
// keystroke helpers it does not carry (`type`, `key`) live locally, on
// `host.writeRaw`.
//
// SKILLS ARE NOT IN THIS POOL, BY THE CLI'S OWN DESIGN. Codex skills are `$name`
// mentions, not slash commands (probe s3, 2026-07) — which is why
// `skills-discovery.ts` gives codex entries a `$` invocation. So unlike the
// claude walk, the `/` picker here needs no personal-skill subtraction: anything
// it offers is first-party. The probe still records the on-disk skill names, so
// that claim is falsifiable from the capture rather than asserted.
//
// THREE CHANNELS, the same shape as S1 (claude) so the two halves of this slice
// are comparable:
//   A. WHOLE-SCAN DOWN-WALK on a bare `/`, growth-stopped.
//   B. PREFIX SWEEP `/a`…`/9`, each walked to exhaustion — a name the scroll
//      missed still has to appear under a letter it contains.
//   C. FULL-NAME PROBES for the changelog hypotheses and for every name the
//      current snapshot carries, so a REMOVED entry is measured as removed
//      rather than inferred from its absence in a scrolling read.
//
// READ-ONLY BY CONSTRUCTION: no picker row is ever Entered and no command is
// ever submitted — every visit ends in Esc and a backspaced composer.
//
// Scratch lives in /private/tmp; the shared driver's `sanitize()` masks both
// username forms plus credential shapes.
import fs from "node:fs";
import path from "node:path";
import { CodexBoot, EXPECT_CODEX_VERSION, assertCodexVersion, codexVersion, sanitize, seedCodexHome, sleep } from "./driver.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const ROOT = "/private/tmp/sonata-sync-2026-09/slash-pool-codex";
const COLS = 200;
const ROWS = 40;
const BOOT_BUDGET_MS = 120_000;

const KEYS = { down: "\x1b[B", esc: "\x1b", backspace: "\x7f" };

const version = assertCodexVersion("s3 start");

// ─── grid parsing ───────────────────────────────────────────────────────────
// MEASURED GEOMETRY (first run of this probe): codex paints its picker BELOW the
// composer, not above it, and the composer itself is a bare `› ` line with no
// rule around it. The first version borrowed S1's claude rule — "picker rows are
// the region above the first horizontal rule" — and the only rule-ish line on a
// codex screen is the TOP of the banner box, so the scan region collapsed to the
// two blank lines above it and the walk measured zero commands.
//
// The honest discriminator here is the ROW SHAPE, not a screen region: two
// spaces of indent, an invocation, a run of spaces, a description. The three
// things that could be mistaken for one are all excluded by that shape —
// the banner box (`│ model:  gpt-5.6-sol  /model to change  │`, which does not
// start with a slash), the composer echo (`› /a`, which has no description), and
// prose that mentions a command (`Run /usage to use one.`, one space). Box lines
// are dropped outright as a second belt.
const ROW_RE = /^\s{1,6}(\/[a-z0-9][a-z0-9:._-]*)\s{2,}(.*)$/i;

function commandRows(screen) {
  const out = [];
  for (const raw of screen.split("\n")) {
    if (raw.includes("│")) continue;
    const m = ROW_RE.exec(raw.replace(/\s+$/, ""));
    if (m) out.push({ name: m[1].slice(1), description: m[2].trim(), text: raw.trim().replace(/\s{2,}/g, "  ") });
  }
  return out;
}

// ─── keystroke helpers (local — the shared driver is SL-7's and stays put) ──
async function type(boot, text, perCharMs = 28) {
  for (const ch of text) {
    boot.host.writeRaw(ch);
    await sleep(perCharMs);
  }
}
function key(boot, k) {
  boot.host.writeRaw(k);
}
async function clearComposer(boot, chars) {
  for (let i = 0; i < chars + 5; i++) key(boot, KEYS.backspace);
  await sleep(350);
}

/** Growth-stopped Down-walk of whatever list is open, unioning into `into`. */
async function walkOpenPicker(boot, into, { stepMs = 170, maxSteps = 300, patience = 8 } = {}) {
  let steps = 0;
  let dry = 0;
  for (const row of commandRows(boot.screen())) if (!into.has(row.name)) into.set(row.name, row);
  for (let i = 1; i <= maxSteps; i++) {
    key(boot, KEYS.down);
    await sleep(stepMs);
    steps = i;
    let grew = false;
    for (const row of commandRows(boot.screen())) {
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

// ─── channel C candidates ───────────────────────────────────────────────────
// Every name the current snapshot carries, plus the changelog hypotheses. An
// entry that returns no exact row is measured as GONE, which is the half a
// scrolling walk cannot assert.
const SNAPSHOT_NAMES = [
  "model", "permissions", "compact", "status", "diff", "init", "mcp", "fast",
  "review", "new", "clear", "archive", "delete", "resume", "fork", "app", "plan",
  "goal", "agent", "subagents", "side", "btw", "copy", "raw", "mention", "skills",
  "hooks", "plugins", "ps", "stop", "experimental", "memories", "personality",
  "feedback", "import", "keymap", "theme", "title", "statusline", "pets", "vim",
  "ide", "rename", "approve", "usage", "logout", "quit", "exit",
];
const HYPOTHESES = ["export", "cd", "pwd", "cwd", "undo", "login", "help", "about"];
const NAME_PROBES = [...new Set([...SNAPSHOT_NAMES, ...HYPOTHESES])];

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const cwd = path.join(ROOT, "walk");
  const runtimeDir = path.join(ROOT, "runtime");
  const binDir = path.join(ROOT, "bin");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  // ISOLATED CODEX_HOME, auth seeded (q20's `fresh-pretrusted` shape). Two
  // reasons, and the second is the load-bearing one:
  //   • the production arm regenerates the user's REAL `~/.codex/
  //     sonata.config.toml` when `pretrustCwd` is set, and this probe has no
  //     business writing there for a read-only question;
  //   • an isolated home carries NO user plugins or config, so whatever the
  //     picker offers here is first-party by construction — the same boundary
  //     S1 had to reconstruct on the claude side by subtracting on-disk names.
  const codexHome = seedCodexHome(path.join(ROOT, "codex-home"));

  const parts = [`# S3 — codex /-picker pool walk (codex ${version})`, `# captured ${new Date().toISOString()}`, ""];
  const add = (section, body) => parts.push(`===== ${section} =====`, String(body), "");
  const frame = (boot, label) => add(label, `--- screen ---\n${boot.screen()}`);

  const result = { version, ok: false };
  const boot = new CodexBoot({
    taskId: "sl10-slash-pool",
    cwd,
    runtimeDir,
    binDir,
    pretrustCwd: cwd,
    codexHome,
    rows: ROWS,
    cols: COLS,
  });
  try {
    await boot.start();
    add("spawn shape", `${JSON.stringify(boot.spawnedArgs)}\ncols=${COLS} rows=${ROWS}`);
    const readyAt = await boot.waitUntil((b) => b.ready(), BOOT_BUDGET_MS);
    add("boot — production acceptsPromptInput() went true at", `${readyAt} ms`);
    frame(boot, "boot — idle composer");
    if (readyAt === null) throw new Error("codex never reached a composer that accepts input");
    await sleep(2500);

    // Record what codex skills exist on disk, so "the / picker carries no
    // skills" is falsifiable from the capture rather than asserted.
    const diskSkills = [];
    for (const root of [
      path.join(process.env.CODEX_HOME?.trim() || path.join(process.env.HOME ?? "", ".codex"), "skills"),
      path.join(process.env.HOME ?? "", ".agents", "skills"),
    ]) {
      try {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) diskSkills.push(`${e.name}  [${root.replace(process.env.HOME ?? "", "$HOME")}]`);
      } catch {
        /* absent is fine */
      }
    }
    add("on-disk codex skills ($-invoked, expected ABSENT from the / picker)", diskSkills.join("\n") || "  (none)");

    // ─── A ────────────────────────────────────────────────────────────────
    await type(boot, "/");
    await sleep(1300);
    frame(boot, "A — picker OPEN on bare `/`");
    const a = new Map();
    const walkA = await walkOpenPicker(boot, a, { stepMs: 170, maxSteps: 300, patience: 10 });
    frame(boot, "A — picker at the END of the Down walk");
    add(
      `A — bare-\`/\` walk (steps=${walkA.steps}, endedDry=${walkA.endedDry}, names=${a.size})`,
      [...a.values()].map((r) => `  | ${r.text}`).join("\n"),
    );
    key(boot, KEYS.esc);
    await sleep(500);
    await clearComposer(boot, 1);

    // ─── B ────────────────────────────────────────────────────────────────
    const b = new Map();
    const bNotes = [];
    for (const c of "abcdefghijklmnopqrstuvwxyz0123456789".split("")) {
      await type(boot, `/${c}`);
      await sleep(600);
      const local = new Map();
      const walk = await walkOpenPicker(boot, local, { stepMs: 140, maxSteps: 120, patience: 6 });
      for (const [name, row] of local) if (!b.has(name)) b.set(name, row);
      bNotes.push(
        `/${c}  names=${local.size} (steps=${walk.steps}, endedDry=${walk.endedDry})\n` +
          [...local.values()].map((r) => `        | ${r.text}`).join("\n"),
      );
      key(boot, KEYS.esc);
      await sleep(280);
      await clearComposer(boot, 2);
    }
    add("B — prefix sweep (a–z, 0–9), each walked to exhaustion", bNotes.join("\n"));

    // ─── C ────────────────────────────────────────────────────────────────
    const probes = [];
    for (const name of NAME_PROBES) {
      await type(boot, `/${name}`, 20);
      await sleep(700);
      const rows = commandRows(boot.screen());
      const exact = rows.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null;
      probes.push({ name, exact: Boolean(exact), description: exact?.description ?? null, offered: rows.map((r) => r.name) });
      key(boot, KEYS.esc);
      await sleep(250);
      await clearComposer(boot, name.length + 1);
    }
    add(
      "C — full-name probes (exact row present?)",
      probes
        .map((r) => `  /${r.name.padEnd(14)} exact=${String(r.exact).padEnd(5)} offered=[${r.offered.join(", ")}]${r.description ? `\n      ${r.description}` : ""}`)
        .join("\n"),
    );

    // ─── union ────────────────────────────────────────────────────────────
    const union = new Map();
    for (const [name, row] of a) union.set(name, { ...row, channels: ["A"] });
    for (const [name, row] of b) {
      const existing = union.get(name);
      if (existing) existing.channels.push("B");
      else union.set(name, { ...row, channels: ["B"] });
    }
    for (const probe of probes) {
      if (!probe.exact) continue;
      const existing = union.get(probe.name);
      if (existing) existing.channels.push("C");
      else union.set(probe.name, { name: probe.name, description: probe.description, text: `/${probe.name}  ${probe.description}`, channels: ["C"] });
    }
    const pool = [...union.entries()].sort().map(([name, row]) => ({ name, description: row.description, channels: row.channels.join("") }));
    add("MEASURED POOL", pool.map((r) => `  ${r.channels.padEnd(3)} /${r.name}\n        ${r.description}`).join("\n"));

    result.ok = true;
    result.walk = { channelA: a.size, channelAsteps: walkA.steps, channelAendedDry: walkA.endedDry, channelB: b.size };
    result.pool = pool;
    result.nameProbes = probes;
    result.diskSkills = diskSkills;
  } catch (error) {
    add("PROBE ERROR", String(error?.stack ?? error));
    result.error = String(error?.message ?? error);
  } finally {
    boot.dispose();
    const endVersion = codexVersion();
    result.endVersion = endVersion;
    result.versionDrift = !endVersion.includes(EXPECT_CODEX_VERSION);
    add("version pin", `start=${version}\nend=${endVersion}\ndrift=${result.versionDrift}`);
    fs.writeFileSync(path.join(OUT_DIR, "s3-slash-pool.capture.txt"), sanitize(parts.join("\n")));
    fs.writeFileSync(path.join(OUT_DIR, "s3-slash-pool.json"), sanitize(JSON.stringify(result, null, 2)));
    console.log(
      JSON.stringify(
        { version: result.version, ok: result.ok, error: result.error, walk: result.walk, pool: result.pool?.length, versionDrift: result.versionDrift },
        null,
        2,
      ),
    );
    if (result.versionDrift) process.exitCode = 3;
  }
}

await main();
