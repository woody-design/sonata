#!/usr/bin/env node
// r3 — deep sweep of `history_mode = paginated` rollouts (SL-8).
//
// r2 established that the conversational event family flips with the per-thread
// `history_mode`, not the CLI version. r3 measures what the PAGINATED vintage
// actually contains, for every axis CodexRolloutNormalizer reads:
//
//   * `response_item` payload types  — is the tool/reasoning half intact?
//   * `item_completed` item.type × phase — which items carry conversational text
//   * whether a paginated rollout ALSO carries the legacy events (double-read risk)
//   * turn_context / compacted / turn_aborted / review / rollback coverage
//
// MEASURED, read-only.
//
// Usage: node r3-paginated-deep-sweep.mjs [--mode paginated] [--out <file>]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const argOf = (n, f) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : f;
};
const OUT = argOf("--out", null);
const MODE = argOf("--mode", "paginated");
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

say(`# r3 — deep sweep, history_mode = ${MODE}`);
say(`codex --version : ${measuredVersion}`);
say(`expected        : ${EXPECT}${drift ? "   *** DRIFT — capture retained ***" : ""}`);
say(`captured at     : ${new Date().toISOString()}`);
say();

// The state DB may be locked by a live codex process; read a snapshot copy so a
// probe can never contend with (or be blocked by) the CLI.
function dbSnapshot() {
  const src = path.join(CODEX_HOME, "state_5.sqlite");
  const dst = path.join(os.tmpdir(), `sl8-state-snapshot-${process.pid}.sqlite`);
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, dst + suffix);
  }
  return dst;
}

const db = dbSnapshot();
const rows = execFileSync(
  "sqlite3",
  [db, "-separator", "\t", `select cli_version, history_mode, rollout_path from threads where history_mode = '${MODE}';`],
  { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
)
  .split("\n")
  .map((l) => l.split("\t"))
  .filter((c) => c.length === 3 && fs.existsSync(c[2]));

say(`## corpus: ${rows.length} rollouts with history_mode = ${MODE}`);
for (const [v, , ] of rows) void v;
const byVersion = new Map();
for (const [v] of rows) byVersion.set(v, (byVersion.get(v) ?? 0) + 1);
for (const [v, n] of [...byVersion.entries()].sort()) say(`  ${v}: ${n}`);
say();

const responseTypes = new Map();
const itemByPhase = new Map();
const legacyInPaginated = new Map();
const recordTypes = new Map();
const eventTypes = new Map();
const agentTextSamples = [];
const userTextSamples = [];
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

for (const [, , file] of rows) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let r;
    try {
      r = JSON.parse(t);
    } catch {
      continue;
    }
    bump(recordTypes, r?.type ?? "(none)");
    const p = r?.payload;
    if (!p || typeof p !== "object") continue;

    if (r.type === "response_item") {
      bump(responseTypes, `${p.type}${p.type === "message" ? ` (role=${p.role})` : ""}`);
    } else if (r.type === "event_msg") {
      bump(eventTypes, p.type ?? "(none)");
      if (p.type === "user_message" || p.type === "agent_message") bump(legacyInPaginated, p.type);
      const item = p.item;
      if (item && typeof item === "object") {
        bump(itemByPhase, `${p.type} → ${item.type}${item.phase ? ` phase=${item.phase}` : ""}`);
        if (item.type === "AgentMessage" && agentTextSamples.length < 4) {
          agentTextSamples.push(sanitize(JSON.stringify(item).slice(0, 400)));
        }
        if (item.type === "UserMessage" && userTextSamples.length < 4) {
          userTextSamples.push(sanitize(JSON.stringify(item).slice(0, 400)));
        }
      }
    }
  }
}

const table = (title, m, limit = 60) => {
  say(`## ${title}`);
  const rr = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!rr.length) say("(none)");
  for (const [k, v] of rr) say(`${String(v).padStart(7)}  ${sanitize(k)}`);
  say();
};

table("record types", recordTypes);
table("response_item payload.type (tool/reasoning half)", responseTypes);
table("event_msg payload.type", eventTypes);
table("item_* → item.type [phase]", itemByPhase);

say("## legacy conversational events inside paginated rollouts (double-read risk)");
if (legacyInPaginated.size === 0) {
  say("(none — a paginated rollout carries NO user_message/agent_message event, so");
  say(" handling item_completed alongside them cannot double-emit)");
} else {
  for (const [k, v] of legacyInPaginated) say(`${String(v).padStart(7)}  ${k}`);
}
say();

say("## sanitized AgentMessage samples");
for (const s of agentTextSamples) say(`  ${s}`);
say();
say("## sanitized UserMessage samples");
for (const s of userTextSamples) say(`  ${s}`);
say();

for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.unlinkSync(db + suffix);
  } catch {
    /* best effort */
  }
}

if (OUT) {
  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`\n[written] ${OUT}`);
}
process.exit(drift ? 1 : 0);
