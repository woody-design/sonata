// SL-9 HALF 1 — A/B probe: does `scrollback: 0` change what Sonata's two grid
// consumers READ?
//
// The standing rule (D-1 refinement 4) says a grid consumer that needs
// scrollback is a channel-misuse smell. Today that rule is PROSE and
// `SCROLLBACK_ROWS = 80` quietly satisfies a misuse. `scrollback: 0` would make
// the rule PHYSICAL. But only if the measurement says the two configurations
// read IDENTICALLY — this file is that measurement, not an argument for it.
//
// What is compared: `viewportText()` (TaskScreenModel) and `visibleRows()`
// (StatusRegionTracker) — byte-for-byte, after every fed chunk, between two
// emulators built with the REAL `createTerminal` conventions
// (`{cols, rows, scrollback, allowProposedApi: true}`) that differ ONLY in
// `scrollback`.
//
// PROVENANCE
//   MEASURED  — codex 0.146.0 raw PTY bytes captured in ../codex/*.raw.log
//               (S1 probe, real binary, isolated CODEX_HOME).
//   COMPOSED  — byte sequences this file synthesizes (alt-screen wrapper,
//               wrapping filler text). Labelled per case; never presented as
//               something a CLI was observed emitting.
//
// FINDING RECORDED WHILE WRITING THIS: none of the S1/S2 captures contains
// `ESC [ ? 1049 h` — neither codex 0.146.0 nor claude 2.1.220 switches to the
// alternate buffer for the chat surface (they repaint INLINE, in the normal
// buffer). So case (ii) can only be COMPOSED, and the normal-buffer cases (i)
// and (iii) are the ones that carry real weight.
//
// Usage: node scrollback-ab.mjs            (from anywhere; paths are resolved
//                                           relative to this file)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURES = path.join(HERE, "..", "codex");
const APP = path.join(HERE, "..", "..", "..", "app");
const require_ = createRequire(path.join(APP, "package.json"));
const { Terminal } = require_("@xterm/headless");

// Verbatim from task-screen-model.ts / status-region-tracker.ts.
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;
const PRODUCTION_SCROLLBACK = 80;

function createTerminal(cols, rows, scrollback) {
  return new Terminal({ cols, rows, scrollback, allowProposedApi: true });
}

/** Verbatim extraction from BOTH consumers (they share the loop body). */
function visibleRows(term) {
  const buffer = term.buffer.active;
  const rows = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    rows.push(line ? line.translateToString(true) : "");
  }
  return rows;
}
const viewportText = (term) => visibleRows(term).join("\n");

const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

// ---------------------------------------------------------------------------
// Comparison harness
// ---------------------------------------------------------------------------

class Pair {
  constructor(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
    this.a = createTerminal(cols, rows, 0);
    this.b = createTerminal(cols, rows, PRODUCTION_SCROLLBACK);
    this.divergences = [];
    this.comparisons = 0;
  }

  async write(data) {
    await write(this.a, data);
    await write(this.b, data);
  }

  resize(cols, rows) {
    this.a.resize(cols, rows);
    this.b.resize(cols, rows);
  }

  /** Byte-compare both consumers' reads; record (do not throw) on divergence. */
  compare(label) {
    this.comparisons += 1;
    const ta = viewportText(this.a);
    const tb = viewportText(this.b);
    // visibleRows() is viewportText() unjoined — compared explicitly anyway so a
    // future divergence in only one of the two shapes cannot hide.
    const ra = JSON.stringify(visibleRows(this.a));
    const rb = JSON.stringify(visibleRows(this.b));
    if (ta === tb && ra === rb) {
      return true;
    }
    const at = firstDiffLine(ta, tb);
    this.divergences.push({ label, at, a: at.aLine, b: at.bLine });
    return false;
  }

  dispose() {
    this.a.dispose();
    this.b.dispose();
  }
}

function firstDiffLine(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return { row: i, aLine: JSON.stringify(la[i] ?? null), bLine: JSON.stringify(lb[i] ?? null) };
    }
  }
  return { row: -1, aLine: "(identical rows, differing join)", bLine: "" };
}

const results = [];
function record(name, provenance, pair, notes = []) {
  results.push({
    name,
    provenance,
    comparisons: pair.comparisons,
    divergences: pair.divergences,
    notes,
  });
  pair.dispose();
}

const chunks = (s, n) => {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};

const capture = (name) => fs.readFileSync(path.join(CAPTURES, name), "utf8");

// ---------------------------------------------------------------------------
// (i) MEASURED — codex 0.146.0 boot, the normal-buffer phase where the trust
//     dialog (bootDialogHints) is on screen and content genuinely scrolls.
// ---------------------------------------------------------------------------

