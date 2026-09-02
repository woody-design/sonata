#!/usr/bin/env node
// r7 — does a PAGINATED rollout still carry visible reasoning summaries on the
// `response_item` record the normalizer reads? (SL-8 review round 1, item 1.)
//
// WHY THIS EXISTS. r3/r6 measured only TWO `Reasoning` items in the whole
// paginated corpus and BOTH were empty (`summary_text: []`), because every
// session that produced them ran with `reasoning summaries: none`. So the
// anti-double-emit drop of `item_completed/Reasoning` rested on zero positive
// evidence: if 0.147+ had moved visible summaries onto `item.summary_text` /
// `item.raw_content` (both fields exist, neither has a reader), paginated
// transcripts would silently lose EVERY thinking block — the same blank-surface
// class this slice fixed — and the smoke fence could not catch it, because that
// fence constructs its own legacy-shaped mirror.
//
// r7 forces a visible summary with `-c model_reasoning_summary="detailed"` and
// reports, from the resulting real rollout:
//   * the `response_item/reasoning` record and its `summary[]`
//   * the `event_msg/item_completed` `Reasoning` item and its `summary_text[]`
//   * whether the two share an `id` (i.e. are genuinely the same item mirrored)
//   * what the BUILT normalizer emits for the whole file
//
// Usage: node r7-paginated-reasoning-drive.mjs [--out <file>]

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const { CodexRolloutNormalizer } = require(
  path.resolve(here, "../../../app/dist/runtime/provider-transcript/index"),
);

const args = process.argv.slice(2);
const argOf = (n, f) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : f;
};
const OUT = argOf("--out", null);
const EXPECT = argOf("--expect", "0.152.0");
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const CWD = "/private/tmp/sonata-sync-2026-09/r7-reasoning";

const lines = [];
const say = (s = "") => {
  lines.push(s);
  console.log(s);
};
const HOME = os.homedir();
const USER = path.basename(HOME);
const sanitize = (s) =>
  String(s).split(HOME).join("~").split(`-Users-${USER}-`).join("-Users-USER-").split(`/Users/${USER}`).join("~");

let measuredVersion = "UNKNOWN";
try {
  measuredVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
} catch (e) {
  measuredVersion = `ERROR: ${e.message}`;
}
const drift = !measuredVersion.includes(EXPECT);

say("# r7 — paginated reasoning-summary drive");
say(`codex --version : ${measuredVersion}`);
say(`expected        : ${EXPECT}${drift ? "   *** DRIFT — capture retained ***" : ""}`);
say(`captured at     : ${new Date().toISOString()}`);
say();

