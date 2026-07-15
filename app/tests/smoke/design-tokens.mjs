import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ════════════════════════════════════════════════════════════════════════
// STANDING FENCE — Design System Migration (S5, 2026-07-15).
//
// After S5, styles.css consumes ONLY the new token architecture. This fence is
// the durable guard the S0 review asked for: the pre-S5 build gates passed
// SILENTLY on a broken alias (a var() resolving to nothing just inherits), so
// the consumed-vs-defined check (A) is the only real protection against a
// dangling token. The four checks:
//
//   (A) every consumed var(--x) has an in-file definition (or is a documented
//       JS-injected token) — catches dangling / typo'd / deleted tokens.
//   (B) zero RETIRED (legacy alias) token names survive — neither consumed nor
//       redefined. The frozen list is the exact pre-S5 alias block (111 names).
//   (C) no font-weight outside 400 / 500 / 600 — the sanctioned scale. The only
//       700 allowances: @font-face (Maple Mono Bold) + the DEV instance badge.
//   (D) no raw hex colour outside the token layer, EXCEPT mask-alpha stencils
//       and rules carrying a `DESIGN-SYSTEM EXCEPTION` marker.
//
// Failures print the offending line numbers LOUDLY.
// ════════════════════════════════════════════════════════════════════════

const STYLES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/renderer/styles.css",
);
const raw = readFileSync(STYLES, "utf8");

// ── Comment-aware view ──────────────────────────────────────────────────
// Blank every /* ... */ span to spaces (preserving newlines + offsets) so that
// retired names, hexes, and weights that appear in PROSE never register as code.
// The raw text is kept for detecting the `DESIGN-SYSTEM EXCEPTION` marker.
function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let j = i; j < stop; j += 1) out += text[j] === "\n" ? "\n" : " ";
      i = stop;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}
const code = stripComments(raw);

