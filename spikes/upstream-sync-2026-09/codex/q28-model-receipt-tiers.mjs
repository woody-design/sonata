// Q28 (2026-09 sync, SL-7) — the `• Model changed to <slug> <effort>` receipt
// across ALL SIX effort tiers at 0.152.1, plus the Ultra composer glyph, the
// Ultra/Max footer, and the 0.152 rate-limit banners that now share that region.
//
// WHY ALL SIX AND NOT THE FOUR SONATA DRIVES. The split is deliberate and this
// probe exists to keep it honest: `asCodexReasoningTarget` fences what Sonata
// may ASK FOR (low/medium/high/xhigh — `More reasoning…` is never entered), while
// `parseCodexModelReceipt` must read what codex ACTUALLY APPLIED, including a
// tier a human reached natively in the co-visible Terminal. At 0.146.0 an Ultra
// confirm printed `• Model changed to <slug> ultra for this conversation` and the
// then-four-token alternation read it as NULL, which made a landed switch time
// out and roll back through a picker that was already closed. That is why the
// alternation spans six — and a standing re-verify (F8) is the only thing that
// keeps "spans six" from decaying into a claim.
//
// FOUR MEASUREMENTS:
//   TIERS   — walk the level-2 ladder and confirm each row, reading the receipt
//             off the STREAM delta of that press alone (not the rolling tail),
//             so a receipt is attributed to the switch that produced it rather
//             than to a repaint of an older one (the F19 lesson, claude side).
//   DEPTH-3 — `More reasoning…` is a row Sonata refuses to enter, so what lies
//             behind it has never been measured. Max and Ultra are reached
//             through it; this probe enters it ONCE, catalogues it, and records
//             whether it is a third picker level (which would make the
//             two-Esc rollback bound `CODEX_MODEL_MAX_ROLLBACK_ESCS` a
//             three-deep question).
//   GLYPH   — after an Ultra confirm, does the composer still paint `»`
//             (U+00BB)? `composerPromptGlyphs` carries it, and since SL-6 that
//             list is LOAD-BEARING for the boot latch (C14): without the glyph
//             the last prompt found in an Ultra tail is a stale `›` sitting
//             BEFORE the run's activity text, and readiness goes permanently
//             false. So this is a red-line re-verify, not a cosmetic one.
//   FOOTER  — the idle footer `<model> <effort> · <cwd>` shape at every tier,
//             and what the 0.152 rate-limit / usage banners do to that region.
//             `idlePromptModelHints` is matched against the tail AFTER the
//             prompt glyph; a banner that displaces the footer would starve it.
//
// A MODEL switch is taken too (one hop and back), because the footer's shape
// across a model change is objective 5's other half and because the level-2
// `(current)` marker's behaviour after a model change is what `preserveEffort`
// exists to work around.
//
// No turn is ever submitted. Selecting a tier costs nothing until a turn runs;
// the session is restored to its spawn state (gpt-5.6-sol / high) at the end.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CodexBoot,
  EXPECT_CODEX_VERSION,
  assertCodexVersion,
  codexVersion,
  compact,
  runtime,
  sanitize,
  sleep,
  writeCapture,
} from "./driver.mjs";

const {
  codexModelPickerFooterVisible,
  codexModelPickerLevel1Open,
  codexModelPickerLevel2Open,
  detectIdlePromptForProvider,
  parseCodexModelLevel1,
  parseCodexModelLevel2,
  parseCodexModelReceipt,
} = runtime;

const OUT_DIR = new URL(".", import.meta.url).pathname;
const ROOT = "/private/tmp/sonata-sync-2026-09/codex-receipt-tiers";
const COLS = 120;
const ROWS = 40;
const BOOT_BUDGET_MS = 90_000;
const ESC = "\x1b";
const CR = "\r";
const ARROW_DOWN = "\x1b[B";
const ARROW_UP = "\x1b[A";
const KILL_LINE = "\x15".repeat(40);
const MODEL_LINE_LOADING_RE = /model:\s+loading/;
/** The spawn state, restored at the end so a re-run starts where this one did. */
const HOME_MODEL = "gpt-5.6-sol";
const HOME_EFFORT = "high";

