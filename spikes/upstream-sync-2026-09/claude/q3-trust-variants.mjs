// Q3 (2026-09 sync, SL-1) — workspace-trust dialog: CONDITIONAL-VARIANT matrix
// plus what Sonata's CURRENT production keys actually do at 2.1.252.
//
// Three questions, one binary, one run:
//
//  (a) VARIANTS — is the dialog's row order / default row ever different?
//      Measured across: a fresh plain dir, a fresh `git init` dir, a linked git
//      WORKTREE, a dir whose trust was DECLINED on a previous launch, and a
//      CHILD of a dir trusted earlier in this same run. If any variant reorders
//      the rows, a hardcoded "one Down" fix would be wrong — the fix must read
//      the grid and pick its direction from it.
//
//  (b) TODAY'S PRODUCTION KEYS — at 2.1.252 the structured panel parser
//      (parseClaudeApprovalPanel) returns NULL on this dialog (its options
//      carry no `1.`/`2.` digits any more), so detection falls to the LEGACY
//      hint path, whose approve encoding is CSI-u Enter (`\x1b[13u`) — NOT the
//      `\r` in claudePanelOptionKeys. So BOTH keys are measured on a live
//      dialog: CSI-u Enter (does Approve do nothing?) and plain `\r` (does
//      Approve decline + exit?). Each on its own fresh dir — a `\r` ends the
//      session.
//
//  (c) THE FIX'S WALK — the grid-verified, direction-from-the-grid,
//      bounded-retry walk this slice puts into production, exercised on every
//      variant: read grid → affirm row focused? → else step Down/Up toward it →
//      re-read → confirm with `\r` only once the affirm row owns the cursor.
//
// Scratch dirs live under /private/tmp/sonata-sync-2026-09 (NOT the agent
// scratchpad, whose path embeds the username) so every captured grid line is
// publishable verbatim — the tests/fixtures files this probe feeds are tracked
// and the pre-push leak fence scans them.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Capture, Probe, KEYS, sleep } from "../../upstream-sync-2026-08/claude/driver.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const ROOT = "/private/tmp/sonata-sync-2026-09/trust-variants";
const EXPECT_VERSION = "2.1.252";
const CSI_U_ENTER = "\x1b[13u";

const AFFIRM_RE = /Yes,\s*I\s*trust\s*this\s*folder/i;
const DECLINE_RE = /No,\s*exit/i;
const CURSOR_RE = /❯/;

const cap = new Capture(
  path.join(OUT_DIR, "q3-trust-variants.capture.txt"),
  "Q3 — claude 2.1.252 workspace-trust dialog: variant matrix + production-key behaviour",
);