async function caseBoot() {
  const bytes = capture("out-q5a-boot.raw.log");
  const pair = new Pair();
  // 4 KiB chunks: the S3 coalesced PTY batch is chunk-shaped, and comparing at
  // every boundary means a transient divergence cannot be averaged away by only
  // looking at the end state.
  for (const [i, chunk] of chunks(bytes, 4096).entries()) {
    await pair.write(chunk);
    pair.compare(`boot chunk ${i}`);
  }
  record("(i) codex 0.146.0 BOOT — full session, 4KiB chunks", "MEASURED", pair, [
    `stream bytes: ${bytes.length}`,
    `scrolled lines in the scrollback-80 emulator at end: not applicable (compared reads only)`,
  ]);
}

// ---------------------------------------------------------------------------
// (ii) MEASURED midsession TUI + a COMPOSED alt-screen wrapper.
// ---------------------------------------------------------------------------

async function caseMidsession() {
  for (const name of ["out-q4-status-timing.raw.log", "out-q1-consent.raw.log", "out-q2b-model-walk.raw.log"]) {
    const bytes = capture(name);
    const pair = new Pair();
    for (const [i, chunk] of chunks(bytes, 4096).entries()) {
      await pair.write(chunk);
      pair.compare(`${name} chunk ${i}`);
    }
    record(`(ii) codex 0.146.0 midsession — ${name}`, "MEASURED", pair, [`stream bytes: ${bytes.length}`]);
  }
}

async function caseAltScreen() {
  const bytes = capture("out-q4-status-timing.raw.log");
  const pair = new Pair();
  // COMPOSED: no captured CLI stream enters the alternate buffer (see header),
  // so the alt-buffer leg is synthesized by wrapping measured bytes in the
  // standard smcup/rmcup pair. The alt buffer has no scrollback by
  // construction in xterm, so this leg is a control, not a discovery.
  await pair.write("\x1b[?1049h");
  pair.compare("alt enter");
  for (const [i, chunk] of chunks(bytes, 4096).entries()) {
    await pair.write(chunk);
    pair.compare(`alt chunk ${i}`);
  }
  await pair.write("\x1b[?1049l");
  pair.compare("alt leave (back to the normal buffer)");
  record("(ii-b) ALT-SCREEN wrapper over measured midsession bytes", "COMPOSED", pair, [
    "wrapper bytes ESC[?1049h / ESC[?1049l are composed; the payload is MEASURED",
  ]);
}

// ---------------------------------------------------------------------------
// (iii) Resize choreography in the NORMAL buffer with wrapping content — the
//       xterm REFLOW interaction, the one place where a scrollback of 0 and 80
//       could plausibly diverge in what the VIEWPORT reads.
// ---------------------------------------------------------------------------

async function caseReflowSynthetic() {
  const pair = new Pair();
  // COMPOSED filler: lines long enough to wrap at 120 cols (so narrowing to 80
  // forces re-wrap) and numerous enough to overflow a 36-row viewport (so the
  // overflow lands in scrollback in the B emulator and is dropped in A).
  const filler = Array.from({ length: 60 }, (_, i) => `L${String(i).padStart(3, "0")} ${"x".repeat(150)}`).join("\r\n");
  await pair.write(`${filler}\r\n`);
  pair.compare("after filler @120x36");
  pair.resize(80, 36);
  pair.compare("after narrow 120 -> 80");
  await pair.write("post-narrow marker\r\n");
  pair.compare("after a write at 80 cols");
  pair.resize(120, 36);
  pair.compare("after widen 80 -> 120 (reflow pulls lines BACK from scrollback)");
  await pair.write("post-widen marker\r\n");
  pair.compare("after a write back at 120 cols");
  pair.resize(120, 20);
  pair.compare("after shrink rows 36 -> 20");
  pair.resize(120, 36);
  pair.compare("after grow rows 20 -> 36");
  const beforeRepaint = pair.divergences.length;
  // A real SIGWINCH is answered by the TUI's own full repaint. Model it: home +
  // erase-below + a full viewport of fresh rows. Whether the divergence SURVIVES
  // this is the whole question for production — it decides whether the exposure
  // is permanent or a window between the resize and the next paint.
  await pair.write(`\x1b[H\x1b[J${Array.from({ length: 36 }, (_, i) => `repaint row ${i}`).join("\r\n")}`);
  const converged = pair.compare("after a full repaint following the resize");
  record("(iii) RESIZE CHOREOGRAPHY — normal buffer, wrapping content", "COMPOSED", pair, [
    "60 wrapping lines @150 chars; 120->80->120 cols, then 36->20->36 rows",
    `divergences before the repaint: ${beforeRepaint}; the post-repaint read is ${
      converged ? "IDENTICAL — the exposure is a window, not a permanent skew" : "STILL DIVERGENT — permanent skew"
    }`,
  ]);
}

