#!/usr/bin/env node
// r2 — `event_msg/item_completed` vs the legacy `user_message`/`agent_message`
// event family, cross-referenced against cli_version and threads.history_mode
// (SL-8).
//
// r1 measured that at 0.152.0 the conversational event family Sonata's
// CodexRolloutNormalizer reads (`user_message` / `agent_message`) is ABSENT and
// a new `item_completed` family carries the same content. r2 answers: when did
// that flip, is it keyed to the CLI version or to the per-thread
// `history_mode`, and what is the full inventory of `item.type` shapes the
// normalizer must now recognize.
//
// MEASURED, read-only.
//
// Usage: node r2-item-completed-shapes.mjs [--out <file>]

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

say("# r2 — item_completed vs legacy conversational events");
say(`codex --version : ${measuredVersion}`);
say(`expected        : ${EXPECT}${drift ? "   *** DRIFT — capture retained ***" : ""}`);
say(`captured at     : ${new Date().toISOString()}`);
say();

const db = path.join(CODEX_HOME, "state_5.sqlite");
const rows = execFileSync(
  "sqlite3",
  [
    `file:${db}?mode=ro`,
    "-separator",
    "\t",
    "select cli_version, history_mode, rollout_path from threads where cli_version <> '' order by cli_version;",
  ],
  { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
)
  .split("\n")
  .map((l) => l.split("\t"))
  .filter((c) => c.length === 3 && fs.existsSync(c[2]));

say(`threads with an on-disk rollout: ${rows.length}`);
say();

// version+mode → { files, legacyUser, legacyAgent, itemCompleted, other }
const matrix = new Map();
const itemTypes = new Map();
const itemFieldsByType = new Map();
const contentTypes = new Map();
const settingsApplied = new Map();
const samples = new Map();

const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

for (const [version, mode, file] of rows) {
  const key = `${version}\t${mode}`;
  if (!matrix.has(key)) {
    matrix.set(key, { files: 0, user_message: 0, agent_message: 0, item_completed: 0, item_started: 0, item_updated: 0 });
  }
  const cell = matrix.get(key);
  cell.files += 1;

  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || !t.includes('"event_msg"')) continue;
    let record;
    try {
      record = JSON.parse(t);
    } catch {
      continue;
    }
    if (record?.type !== "event_msg") continue;
    const p = record.payload;
    if (!p || typeof p !== "object") continue;
    if (p.type in cell) cell[p.type] += 1;

    if (p.type === "thread_settings_applied") {
      bump(settingsApplied, `keys={${Object.keys(p).sort().join(",")}} ${JSON.stringify(p.settings ?? p)}`.slice(0, 300));
    }

    if (p.type === "item_completed" || p.type === "item_started" || p.type === "item_updated") {
      const item = p.item;
      if (!item || typeof item !== "object") {
        bump(itemTypes, `${p.type} → item: ${item === null ? "null" : typeof item}`);
        continue;
      }
      const it = String(item.type);
      bump(itemTypes, `${p.type} → ${it}`);
      if (!itemFieldsByType.has(it)) itemFieldsByType.set(it, new Map());
      for (const [k, v] of Object.entries(item)) {
        bump(itemFieldsByType.get(it), `${k}: ${Array.isArray(v) ? "array" : v === null ? "null" : typeof v}`);
      }
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && typeof c === "object") bump(contentTypes, `${it}.content[].type = ${c.type}  keys={${Object.keys(c).sort().join(",")}}`);
          else bump(contentTypes, `${it}.content[] = ${typeof c}`);
        }
      }
      if (!samples.has(it)) samples.set(it, sanitize(JSON.stringify(item).slice(0, 900)));
    }
  }
}

say("## event family by cli_version × history_mode");
say(
  `${"cli_version".padEnd(22)}${"history_mode".padEnd(12)}${"files".padStart(6)}${"user_msg".padStart(10)}${"agent_msg".padStart(11)}${"item_started".padStart(14)}${"item_completed".padStart(16)}${"item_updated".padStart(14)}`,
);
for (const [key, c] of [...matrix.entries()].sort()) {
  const [v, m] = key.split("\t");
  say(
    `${v.padEnd(22)}${m.padEnd(12)}${String(c.files).padStart(6)}${String(c.user_message).padStart(10)}${String(c.agent_message).padStart(11)}${String(c.item_started).padStart(14)}${String(c.item_completed).padStart(16)}${String(c.item_updated).padStart(14)}`,
  );
}
say();

const table = (title, m, limit = 80) => {
  say(`## ${title}`);
  const rows2 = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!rows2.length) say("(none)");
  for (const [k, v] of rows2) say(`${String(v).padStart(7)}  ${sanitize(k)}`);
  say();
};

table("item.type inventory", itemTypes);
for (const [it, fields] of [...itemFieldsByType.entries()].sort()) {
  table(`item fields — ${it}`, fields);
}
table("item.content[] shapes", contentTypes);
table("thread_settings_applied payloads", settingsApplied, 20);

say("## one sanitized sample per item.type");
for (const [it, s] of [...samples.entries()].sort()) {
  say(`### ${it}`);
  say(s);
  say();
}

if (OUT) {
  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`\n[written] ${OUT}`);
}
process.exit(drift ? 1 : 0);