fs.mkdirSync(CWD, { recursive: true });
const startedAt = Date.now();
const argv = [
  "exec",
  "--skip-git-repo-check",
  "-C",
  CWD,
  "-c",
  'model_reasoning_summary="detailed"',
  "Think step by step about why 1729 is the smallest number expressible as the sum of two positive cubes in two different ways, then reply with just the two pairs.",
];
say(`spawn: codex ${argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
const run = spawnSync("codex", argv, { encoding: "utf8", timeout: 600_000 });
say(`exit  : ${run.status}`);
const header = (run.stdout ?? "").split("\n").find((l) => l.includes("reasoning summaries"));
say(`header: ${header?.trim() ?? "(not found)"}`);
say();

// Locate the rollout this run wrote.
const now = new Date();
const dir = path.join(
  CODEX_HOME,
  "sessions",
  String(now.getFullYear()),
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
);
let file = null;
for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  if (!entry.endsWith(".jsonl")) continue;
  const p = path.join(dir, entry);
  if (fs.statSync(p).mtimeMs < startedAt - 20_000) continue;
  try {
    const head = JSON.parse(fs.readFileSync(p, "utf8").split("\n", 1)[0]);
    if (head?.type === "session_meta" && head.payload?.cwd === CWD) file = p;
  } catch {
    /* not ours */
  }
}
if (!file) {
  say("rollout: NOT FOUND — nothing to measure");
  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n");
  process.exit(1);
}
say(`rollout: ${sanitize(file)}`);

let historyMode = null;
const responseReasoning = [];
const itemReasoning = [];
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  const p = r.payload ?? {};
  if (r.type === "session_meta") historyMode = p.history_mode ?? null;
  if (r.type === "response_item" && p.type === "reasoning") responseReasoning.push(p);
  const item = p.item;
  if (r.type === "event_msg" && item && typeof item === "object" && item.type === "Reasoning") itemReasoning.push(item);
}
say(`history_mode: ${historyMode}`);
say();

const summaryTextOf = (summary) =>
  Array.isArray(summary)
    ? summary.map((s) => (typeof s === "string" ? s : (s && s.text) || "")).filter(Boolean)
    : [];

say("## response_item / reasoning  (the record the normalizer READS)");
for (const p of responseReasoning) {
  say(`  id            : ${p.id}`);
  say(`  summary[]     : ${JSON.stringify(summaryTextOf(p.summary))}`);
  say(`  summary shape : ${JSON.stringify(Array.isArray(p.summary) ? p.summary.map((s) => s && s.type) : p.summary)}`);
  say(`  encrypted_content: ${typeof p.encrypted_content === "string" ? `${p.encrypted_content.length} chars` : "(absent)"}`);
}
if (!responseReasoning.length) say("  (none)");
say();

say("## event_msg / item_completed / Reasoning  (the mirror the normalizer DROPS)");
for (const item of itemReasoning) {
  say(`  id            : ${item.id}`);
  say(`  summary_text[]: ${JSON.stringify(item.summary_text)}`);
  say(`  raw_content[] : ${JSON.stringify(item.raw_content)}`);
}
if (!itemReasoning.length) say("  (none)");
say();

say("## MIRROR TEST — do the two records describe the SAME item?");
const rIds = new Set(responseReasoning.map((p) => p.id));
const iIds = new Set(itemReasoning.map((i) => i.id));
const shared = [...iIds].filter((id) => rIds.has(id));
say(`  response_item ids : ${[...rIds].join(", ") || "(none)"}`);
say(`  item ids          : ${[...iIds].join(", ") || "(none)"}`);
say(`  ids in BOTH       : ${shared.length} / ${iIds.size}`);
const rText = responseReasoning.flatMap((p) => summaryTextOf(p.summary));
const iText = itemReasoning.flatMap((i) => (Array.isArray(i.summary_text) ? i.summary_text : []));
say(`  response text     : ${JSON.stringify(rText)}`);
say(`  item text         : ${JSON.stringify(iText)}`);
say(
  `  VERDICT           : ${
    shared.length === iIds.size && iIds.size > 0 && rText.length > 0 && JSON.stringify(rText) === JSON.stringify(iText)
      ? "SAME ITEM, SAME TEXT — the response_item carries the visible summary, so dropping the mirror loses nothing"
      : "DIVERGENT — the item carries text the response_item does not; the reader must be re-pointed"
  }`,
);
say();

say("## what the BUILT normalizer emits for this rollout");
const normalizer = new CodexRolloutNormalizer({ taskId: "sl8", sourceId: "codex:r7" });
const emitted = [];
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  for (const b of normalizer.consumeLine(line)) {
    emitted.push([b.kind, b.kind === "thinking" ? b.text : (b.text ?? b.markdown ?? "").slice(0, 60)]);
  }
}
for (const [kind, text] of emitted) say(`  ${kind.padEnd(15)} | ${sanitize(text)}`);
const thinking = emitted.filter(([k]) => k === "thinking");
say(`  thinking blocks: ${thinking.length}  (expected exactly 1 — not 0, not 2)`);
say();

if (OUT) {
  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`\n[written] ${OUT}`);
}
process.exit(drift ? 1 : 0);