const startVersion = assertCodexVersion("q28 start");

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
const workspace = path.join(ROOT, "cwd");
const runtimeDir = path.join(ROOT, "runtime");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(runtimeDir, { recursive: true });

const realCodexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
const realProfilePath = path.join(realCodexHome, "sonata.config.toml");
const profileBackup = fs.existsSync(realProfilePath)
  ? fs.readFileSync(realProfilePath, "utf8")
  : null;

const out = {
  probe: "q28-model-receipt-tiers",
  version: startVersion,
  endVersion: null,
  versionDrift: null,
  steps: [],
};

const boot = new CodexBoot({
  taskId: "task-q28",
  cwd: workspace,
  runtimeDir,
  binDir: path.join(os.homedir(), ".sonata", "bin"),
  pretrustCwd: workspace,
  rows: ROWS,
  cols: COLS,
  approvalBroker: true,
});

try {
  await boot.start();
  out.readyAtMs = await boot.waitUntil((b) => b.ready(), BOOT_BUDGET_MS);
  if (out.readyAtMs === null) {
    out.fatal = "composer never accepted input inside the boot budget";
    out.bootScreen = boot.screen();
  } else {
    out.handshakeAtMs = await boot.waitUntil(
      (b) => !MODEL_LINE_LOADING_RE.test(b.screen()),
      30_000,
      100,
    );
    await sleep(600);
    out.idleAtSpawn = footerSnapshot(boot, "at-spawn");

    // ── the four tiers Sonata itself drives, in ladder order ────────────────
    for (const tier of ["low", "medium", "xhigh", "high"]) {
      out.steps.push(await switchEffort(boot, tier));
    }

    // ── the two behind `More reasoning…` ────────────────────────────────────
    out.steps.push(await enterMoreReasoning(boot));
    out.steps.push(await switchDeepTier(boot, "max"));
    out.steps.push(await switchDeepTier(boot, "ultra"));
    // The glyph/footer question is only interesting WHILE Ultra is the tier.
    out.ultraIdle = footerSnapshot(boot, "while-ultra");

    // ── a model hop, at Ultra, then home ────────────────────────────────────
    out.steps.push(await switchModel(boot, "gpt-5.6-luna"));
    out.afterModelHop = footerSnapshot(boot, "after-model-hop");
    out.steps.push(await switchModel(boot, HOME_MODEL));
    out.steps.push(await switchEffort(boot, HOME_EFFORT));
    out.idleRestored = footerSnapshot(boot, "restored");
  }
} catch (error) {
  out.fatal = `${error instanceof Error ? error.stack : String(error)}`;
} finally {
  boot.dispose();
  if (profileBackup !== null) fs.writeFileSync(realProfilePath, profileBackup);
  await sleep(400);
}

out.endVersion = codexVersion();
out.versionDrift = out.endVersion.includes(EXPECT_CODEX_VERSION)
  ? null
  : `drifted off ${EXPECT_CODEX_VERSION}: start=${out.version} end=${out.endVersion}`;

const capturePath = writeCapture(OUT_DIR, "q28-model-receipt-tiers.capture.txt", out);
console.log(sanitize(summarize(out)));
console.log(`\ncapture: ${capturePath}`);
if (out.versionDrift) {
  console.error(`VERSION DRIFT: ${out.versionDrift}`);
  process.exitCode = 2;
}
if (out.fatal) {
  console.error(`FATAL: ${out.fatal}`);
  process.exitCode = 1;
}

// ── steps ───────────────────────────────────────────────────────────────────

/** Open `/model`, confirm the CURRENT model at level 1, walk level 2 to `tier`,
 *  confirm, and read the receipt off THIS press's stream delta. */
async function switchEffort(boot, tier) {
  const step = { step: `effort-${tier}`, tier };
  await openPicker(boot);
  const l1 = parseCodexModelLevel1(boot.screen());
  step.l1Cursor = l1.cursor;
  step.l1Current = l1.current;
  boot.host.writeRaw(CR);
  await boot.waitUntil((b) => codexModelPickerLevel2Open(b.raw), 6000, 60);
  await sleep(500);

  const l2 = parseCodexModelLevel2(boot.screen());
  step.l2Before = { cursor: l2.cursor, current: l2.current, order: Object.fromEntries(l2.order) };
  step.walk = await walkLevel2(boot, tier);
  const before = boot.raw.length;
  boot.host.writeRaw(CR);
  await sleep(2000);
  recordReceipt(step, boot, before);
  step.footer = footerSnapshot(boot, `after-${tier}`);
  return step;
}

