#!/usr/bin/env node
// r4 — turn_context permission-projection matrix across every rollout vintage
// on this machine (SL-8, objective 2).
//
// `codexPermissionModeFromTurnContext` reconciles the permission mirror ONLY
// from the UNIQUE projection `(sandbox_policy.type = danger-full-access,
// approval_policy = never)` → full-access; every other pair keeps the mirror.
// The premise is that ask-for-approval and approve-for-me share
// `(workspace-write, on-request)` and split only on `approvals_reviewer`.
//
// r4 measures whether that premise still holds at 0.152.0 by tabulating the
// full observed cross-product of
//   sandbox_policy.type × approval_policy × approvals_reviewer × permission_profile.type
// bucketed by cli_version and history_mode, and by reporting which pairs are
// UNIQUE (one reviewer value) vs SHARED (more than one).
//
// MEASURED, read-only.
//
// Usage: node r4-turn-context-projection.mjs [--out <file>]

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

say("# r4 — turn_context permission-projection matrix");
say(`codex --version : ${measuredVersion}`);
say(`expected        : ${EXPECT}${drift ? "   *** DRIFT — capture retained ***" : ""}`);
say(`captured at     : ${new Date().toISOString()}`);
say();

function dbSnapshot() {
  const src = path.join(CODEX_HOME, "state_5.sqlite");
  const dst = path.join(os.tmpdir(), `sl8-r4-snapshot-${process.pid}.sqlite`);
  for (const s of ["", "-wal", "-shm"]) if (fs.existsSync(src + s)) fs.copyFileSync(src + s, dst + s);
  return dst;
}
const db = dbSnapshot();
const rows = execFileSync(
  "sqlite3",
  [db, "-separator", "\t", "select cli_version, history_mode, rollout_path from threads;"],
  { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
)
  .split("\n")
  .map((l) => l.split("\t"))
  .filter((c) => c.length === 3 && fs.existsSync(c[2]));

// pair -> reviewer -> count, plus a per-version view
const pairToReviewer = new Map();
const fullMatrix = new Map();
const byVersion = new Map();
const profileByPair = new Map();
const missingFields = new Map();
let turnContexts = 0;

const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const nested = (m, k) => {
  if (!m.has(k)) m.set(k, new Map());
  return m.get(k);
};

for (const [version, mode, file] of rows) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || !t.includes('"turn_context"')) continue;
    let r;
    try {
      r = JSON.parse(t);
    } catch {
      continue;
    }
    if (r?.type !== "turn_context") continue;
    const p = r.payload;
    if (!p || typeof p !== "object") continue;
    turnContexts += 1;

    const sb = p.sandbox_policy;
    const sandbox = sb && typeof sb === "object" ? String(sb.type) : sb === undefined ? "(absent)" : String(sb);
    const approval =
      p.approval_policy === undefined
        ? "(absent)"
        : typeof p.approval_policy === "object"
          ? `object{${Object.keys(p.approval_policy).sort().join(",")}}`
          : String(p.approval_policy);
    const reviewer = p.approvals_reviewer === undefined ? "(absent)" : String(p.approvals_reviewer);
    const pp = p.permission_profile;
    const profile = pp && typeof pp === "object" ? String(pp.type) : pp === undefined ? "(absent)" : String(pp);

    // The four fields Sonata CONSUMES must each be present and readable.
    for (const [name, ok] of [
      ["payload.model", typeof p.model === "string"],
      ["payload.effort", typeof p.effort === "string"],
      ["payload.approval_policy", typeof p.approval_policy === "string"],
      ["payload.sandbox_policy.type", sb && typeof sb === "object" && typeof sb.type === "string"],
    ]) {
      if (!ok) bump(missingFields, `${name}  [${version} / ${mode}]`);
    }

    const pair = `(${sandbox}, ${approval})`;
    bump(nested(pairToReviewer, pair), reviewer);
    bump(nested(profileByPair, pair), profile);
    bump(fullMatrix, `${pair} reviewer=${reviewer} profile=${profile}`);
    bump(nested(byVersion, `${version} / ${mode}`), `${pair} reviewer=${reviewer} profile=${profile}`);
  }
}

say(`turn_context records parsed: ${turnContexts}`);
say();

say("## UNIQUE-PROJECTION TEST — (sandbox_policy.type, approval_policy) → reviewer values");
say("A pair with EXACTLY ONE reviewer value is unambiguous and MAY reconcile.");
say("A pair with more than one is SHARED and must never overwrite the mirror.");
say();
for (const [pair, reviewers] of [...pairToReviewer.entries()].sort()) {
  const total = [...reviewers.values()].reduce((a, b) => a + b, 0);
  const verdict = reviewers.size === 1 ? "UNIQUE " : "SHARED ";
  const detail = [...reviewers.entries()].sort().map(([k, v]) => `${k}×${v}`).join(", ");
  say(`  ${verdict} ${pair.padEnd(42)} n=${String(total).padStart(5)}  reviewer: ${detail}`);
}
say();

say("## permission_profile.type observed per pair (the #39145 new field)");
for (const [pair, profiles] of [...profileByPair.entries()].sort()) {
  const detail = [...profiles.entries()].sort().map(([k, v]) => `${k}×${v}`).join(", ");
  say(`  ${pair.padEnd(42)} ${detail}`);
}
say();

say("## full cross-product");
for (const [k, v] of [...fullMatrix.entries()].sort((a, b) => b[1] - a[1])) {
  say(`${String(v).padStart(7)}  ${sanitize(k)}`);
}
say();

say("## by cli_version / history_mode");
for (const [key, m] of [...byVersion.entries()].sort()) {
  say(`### ${key}`);
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) say(`${String(v).padStart(7)}  ${sanitize(k)}`);
  say();
}

say("## consumed fields missing or unreadable");
if (missingFields.size === 0) {
  say("(none — every turn_context carries all four consumed fields in the expected type)");
} else {
  for (const [k, v] of [...missingFields.entries()].sort((a, b) => b[1] - a[1])) say(`${String(v).padStart(7)}  ${k}`);
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
