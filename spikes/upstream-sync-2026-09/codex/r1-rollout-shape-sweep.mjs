#!/usr/bin/env node
// r1 — rollout shape sweep at codex 0.152.0 (SL-8).
//
// MEASURED, read-only. Enumerates every rollout file the state DB attributes to
// a given CLI version and reports the record-shape matrix Sonata's parsers care
// about: record types, event_msg payload types, response_item payload types,
// turn_context field inventory, token_count field inventory, and the
// `compacted` replacement_history invariant.
//
// Usage:
//   node r1-rollout-shape-sweep.mjs [--version 0.152.0] [--out <file>]
//
// Version pin: aborts if `codex --version` does not match --expect (default
// 0.152.0). Per the program's method note, a drift is RECORDED and the capture
// saved before exiting non-zero — never discarded.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const EXPECT = argOf("--expect", "0.152.0");
const WANT_VERSIONS = argOf("--version", EXPECT).split(",");
const OUT = argOf("--out", null);
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");

const lines = [];
const say = (s = "") => {
  lines.push(s);
  console.log(s);
};

// ---- sanitization -----------------------------------------------------------
// Both username forms: the literal home path and the munged `-Users-<user>-`
// slug Claude/Codex project dirs use.
const HOME = os.homedir();
const USER = path.basename(HOME);
const MUNGED = `-Users-${USER}-`;
const sanitize = (s) =>
  String(s)
    .split(HOME)
    .join("~")
    .split(MUNGED)
    .join("-Users-USER-")
    .split(`/Users/${USER}`)
    .join("~");

// ---- version pin ------------------------------------------------------------
let measuredVersion = "UNKNOWN";
let drift = false;
try {
  measuredVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
} catch (error) {
  measuredVersion = `ERROR: ${error.message}`;
}
if (!measuredVersion.includes(EXPECT)) {
  drift = true;
}

say(`# r1 — codex rollout shape sweep`);
say(`codex --version : ${measuredVersion}`);
say(`expected        : ${EXPECT}${drift ? "   *** DRIFT — capture retained, exit non-zero ***" : ""}`);
say(`CODEX_HOME      : ${sanitize(CODEX_HOME)}`);
say(`captured at     : ${new Date().toISOString()}`);
say();