/** Enter the `More reasoning…` row and catalogue whatever it opens. This is the
 *  ONE place Sonata's own choreography refuses to go (D6), so the shape behind
 *  it is otherwise unmeasured. Ends by Escing back out. */
async function enterMoreReasoning(boot) {
  const step = { step: "more-reasoning-submenu" };
  await openPicker(boot);
  boot.host.writeRaw(CR);
  await boot.waitUntil((b) => codexModelPickerLevel2Open(b.raw), 6000, 60);
  await sleep(500);
  step.walk = await walkLevel2(boot, "more");
  boot.host.writeRaw(CR);
  await sleep(1500);
  const screen = boot.screen();
  step.gridLines = screen.split("\n").filter((l) => l.trim());
  step.compact = compact(screen).slice(-500);
  // Does the LEVEL-2 parser still recognise this screen? If the submenu reuses
  // the reasoning-row grammar, an accidental entry would look navigable.
  const l2 = parseCodexModelLevel2(screen);
  step.parsedAsLevel2 = { cursor: l2.cursor, current: l2.current, order: Object.fromEntries(l2.order) };
  step.level2HeaderStillOpen = codexModelPickerLevel2Open(screen);
  step.level1HeaderOpen = codexModelPickerLevel1Open(screen);
  step.footerVisible = codexModelPickerFooterVisible(screen);
  // Back out, all the way to a composer, counting the Escs it takes — that count
  // is what `CODEX_MODEL_MAX_ROLLBACK_ESCS` (3) would have to cover.
  step.escsToComposer = await escToComposer(boot, 5);
  return step;
}

/** Reach `max` / `ultra`, which live behind `More reasoning…`. */
async function switchDeepTier(boot, tier) {
  const step = { step: `effort-${tier}`, tier, deep: true };
  await openPicker(boot);
  boot.host.writeRaw(CR);
  await boot.waitUntil((b) => codexModelPickerLevel2Open(b.raw), 6000, 60);
  await sleep(500);
  step.walk = await walkLevel2(boot, "more");
  boot.host.writeRaw(CR);
  await sleep(1400);
  step.submenuLines = boot.screen().split("\n").filter((l) => l.trim()).slice(-8);
  step.submenuWalk = await walkSubmenuByLabel(boot, tier);
  const before = boot.raw.length;
  boot.host.writeRaw(CR);
  await sleep(2200);
  recordReceipt(step, boot, before);
  step.footer = footerSnapshot(boot, `after-${tier}`);
  return step;
}

/** Switch the MODEL (level 1), preserving whatever level 2 offers by confirming
 *  its cursor row — the shape objective 5 asks about. */
async function switchModel(boot, model) {
  const step = { step: `model-${model}`, model };
  await openPicker(boot);
  step.walk = await walkLevel1(boot, model);
  boot.host.writeRaw(CR);
  await boot.waitUntil((b) => codexModelPickerLevel2Open(b.raw, model), 6000, 60);
  await sleep(600);
  const l2 = parseCodexModelLevel2(boot.screen());
  // The S4 note says codex DROPS the level-2 `(current)` marker after a model
  // change, which is exactly why `preserveEffort` is passed explicitly. Record
  // whether that still holds.
  step.l2AfterModelChange = {
    cursor: l2.cursor,
    current: l2.current,
    order: Object.fromEntries(l2.order),
    lines: boot.screen().split("\n").filter((l) => l.trim()).slice(-8),
  };
  const before = boot.raw.length;
  boot.host.writeRaw(CR);
  await sleep(2200);
  recordReceipt(step, boot, before);
  step.footer = footerSnapshot(boot, `after-${model}`);
  return step;
}

// ── plumbing ────────────────────────────────────────────────────────────────

async function openPicker(boot) {
  boot.host.writeRaw(KILL_LINE);
  await sleep(200);
  boot.host.writeRaw("/model");
  await sleep(150);
  boot.host.writeRaw(CR);
  await boot.waitUntil((b) => codexModelPickerLevel1Open(b.raw), 8000, 60);
  await boot.waitUntil((b) => codexModelPickerFooterVisible(b.raw), 4000, 60);
  await sleep(400);
}