// Offset → 1-based line number.
const lineStarts = [0];
for (let i = 0; i < raw.length; i += 1) if (raw[i] === "\n") lineStarts.push(i + 1);
function lineOf(offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const failures = [];
function fail(check, message) {
  failures.push(`[${check}] ${message}`);
}

// ── DOCUMENTED EXCEPTIONS ───────────────────────────────────────────────
// JS-injected custom properties: set at runtime via element.style / :root, so
// they are deliberately NOT defined in the stylesheet. Enumerated honestly from
// the current tree — add here only with a written reason.
//   --depth                 tree-row indentation depth (sidebar / preview tree)
//   --instance-label        DEV badge text, injected when DUET_INSTANCE_LABEL set
//   --usage-ring-dashoffset usage ring stroke offset, injected from usage %
const JS_INJECTED = new Set(["--depth", "--instance-label", "--usage-ring-dashoffset"]);

// The frozen pre-S5 LEGACY ALIAS BLOCK (111 names). Regenerated from
// `git show HEAD:app/src/renderer/styles.css` before deletion. Reading metrics
// (--text-body, --text-code-*, --leading-*, --measure-prose) are NOT here: they
// were promoted to first-class reading tokens, not retired.
const RETIRED = new Set([
  "--accent-soft-border", "--accent-strong", "--approval-badge-bg", "--approval-border",
  "--approval-command-border", "--approval-command-ink", "--approval-command-surface", "--approval-context-bg",
  "--approval-context-border", "--approval-dangerous-bypass-border", "--approval-dangerous-bypass-ink", "--approval-dangerous-bypass-surface",
  "--approval-file-edit-border", "--approval-file-edit-ink", "--approval-file-edit-surface", "--approval-file-read-border",
  "--approval-file-read-ink", "--approval-file-read-surface", "--approval-ink", "--approval-surface",
  "--approval-workspace-trust-border", "--approval-workspace-trust-ink", "--approval-workspace-trust-surface", "--border",
  "--border-attention", "--border-attention-muted", "--border-attention-soft", "--border-complete",
  "--border-complete-metric", "--border-complete-soft", "--border-control", "--border-disabled",
  "--border-footer", "--border-menu", "--border-menu-divider", "--border-raised",
  "--border-soft", "--border-subtle", "--border-waiting", "--border-waiting-action",
  "--border-waiting-quiet", "--code-bg", "--ink", "--ink-blockquote",
  "--ink-disabled", "--ink-disabled-faint", "--ink-disabled-soft", "--ink-faint",
  "--ink-fainter", "--ink-label", "--ink-menu", "--ink-menu-muted",
  "--ink-message", "--ink-meta", "--ink-muted", "--ink-muted-warm",
  "--ink-on-accent", "--ink-pill", "--ink-reading-prompt", "--ink-status",
  "--ink-strong", "--ink-subtle", "--ink-trace", "--ink-ui",
  "--ink-ui-strong", "--ink-work", "--quote-comment-accent", "--shadow-bubble",
  "--shadow-composer", "--shadow-composer-focus", "--shadow-popover", "--status-attention",
  "--status-attention-button", "--status-attention-code", "--status-attention-deep", "--status-attention-ink",
  "--status-attention-label", "--status-attention-strong", "--status-attention-text", "--status-complete",
  "--status-complete-deep", "--status-complete-ink", "--status-complete-label", "--status-complete-link",
  "--status-complete-muted", "--status-complete-strong", "--status-waiting", "--status-waiting-label",
  "--surface", "--surface-attention", "--surface-attention-hover", "--surface-attention-soft",
  "--surface-code-inline", "--surface-complete-active", "--surface-complete-metric", "--surface-complete-soft",
  "--surface-complete-summary", "--surface-control", "--surface-control-soft", "--surface-disabled",
  "--surface-disabled-strong", "--surface-input", "--surface-menu", "--surface-menu-hover",
  "--surface-panel", "--surface-pill", "--surface-strip", "--surface-tool",
  "--surface-waiting-action", "--surface-waiting-quiet", "--surface-white",
]);
assert.equal(RETIRED.size, 111, "frozen retired-name list is intact (111 names)");

// ── Token-layer boundary + EXCEPTION regions (raw text) ─────────────────
const SENTINEL = "END DESIGN TOKEN LAYER";
const sentinelIdx = raw.indexOf(SENTINEL);
assert.notEqual(sentinelIdx, -1, "token-layer sentinel marker is present");
const sentinelLine = lineOf(sentinelIdx);

// Each `DESIGN-SYSTEM EXCEPTION` marker exempts hex/weight from its line through
// the end of the rule it heads (first `}` at/after the marker line).
const rawLines = raw.split("\n");
const exceptionLines = new Set();
for (let i = 0; i < rawLines.length; i += 1) {
  if (rawLines[i].includes("DESIGN-SYSTEM EXCEPTION")) {
    for (let j = i; j < rawLines.length; j += 1) {
      exceptionLines.add(j + 1);
      if (rawLines[j].includes("}")) break;
    }
  }
}

// ── (A) consumed var(--x) must be defined in-file (or JS-injected) ──────
const defined = new Set();
for (const m of code.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
for (const m of code.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
  const name = m[1];
  if (defined.has(name) || JS_INJECTED.has(name)) continue;
  fail("A/undefined-var", `var(${name}) consumed but never defined — line ${lineOf(m.index)}`);
}

// ── (B) no retired alias names survive (consumed OR redefined) ──────────
for (const m of code.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
  if (RETIRED.has(m[1])) fail("B/retired-consumed", `retired token var(${m[1]}) — line ${lineOf(m.index)}`);
}
for (const m of code.matchAll(/(--[a-z0-9-]+)\s*:/g)) {
  if (RETIRED.has(m[1])) fail("B/retired-defined", `retired token ${m[1]} redefined — line ${lineOf(m.index)}`);
}

// ── (C) font-weight ∈ {400,500,600}; 700 only @font-face / EXCEPTION rule ─
// @font-face regions (raw text — the property lives inside the at-rule body).
const fontFaceLines = new Set();
for (const m of raw.matchAll(/@font-face\s*\{/g)) {
  let depth = 0;
  let started = false;
  for (let k = m.index; k < raw.length; k += 1) {
    if (raw[k] === "{") { depth += 1; started = true; }
    else if (raw[k] === "}") depth -= 1;
    fontFaceLines.add(lineOf(k));
    if (started && depth === 0) break;
  }
}
for (const m of code.matchAll(/font-weight:\s*(\d+)/g)) {
  const weight = Number(m[1]);
  const line = lineOf(m.index);
  if (weight === 400 || weight === 500 || weight === 600) continue;
  if (weight === 700 && (fontFaceLines.has(line) || exceptionLines.has(line))) continue;
  fail("C/font-weight", `off-scale font-weight ${weight} — line ${line}`);
}

// ── (D) raw hex outside token layer (mask stencils + EXCEPTION rules OK) ──
for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
  const line = lineOf(m.index);
  if (line <= sentinelLine) continue; // inside the token layer
  if (exceptionLines.has(line)) continue; // DESIGN-SYSTEM EXCEPTION rule
  // Mask-alpha stencil? Find this hex's declaration property (backward scan to
  // the nearest `;`, `{`, or `}` in the comment-stripped code).
  let d = m.index;
  while (d > 0 && !";{}".includes(code[d - 1])) d -= 1;
  const property = code.slice(d, m.index).split(":")[0].trim();
  if (property === "mask" || property === "mask-image" || property === "-webkit-mask-image") continue;
  fail("D/raw-hex", `raw hex ${m[0]} outside token layer — line ${line}`);
}

// ── Verdict ─────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`design-tokens fence FAILED (${failures.length} violation(s)):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

const consumedCount = [...code.matchAll(/var\(\s*--[a-z0-9-]+/g)].length;
console.log(
  `design-tokens: clean — ${consumedCount} var() consumptions, ${defined.size} definitions, ` +
    `0 undefined (${JS_INJECTED.size} JS-injected allowed), 0 retired names, ` +
    `weights ⊆ {400,500,600} (+@font-face/badge 700), no stray hex past line ${sentinelLine}.`,
);