// ---- rollout enumeration ----------------------------------------------------
// The state DB is the only place a rollout's authoring CLI version is recorded.
function rolloutsForVersions(versions) {
  const db = path.join(CODEX_HOME, "state_5.sqlite");
  if (!fs.existsSync(db)) {
    return null;
  }
  const inList = versions.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
  const out = execFileSync(
    "sqlite3",
    [`file:${db}?mode=ro`, `select rollout_path from threads where cli_version in (${inList});`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

const paths = (rolloutsForVersions(WANT_VERSIONS) ?? []).filter((p) => fs.existsSync(p));
say(`## corpus`);
say(`cli_version in : ${WANT_VERSIONS.join(", ")}`);
say(`rollout files  : ${paths.length}`);
say();

// ---- sweep ------------------------------------------------------------------
const recordTypes = new Map();
const eventTypes = new Map();
const responseTypes = new Map();
const otherPayloadTypes = new Map();
const turnContextKeys = new Map();
const turnContextValues = new Map();
const tokenCountKeys = new Map();
const usageKeys = new Map();
const rateLimitKeys = new Map();
const contextWindows = new Map();
const totalTokensOddities = [];
const compactedShapes = new Map();
const sessionMetaKeys = new Map();
const firstLineBytes = [];
const parseFailures = [];
let recordCount = 0;

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const bumpKeys = (map, obj) => {
  for (const [k, v] of Object.entries(obj)) {
    bump(map, `${k}: ${typeName(v)}`);
  }
};
function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length ? typeName(v[0]) : ""}]`;
  if (typeof v === "object") {
    const t = v.type ?? v.kind;
    return typeof t === "string" ? `object{type:${t}}` : "object";
  }
  return typeof v;
}

for (const file of paths) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const fileLines = raw.split("\n");
  firstLineBytes.push(Buffer.byteLength(fileLines[0] ?? "", "utf8"));
  for (const line of fileLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      parseFailures.push(sanitize(file));
      continue;
    }
    recordCount += 1;
    const type = record?.type ?? "(no type)";
    bump(recordTypes, type);
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;

    if (type === "event_msg") {
      bump(eventTypes, payload.type ?? "(none)");
      if (payload.type === "token_count") {
        bumpKeys(tokenCountKeys, payload);
        const info = payload.info;
        if (info && typeof info === "object") {
          bumpKeys(usageKeys, info);
          for (const slot of ["total_token_usage", "last_token_usage"]) {
            const u = info[slot];
            if (u && typeof u === "object") bumpKeys(usageKeys, { [`${slot}.*`]: null, ...prefix(slot, u) });
          }
          const win = info.model_context_window;
          bump(contextWindows, String(win));
          const last = info.last_token_usage;
          const total = last && typeof last === "object" ? last.total_tokens : undefined;
          // What would fool `codexContextSnapshot`: a window at/below the 12k
          // baseline, a missing/zero window, or a total the parser cannot read.
          if (typeof win !== "number" || win <= 12_000 || typeof total !== "number") {
            totalTokensOddities.push({
              file: sanitize(path.basename(file)),
              window: win,
              total,
            });
          }
        }
        const rl = payload.rate_limits;
        if (rl && typeof rl === "object") bumpKeys(rateLimitKeys, rl);
      }
    } else if (type === "response_item") {
      bump(responseTypes, payload.type ?? "(none)");
    } else if (type === "turn_context") {
      bumpKeys(turnContextKeys, payload);
      for (const field of ["model", "effort", "approval_policy", "approvals_reviewer", "personality", "summary"]) {
        bump(turnContextValues, `${field} = ${JSON.stringify(payload[field])}`);
      }
      const sb = payload.sandbox_policy;
      bump(
        turnContextValues,
        `sandbox_policy.type = ${JSON.stringify(sb && typeof sb === "object" ? sb.type : sb)}`,
      );
      const pp = payload.permission_profile;
      bump(
        turnContextValues,
        `permission_profile.type = ${JSON.stringify(pp && typeof pp === "object" ? pp.type : pp)}`,
      );
    } else if (type === "session_meta") {
      bumpKeys(sessionMetaKeys, payload);
    } else if (type === "compacted") {
      const history = payload.replacement_history;
      if (!Array.isArray(history)) {
        bump(compactedShapes, `replacement_history: ${typeName(history)}`);
      } else {
        const kinds = history.map((i) => (i && typeof i === "object" ? String(i.type) : typeName(i)));
        const summaries = kinds.filter((k) => k === "compaction");
        const last = kinds[kinds.length - 1];
        const cipherOk = history
          .filter((i) => i && typeof i === "object" && i.type === "compaction")
          .every((i) => typeof i.encrypted_content === "string" && i.encrypted_content.length > 0);
        bump(
          compactedShapes,
          `len=${kinds.length} types={${[...new Set(kinds)].sort().join(",")}} summaries=${summaries.length} last=${last} cipherOk=${cipherOk}`,
        );
      }
    } else {
      bump(otherPayloadTypes, `${type} → payload keys: ${Object.keys(payload).sort().join(",")}`);
    }
  }
}

function prefix(p, obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[`${p}.${k}`] = v;
  return out;
}

// ---- report -----------------------------------------------------------------
const table = (title, map, limit = 60) => {
  say(`## ${title}`);
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (rows.length === 0) say("(none)");
  for (const [k, v] of rows) say(`${String(v).padStart(7)}  ${sanitize(k)}`);
  say();
};

say(`records parsed : ${recordCount}`);
say(`parse failures : ${parseFailures.length}`);
say(
  `first-line bytes: min ${Math.min(...firstLineBytes)} max ${Math.max(...firstLineBytes)} (head scan is 256KiB)`,
);
say();
table("record types (top level)", recordTypes);
table("event_msg payload.type", eventTypes);
table("response_item payload.type", responseTypes);
table("other record types → payload keys", otherPayloadTypes);
table("turn_context field inventory (key: type)", turnContextKeys);
table("turn_context consumed/adjacent VALUES", turnContextValues);
table("token_count payload keys", tokenCountKeys);
table("token_count info.* keys", usageKeys, 80);
table("token_count rate_limits keys", rateLimitKeys);
table("model_context_window values", contextWindows);
table("session_meta payload keys", sessionMetaKeys);
table("compacted replacement_history shapes", compactedShapes);

say(`## token_count readings that would defeat codexContextSnapshot`);
if (totalTokensOddities.length === 0) {
  say("(none — every token_count carries a numeric model_context_window > 12000 and a numeric last_token_usage.total_tokens)");
} else {
  for (const o of totalTokensOddities.slice(0, 40)) {
    say(`  window=${JSON.stringify(o.window)} last.total_tokens=${JSON.stringify(o.total)}  ${o.file}`);
  }
  say(`  (${totalTokensOddities.length} total)`);
}
say();

if (OUT) {
  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`\n[written] ${OUT}`);
}
process.exit(drift ? 1 : 0);