async function walkLevel1(boot, target) {
  const presses = [];
  for (let i = 0; i < 8; i += 1) {
    const level = parseCodexModelLevel1(boot.screen());
    if (level.cursor === target) return { presses, landedOn: level.cursor };
    const from = level.order.get(level.cursor ?? "");
    const to = level.order.get(target);
    if (from === undefined || to === undefined) {
      return { presses, landedOn: level.cursor, failed: `unresolved ${level.cursor} → ${target}` };
    }
    boot.host.writeRaw(to > from ? ARROW_DOWN : ARROW_UP);
    await sleep(350);
    presses.push({ from: level.cursor, after: parseCodexModelLevel1(boot.screen()).cursor });
  }
  return { presses, landedOn: parseCodexModelLevel1(boot.screen()).cursor, failed: "bound hit" };
}

async function walkLevel2(boot, target) {
  const presses = [];
  for (let i = 0; i < 8; i += 1) {
    const level = parseCodexModelLevel2(boot.screen());
    if (level.cursor === target) return { presses, landedOn: level.cursor };
    const from = level.order.get(level.cursor ?? "");
    const to = level.order.get(target);
    if (from === undefined || to === undefined) {
      return { presses, landedOn: level.cursor, failed: `unresolved ${level.cursor} → ${target}` };
    }
    boot.host.writeRaw(to > from ? ARROW_DOWN : ARROW_UP);
    await sleep(350);
    presses.push({ from: level.cursor, after: parseCodexModelLevel2(boot.screen()).cursor });
  }
  return { presses, landedOn: parseCodexModelLevel2(boot.screen()).cursor, failed: "bound hit" };
}

/** The `More reasoning…` submenu has no production parser (Sonata never enters
 *  it), so navigation there is by raw screen text: find the `›`-marked row and
 *  arrow until the target LABEL carries the cursor. */
async function walkSubmenuByLabel(boot, label) {
  const presses = [];
  const cursorRowOf = (screen) => {
    const line = screen.split("\n").find((l) => /^\s*›\s*\d+\./.test(l));
    return line ? line.trim() : null;
  };
  const rowsOf = (screen) =>
    screen
      .split("\n")
      .filter((l) => /^\s*›?\s*\d+\.\s+\S/.test(l))
      .map((l) => l.trim());
  const wanted = new RegExp(`\\d+\\.\\s*${label}`, "i");
  for (let i = 0; i < 6; i += 1) {
    const screen = boot.screen();
    const cursorRow = cursorRowOf(screen);
    if (cursorRow && wanted.test(cursorRow)) {
      return { presses, landedOn: cursorRow, rows: rowsOf(screen) };
    }
    const rows = rowsOf(screen);
    const cursorIndex = rows.findIndex((r) => r.startsWith("›"));
    const targetIndex = rows.findIndex((r) => wanted.test(r));
    if (cursorIndex < 0 || targetIndex < 0) {
      return { presses, landedOn: cursorRow, rows, failed: "row not found" };
    }
    boot.host.writeRaw(targetIndex > cursorIndex ? ARROW_DOWN : ARROW_UP);
    await sleep(350);
    presses.push({ from: cursorRow, after: cursorRowOf(boot.screen()) });
  }
  return { presses, landedOn: cursorRowOf(boot.screen()), failed: "bound hit" };
}

async function escToComposer(boot, max) {
  let count = 0;
  for (let i = 0; i < max; i += 1) {
    boot.host.writeRaw(ESC);
    count += 1;
    await sleep(600);
    if (!codexModelPickerFooterVisible(boot.screen())) break;
  }
  return { escs: count, composerBack: boot.ready() };
}

/** Read the receipt off THIS press's bytes AND off the rolling tail, and keep
 *  both. A disagreement is the repaint-replay hazard showing itself. */
function recordReceipt(step, boot, rawLenBefore) {
  const newBytes = boot.raw.slice(rawLenBefore);
  step.receiptFromPress = parseCodexModelReceipt(newBytes);
  step.receiptFromTail = parseCodexModelReceipt(boot.raw);
  step.receiptVerbatim = cleanLines(newBytes).filter((l) => l.includes("Model changed to"));
  step.newBytesCompact = compact(newBytes).slice(0, 400);
  step.pickerClosed = !codexModelPickerFooterVisible(boot.screen());
}