// ── binary pin ───────────────────────────────────────────────────────────────
const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
cap.add("claude --version", version);
if (!version.startsWith(EXPECT_VERSION)) {
  cap.add("ABORT", `binary moved off ${EXPECT_VERSION} — refusing to probe a moving target`);
  cap.save();
  process.exit(2);
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// ── grid readers (the shape the production fix uses) ─────────────────────────

/** The dialog's option rows, in SCREEN ORDER, with which one owns the ❯ cursor. */
function optionRows(screen) {
  const rows = [];
  screen.split("\n").forEach((line, index) => {
    const affirm = AFFIRM_RE.test(line);
    const decline = DECLINE_RE.test(line);
    if (!affirm && !decline) {
      return;
    }
    rows.push({ index, role: affirm ? "affirm" : "decline", focused: CURSOR_RE.test(line), text: line.trimEnd() });
  });
  return rows;
}

function describeRows(rows) {
  if (rows.length === 0) {
    return "(no option rows on screen)";
  }
  return rows.map((r) => `${r.focused ? "❯" : " "} [${r.role}] ${JSON.stringify(r.text)}`).join("\n");
}

/**
 * The production walk, verbatim in shape: never a blind key. Reads the grid,
 * takes its DIRECTION from the grid (affirm below the cursor → Down, above →
 * Up), re-reads after every press, and confirms only once the affirm row owns
 * the cursor. Bounded; gives up rather than guessing.
 */
async function walkToAffirmAndConfirm(p, log, { maxSteps = 6, stepMs = 350 } = {}) {
  for (let step = 0; step <= maxSteps; step++) {
    const rows = optionRows(p.screen());
    const affirm = rows.find((r) => r.role === "affirm");
    const focused = rows.find((r) => r.focused);
    if (!affirm) {
      log.push(`step ${step}: affirm row absent from grid — abort (never blind-confirm)`);
      return false;
    }
    if (affirm.focused) {
      log.push(`step ${step}: affirm row focused → confirm with CR`);
      p.write(KEYS.enter);
      return true;
    }
    if (!focused) {
      log.push(`step ${step}: no row carries the cursor — abort`);
      return false;
    }
    if (step === maxSteps) {
      log.push(`step ${step}: step bound exhausted — abort (never blind-confirm)`);
      return false;
    }
    const goingDown = affirm.index > focused.index;
    log.push(
      `step ${step}: cursor on [${focused.role}] row ${focused.index}, affirm at row ${affirm.index} → ${goingDown ? "Down" : "Up"}`,
    );
    p.write(goingDown ? KEYS.down : KEYS.up);
    await sleep(stepMs);
  }
  return false;
}

async function openDialog(cwd, label, extra = {}) {
  const p = new Probe({ cwd, args: ["--permission-mode", "default"], ...extra });
  const seen = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
  cap.add(`${label} — trust dialog appeared?`, `${seen} (exited=${p.exited})`);
  return { p, seen };
}

const matrix = [];

// ── (a) VARIANTS ─────────────────────────────────────────────────────────────

/** Boot in `cwd`, record the UNTOUCHED dialog grid, then walk+confirm. */
async function measureVariant(name, cwd, note) {
  const { p, seen } = await openDialog(cwd, name);
  if (!seen) {
    matrix.push({ name, note, dialog: false, rows: null, defaultRole: null, granted: null });
    p.kill();
    return;
  }
  // The dialog is quiescent until a key lands; the grid is the state authority.
  const virgin = p.screen();
  const rows = optionRows(virgin);
  cap.frame(p, `${name} — dialog as painted (NO key sent yet)`);
  cap.add(`${name} — option rows (screen order)`, describeRows(rows));

  const log = [];
  const confirmed = await walkToAffirmAndConfirm(p, log);
  cap.add(`${name} — grid-verified walk`, log.join("\n"));
  const granted = confirmed
    ? await p.waitFor(/for shortcuts|Welcome back|Try "|← for agents/i, 30_000)
    : false;
  cap.add(`${name} — reached composer after walk+confirm?`, `${granted} (exited=${p.exited})`);
  matrix.push({
    name,
    note,
    dialog: true,
    rows: rows.map((r) => `${r.focused ? "❯" : " "}${r.role}`),
    defaultRole: rows.find((r) => r.focused)?.role ?? "(none)",
    granted,
  });
  // Keep the virgin grid for the fixture pipeline.
  fs.writeFileSync(path.join(OUT_DIR, `q3-grid-${name}.txt`), virgin);
  p.kill();
  await sleep(500);
}

const plainDir = path.join(ROOT, "plain-fresh");
fs.mkdirSync(plainDir, { recursive: true });
await measureVariant("plain-fresh", plainDir, "empty dir, never seen before");

const gitDir = path.join(ROOT, "git-repo-fresh");
fs.mkdirSync(gitDir, { recursive: true });
execFileSync("git", ["init", "-q", gitDir]);
await measureVariant("git-repo-fresh", gitDir, "fresh `git init` repo");

// A linked worktree: upstream churned worktree trust validation in-range.
const repoDir = path.join(ROOT, "wt-origin");
fs.mkdirSync(repoDir, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
fs.writeFileSync(path.join(repoDir, "seed.txt"), "seed\n");
execFileSync("git", ["-C", repoDir, "add", "seed.txt"]);
execFileSync("git", ["-C", repoDir, "-c", "user.email=probe@example.com", "-c", "user.name=probe", "commit", "-qm", "seed"]);
const worktreeDir = path.join(ROOT, "wt-linked");
execFileSync("git", ["-C", repoDir, "worktree", "add", "-q", "-b", "probe", worktreeDir]);
await measureVariant("git-worktree", worktreeDir, "linked git worktree of a fresh repo");

// Previously DECLINED: answer the default row (No, exit) on the first launch,
// then relaunch the SAME dir and re-measure the dialog it paints.
const declinedDir = path.join(ROOT, "declined-relaunch");
fs.mkdirSync(declinedDir, { recursive: true });
{
  const { p, seen } = await openDialog(declinedDir, "declined-relaunch (first launch)");
  if (seen) {
    cap.add("declined-relaunch (first launch) — rows", describeRows(optionRows(p.screen())));
    await sleep(800); // past the measured input-arming window
    p.write(KEYS.enter); // the DEFAULT row — the decline
    await sleep(2500);
    cap.add(
      "declined-relaunch (first launch) — after bare Enter on the default row",
      `exited=${p.exited} exitInfo=${JSON.stringify(p.exitInfo)}\n--- screen ---\n${p.screen()}`,
    );
  }
  p.kill();
  await sleep(500);
}
await measureVariant("declined-relaunch", declinedDir, "same dir, trust declined on a previous launch");

// A CHILD of the dir trusted by `plain-fresh` earlier in this run.
const childDir = path.join(plainDir, "nested-child");
fs.mkdirSync(childDir, { recursive: true });
await measureVariant("child-of-trusted", childDir, "subdirectory of a dir trusted earlier in this run");

// ── (b) TODAY'S PRODUCTION KEYS on a live 2.1.252 dialog ─────────────────────

// b1 — CSI-u Enter: what the LEGACY hint path (the path 2.1.252 actually takes,
// because the structured parser no longer matches a digit-less option list)
// writes for `approve`.
{
  const csiDir = path.join(ROOT, "prodkey-csiu");
  fs.mkdirSync(csiDir, { recursive: true });
  const { p, seen } = await openDialog(csiDir, "prodkey-csiu");
  if (seen) {
    const before = p.screen();
    await sleep(800); // past the arming window — this is NOT a timing artefact
    p.write(CSI_U_ENTER);
    await sleep(1500);
    const after = p.screen();
    cap.add(
      "prodkey CSI-u Enter (\\x1b[13u) — Sonata's CURRENT approve key at 2.1.252",
      [
        `screen byte-identical after 1.5s: ${before === after}`,
        `exited: ${p.exited} exitInfo=${JSON.stringify(p.exitInfo)}`,
        `rows now:\n${describeRows(optionRows(after))}`,
      ].join("\n"),
    );
  }
  p.kill();
  await sleep(500);
}

// b2 — plain CR: what claudePanelOptionKeys maps trust-approve to (the key the
// v2 path would have written, and the key the ≤2.1.220 dialog affirmed with).
{
  const crDir = path.join(ROOT, "prodkey-cr");
  fs.mkdirSync(crDir, { recursive: true });
  const { p, seen } = await openDialog(crDir, "prodkey-cr");
  if (seen) {
    await sleep(800);
    p.write(KEYS.enter);
    await sleep(2500);
    cap.add(
      "prodkey plain CR (\\r) — claudePanelOptionKeys' trust approve",
      [
        `exited: ${p.exited} exitInfo=${JSON.stringify(p.exitInfo)}`,
        `--- screen ---\n${p.screen()}`,
      ].join("\n"),
    );
  }
  p.kill();
  await sleep(500);
}

// b3 — is a DIGIT still a channel? (2.1.176 rows carried `1.`/`2.`.) Probed on
// an already-trusted dir is impossible, so: fresh dir, walk to affirm first
// (proving input is armed), THEN send a digit and check nothing selected.
{
  const digitDir = path.join(ROOT, "prodkey-digit");
  fs.mkdirSync(digitDir, { recursive: true });
  const { p, seen } = await openDialog(digitDir, "prodkey-digit");
  if (seen) {
    const log = [];
    // Step onto the affirm row WITHOUT confirming, so we know input is armed.
    for (let i = 0; i < 6; i++) {
      const rows = optionRows(p.screen());
      if (rows.find((r) => r.role === "affirm")?.focused) break;
      p.write(KEYS.down);
      await sleep(350);
    }
    const armed = optionRows(p.screen()).find((r) => r.role === "affirm")?.focused === true;
    log.push(`input armed (affirm row focused via Down): ${armed}`);
    const before = p.screen();
    p.write("1");
    await sleep(600);
    log.push(`after digit "1": screen identical=${before === p.screen()} exited=${p.exited}`);
    log.push(`rows:\n${describeRows(optionRows(p.screen()))}`);
    cap.add("prodkey digit channel", log.join("\n"));
    cap.addRaw("prodkey-digit — RAW stream", p.raw);
  }
  p.kill();
  await sleep(500);
}

// ── verdicts ─────────────────────────────────────────────────────────────────
cap.add(
  "VARIANT MATRIX",
  matrix
    .map(
      (m) =>
        `${m.name.padEnd(20)} dialog=${String(m.dialog).padEnd(5)} default=${String(m.defaultRole).padEnd(8)} rows=${JSON.stringify(m.rows)} grantedByWalk=${m.granted}  (${m.note})`,
    )
    .join("\n"),
);
const orders = new Set(matrix.filter((m) => m.dialog).map((m) => JSON.stringify(m.rows)));
cap.add(
  "VERDICT — row order conditional?",
  orders.size <= 1
    ? `NO — every variant that painted a dialog rendered the SAME order/default: ${[...orders][0] ?? "(none)"}`
    : `YES — orders observed: ${[...orders].join(" | ")}`,
);
cap.save();
process.exit(0);
