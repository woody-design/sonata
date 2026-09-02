#!/usr/bin/env node
// r6 — run Sonata's BUILT parsers over every live rollout on this machine
// (SL-8, objectives 3 + 4).
//
// r1–r5 measured the record shapes. r6 measures the parsers' behaviour against
// those shapes by importing the real dist build — not a transcription of it:
//
//   * CodexRolloutNormalizer  — every line of every rollout, both vintages.
//                               Must never throw, and a paginated rollout must
//                               now yield the same block kinds a legacy one does.
//   * parseCodexTokenCountPayload — every live token_count payload.
//   * assessCodexCompactionIntegrity — every live `compacted` record (the
//                               49-record invariant, re-verified on today's corpus).
//   * locateSessionFile       — resolves fresh and resumed 0.152.0 sessions.
//
// MEASURED, read-only over ~/.codex.
//
// Usage: node r6-live-parser-verify.mjs [--out <file>]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DIST = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../../app/dist/runtime/provider-transcript/index",
);
const { CodexRolloutNormalizer, assessCodexCompactionIntegrity, locateSessionFile } = require(DIST);
const { parseCodexTokenCountPayload } = require(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../app/dist/runtime/usage/index"),
);

const args = process.argv.slice(2);
const argOf = (n, f) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : f;
};
const OUT = argOf("--out", null);
const EXPECT = argOf("--expect", "0.152.0");
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");

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

say("# r6 — Sonata's built parsers over the live rollout corpus");
say(`codex --version : ${measuredVersion}`);
say(`expected        : ${EXPECT}${drift ? "   *** DRIFT — capture retained ***" : ""}`);
say(`dist            : app/dist/runtime/provider-transcript`);
say(`captured at     : ${new Date().toISOString()}`);
say();

function dbSnapshot() {
  const src = path.join(CODEX_HOME, "state_5.sqlite");
  const dst = path.join(os.tmpdir(), `sl8-r6-snapshot-${process.pid}.sqlite`);
  for (const s of ["", "-wal", "-shm"]) if (fs.existsSync(src + s)) fs.copyFileSync(src + s, dst + s);
  return dst;
}
const db = dbSnapshot();
const rows = execFileSync(
  "sqlite3",
  [db, "-separator", "\t", "select cli_version, history_mode, rollout_path, id from threads;"],
  { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
)
  .split("\n")
  .map((l) => l.split("\t"))
  .filter((c) => c.length === 4 && fs.existsSync(c[2]));

// ---- 1. normalizer over the whole corpus ------------------------------------
const byMode = new Map();
const throwsSeen = [];
let filesRead = 0;
let linesRead = 0;

for (const [version, mode, file] of rows) {
  if (!byMode.has(mode)) {
    byMode.set(mode, { files: 0, blocks: 0, kinds: new Map(), filesWithNoBlocks: 0, versions: new Set() });
  }
  const cell = byMode.get(mode);
  cell.files += 1;
  cell.versions.add(version);
  filesRead += 1;

  const normalizer = new CodexRolloutNormalizer({ taskId: "sl8", sourceId: `codex:${path.basename(file)}` });
  let blocksHere = 0;
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    linesRead += 1;
    let blocks;
    try {
      blocks = normalizer.consumeLine(line);
    } catch (error) {
      throwsSeen.push({ file: sanitize(file), message: error.message });
      continue;
    }
    for (const b of blocks) {
      cell.blocks += 1;
      blocksHere += 1;
      cell.kinds.set(b.kind, (cell.kinds.get(b.kind) ?? 0) + 1);
    }
  }
  if (blocksHere === 0) cell.filesWithNoBlocks += 1;
}

say("## CodexRolloutNormalizer over every rollout, by history_mode");
say(`files: ${filesRead}   lines: ${linesRead}   THROWS: ${throwsSeen.length}`);
say();
for (const [mode, cell] of [...byMode.entries()].sort()) {
  say(`### history_mode = ${mode}`);
  say(`  rollouts            : ${cell.files}`);
  say(`  cli versions        : ${[...cell.versions].sort().join(", ")}`);
  say(`  blocks emitted      : ${cell.blocks}`);
  say(`  rollouts yielding 0 : ${cell.filesWithNoBlocks}   <-- the reading surface is BLANK for these`);
  say(`  block kinds         : ${[...cell.kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(", ") || "(none)"}`);
  say();
}
if (throwsSeen.length) {
  say("### THROWS (a normalizer must never throw)");
  for (const t of throwsSeen.slice(0, 20)) say(`  ${t.file}: ${t.message}`);
  say();
}