/** The idle composer region: glyph, footer line, and the production idle scrape
 *  on both channels. The banner question is answered by keeping the last rows
 *  verbatim. */
function footerSnapshot(boot, label) {
  const screen = boot.screen();
  const lines = screen.split("\n").filter((l) => l.trim());
  return {
    label,
    atMs: boot.at(),
    tailLines: lines.slice(-6),
    glyphsOnScreen: [">", "›", "❯", "»"].filter((g) => screen.includes(g)),
    composerGlyph: (lines.slice(-6).find((l) => /^[›»❯>]\s/.test(l.trim())) ?? "").trim().slice(0, 2),
    idleScrapeGrid: detectIdlePromptForProvider(screen, "codex"),
    idleScrapeStream: detectIdlePromptForProvider(boot.raw, "codex"),
    acceptsPromptInput: boot.ready(),
  };
}

function cleanLines(raw) {
  return raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function summarize(out) {
  const lines = [`q28 receipt tiers — codex ${out.version}`];
  if (out.fatal) lines.push(`FATAL: ${out.fatal}`);
  lines.push(`ready=${out.readyAtMs}ms handshake=${out.handshakeAtMs}ms`);
  for (const snap of [out.idleAtSpawn, out.ultraIdle, out.afterModelHop, out.idleRestored]) {
    if (!snap) continue;
    lines.push(`\nFOOTER [${snap.label}] glyph=${JSON.stringify(snap.composerGlyph)} glyphsOnScreen=${JSON.stringify(snap.glyphsOnScreen)} ready=${snap.acceptsPromptInput}`);
    lines.push(`  idleScrape grid=${JSON.stringify(snap.idleScrapeGrid)} stream=${JSON.stringify(snap.idleScrapeStream)}`);
    for (const l of snap.tailLines) lines.push(`  | ${l}`);
  }
  for (const step of out.steps) {
    lines.push(`\n── ${step.step}`);
    if (step.walk) lines.push(`  walk landedOn=${step.walk.landedOn} failed=${step.walk.failed ?? "no"} presses=${step.walk.presses.length}`);
    if (step.l2Before) lines.push(`  l2 before: cursor=${step.l2Before.cursor} current=${step.l2Before.current} order=${JSON.stringify(step.l2Before.order)}`);
    if (step.submenuWalk) {
      lines.push(`  submenu rows: ${JSON.stringify(step.submenuWalk.rows)}`);
      lines.push(`  submenu landedOn=${JSON.stringify(step.submenuWalk.landedOn)} failed=${step.submenuWalk.failed ?? "no"}`);
    }
    if (step.gridLines) {
      lines.push(`  parsedAsLevel2=${JSON.stringify(step.parsedAsLevel2)} l2Header=${step.level2HeaderStillOpen} l1Header=${step.level1HeaderOpen} footer=${step.footerVisible}`);
      for (const l of step.gridLines) lines.push(`    | ${l}`);
      lines.push(`  escsToComposer=${JSON.stringify(step.escsToComposer)}`);
    }
    if (step.l2AfterModelChange) {
      lines.push(`  l2 AFTER model change: cursor=${step.l2AfterModelChange.cursor} current=${step.l2AfterModelChange.current} order=${JSON.stringify(step.l2AfterModelChange.order)}`);
      for (const l of step.l2AfterModelChange.lines) lines.push(`    | ${l}`);
    }
    if (step.receiptFromPress !== undefined) {
      lines.push(`  RECEIPT press=${JSON.stringify(step.receiptFromPress)} tail=${JSON.stringify(step.receiptFromTail)} pickerClosed=${step.pickerClosed}`);
      for (const l of step.receiptVerbatim) lines.push(`    verbatim | ${l}`);
      if (!step.receiptVerbatim.length) lines.push(`    bytes | ${step.newBytesCompact}`);
    }
    if (step.footer) {
      lines.push(`  footer glyph=${JSON.stringify(step.footer.composerGlyph)} ready=${step.footer.acceptsPromptInput}`);
      for (const l of step.footer.tailLines.slice(-3)) lines.push(`    | ${l}`);
    }
  }
  return lines.join("\n");
}