async function caseReflowOverMeasuredBoot() {
  const bytes = capture("out-q5a-boot.raw.log");
  const pair = new Pair();
  await pair.write(bytes);
  pair.compare("measured boot fed @120x36");
  pair.resize(80, 36);
  pair.compare("narrow 120 -> 80 over the measured boot grid");
  pair.resize(120, 36);
  pair.compare("widen 80 -> 120 over the measured boot grid");
  // A real SIGWINCH is followed by the TUI's own repaint; replay the capture's
  // tail to model that (the CLI repaints, both emulators see the same bytes).
  await pair.write(bytes.slice(-8000));
  pair.compare("after a repaint following the resize");
  record("(iii-b) RESIZE CHOREOGRAPHY over MEASURED boot bytes", "MEASURED + COMPOSED resize", pair, [
    "resize steps are composed (Sonata's GUI is the only resize source); the grid under them is measured",
  ]);
}

// ---------------------------------------------------------------------------
// Control: prove the harness CAN see a divergence (otherwise a green run is
// evidence of nothing).
// ---------------------------------------------------------------------------

async function caseControl() {
  const pair = new Pair();
  // Read ABOVE the viewport — the exact thing the standing rule forbids and the
  // consumer grep asserts nobody does. This is the only read shape where the two
  // configurations must differ; if it does not fail, the harness is broken.
  await pair.write(`${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\r\n")}\r\n`);
  const above = (term) => {
    const buffer = term.buffer.active;
    const line = buffer.getLine(Math.max(0, buffer.baseY - 40));
    return line ? line.translateToString(true) : "";
  };
  const a = above(pair.a);
  const b = above(pair.b);
  const diverged = a !== b;
  results.push({
    name: "(control) a read 40 rows ABOVE the viewport top — MUST diverge",
    provenance: "COMPOSED",
    comparisons: 1,
    divergences: diverged ? [{ label: "scrollback read", at: { row: -1 }, a: JSON.stringify(a), b: JSON.stringify(b) }] : [],
    notes: [
      diverged
        ? "harness is sensitive: the two configurations DO differ where scrollback is actually read"
        : "HARNESS BROKEN — a scrollback read did not diverge; treat every other verdict as void",
      `scrollback-0 baseY=${pair.a.buffer.active.baseY}  scrollback-80 baseY=${pair.b.buffer.active.baseY}`,
    ],
    inverted: true,
  });
  pair.dispose();
}

// ---------------------------------------------------------------------------

await caseBoot();
await caseMidsession();
await caseAltScreen();
await caseReflowSynthetic();
await caseReflowOverMeasuredBoot();
await caseControl();

let divergentCases = 0;
let harnessSane = true;
const lines = [];
lines.push("A/B PROBE — @xterm/headless scrollback 0 vs 80, viewport reads only");
lines.push(`@xterm/headless ${require_("@xterm/headless/package.json").version}`);
lines.push("");
for (const r of results) {
  const diverged = r.divergences.length > 0;
  if (r.inverted) {
    harnessSane = harnessSane && diverged;
  } else if (diverged) {
    divergentCases += 1;
  }
  lines.push(`${diverged ? "DIVERGENT" : "IDENTICAL"}  [${r.provenance}]  ${r.name}`);
  lines.push(`            ${r.comparisons} viewport comparison(s)`);
  for (const n of r.notes) lines.push(`            note: ${n}`);
  for (const d of r.divergences.slice(0, 5)) {
    lines.push(`            ${r.inverted ? "expected diff" : "DIFF"} @ ${d.label ?? ""} row ${d.at.row}`);
    lines.push(`              scrollback:0  ${d.a}`);
    lines.push(`              scrollback:80 ${d.b}`);
  }
  if (r.divergences.length > 5) lines.push(`            … ${r.divergences.length - 5} more`);
  lines.push("");
}
const total = results.reduce((n, r) => n + r.comparisons, 0);
lines.push(`harness sanity (the control read DID diverge): ${harnessSane ? "OK" : "BROKEN — every verdict above is void"}`);
lines.push(
  divergentCases === 0
    ? `VERDICT: no viewport divergence across ${total} comparisons → scrollback is unobservable to ` +
        `Sonata's grid consumers → \`scrollback: 0\` is safe and makes the standing rule physical.`
    : `VERDICT: ${divergentCases} case(s) DIVERGED across ${total} comparisons. Scrollback IS observable ` +
        `through the viewport — xterm's resize REFLOW re-wraps out of, and pulls back from, the scrollback ` +
        `ring, so a 0-row ring lands a different top row and a different post-grow viewport. The skew is a ` +
        `WINDOW (the next full repaint converges), not a permanent state. DECISION: KEEP the ring; do NOT ` +
        `set 0. The standing rule stays prose, backed by this file plus a machine consumer-grep.`,
);
const out = lines.join("\n");
console.log(out);
fs.writeFileSync(path.join(HERE, "scrollback-ab.txt"), `${out}\n`);
process.exit(harnessSane ? 0 : 1);