// ---- 2. token_count over every live payload ---------------------------------
let tokenCounts = 0;
let tokenParsed = 0;
const tokenNulls = [];
const windowValues = new Map();
for (const [version, mode, file] of rows) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const line of raw.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.type !== "event_msg" || r.payload?.type !== "token_count") continue;
    tokenCounts += 1;
    let snap;
    try {
      snap = parseCodexTokenCountPayload(r.payload, { capturedAt: Date.parse(r.timestamp) || Date.now() });
    } catch (error) {
      tokenNulls.push(`THREW ${error.message} [${version}/${mode}]`);
      continue;
    }
    if (!snap) {
      tokenNulls.push(`null snapshot [${version}/${mode}]`);
      continue;
    }
    tokenParsed += 1;
    const w = snap.context?.windowTokens ?? "(no context)";
    windowValues.set(`${w}`, (windowValues.get(`${w}`) ?? 0) + 1);
  }
}
say("## parseCodexTokenCountPayload over every live token_count");
say(`  payloads       : ${tokenCounts}`);
say(`  parsed         : ${tokenParsed}`);
say(`  null / threw   : ${tokenNulls.length}`);
for (const n of [...new Set(tokenNulls)].slice(0, 12)) say(`    ${n}`);
say(`  windowTokens observed: ${[...windowValues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}×${v}`).join(", ")}`);
say();

// ---- 3. compaction integrity invariant --------------------------------------
const verdicts = new Map();
const byVintage = new Map();
for (const [version, mode, file] of rows) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const line of raw.split("\n")) {
    if (!line.includes('"compacted"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.type !== "compacted" || !r.payload) continue;
    const v = assessCodexCompactionIntegrity(r.payload);
    verdicts.set(v, (verdicts.get(v) ?? 0) + 1);
    const key = `${version} / ${mode}`;
    if (!byVintage.has(key)) byVintage.set(key, new Map());
    byVintage.get(key).set(v, (byVintage.get(key).get(v) ?? 0) + 1);
  }
}
say("## assessCodexCompactionIntegrity over every live `compacted` record");
const total = [...verdicts.values()].reduce((a, b) => a + b, 0);
say(`  records: ${total}`);
for (const [k, v] of [...verdicts.entries()].sort()) say(`    ${k}: ${v}`);
say("  by vintage:");
for (const [key, m] of [...byVintage.entries()].sort()) {
  say(`    ${key}: ${[...m.entries()].sort().map(([k, v]) => `${k}×${v}`).join(", ")}`);
}
if (![...byVintage.keys()].some((k) => k.endsWith("paginated"))) {
  say("  NOTE: zero `compacted` records exist in ANY paginated rollout on this");
  say("        machine — the invariant is UNREPRODUCED at history_mode=paginated.");
}
say();

// ---- 4. locateSessionFile against fresh + resumed 0.152.0 -------------------
say("## locateSessionFile at 0.152.0");
const sessionsDir = path.join(CODEX_HOME, "sessions");
const recent = rows
  .filter(([v]) => v === "0.152.0")
  .map(([, , file, id]) => ({ file, id, mtime: fs.statSync(file).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, 6);

for (const r of recent) {
  const first = fs.readFileSync(r.file, "utf8").split("\n", 1)[0];
  let cwd = null;
  try {
    cwd = JSON.parse(first)?.payload?.cwd ?? null;
  } catch {
    /* unreadable head */
  }
  if (!cwd) {
    say(`  ${path.basename(r.file)}: session_meta head UNREADABLE — locate would skip it`);
    continue;
  }
  // notBefore must be the session's own START, which is what production passes
  // (`ptyStartedAt` of the spawn that created it). A RESUMED session keeps its
  // original `session_meta.timestamp` while its mtime advances, so deriving
  // notBefore from mtime would reject exactly the resumed sessions this arm is
  // here to cover — locateCodexSession applies its timestamp filter BEFORE the
  // expectedSessionId match, so no id can rescue a too-old start.
  let startedAt = null;
  try {
    startedAt = JSON.parse(first)?.payload?.timestamp ?? null;
  } catch {
    /* head already reported unreadable below */
  }
  const notBefore = new Date(Date.parse(startedAt ?? new Date(r.mtime).toISOString()) - 1_000).toISOString();
  const resumed = startedAt !== null && r.mtime - Date.parse(startedAt) > 120_000;
  const byId = locateSessionFile({
    provider: "codex",
    providerCwd: cwd,
    notBefore,
    expectedSessionId: r.id,
    allowMtimeFallback: false,
    codexSessionsDir: sessionsDir,
  });
  const byRecency = locateSessionFile({
    provider: "codex",
    providerCwd: cwd,
    notBefore,
    expectedSessionId: null,
    allowMtimeFallback: true,
    codexSessionsDir: sessionsDir,
  });
  say(`  ${sanitize(path.basename(r.file))}${resumed ? "   [RESUMED — mtime is >2min after session start]" : "   [fresh]"}`);
  say(`    cwd                  : ${sanitize(cwd)}`);
  say(`    session start        : ${startedAt}   file mtime: ${new Date(r.mtime).toISOString()}`);
  say(`    id-anchored (prod)   : ${byId ? (byId.path === r.file ? "MATCH" : `WRONG FILE ${sanitize(byId.path)}`) : "NULL"}`);
  say(`    providerSessionId    : ${byId?.providerSessionId ?? "(none)"}`);
  say(`    recency fallback     : ${byRecency ? (byRecency.path === r.file ? "MATCH" : `other ${sanitize(path.basename(byRecency.path))}`) : "NULL"}`);
}
say();

for (const s of ["", "-wal", "-shm"]) {
  try {
    fs.unlinkSync(db + s);
  } catch {
    /* best effort */
  }
}

if (OUT) {
  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`\n[written] ${OUT}`);
}
process.exit(drift ? 1 : 0);
