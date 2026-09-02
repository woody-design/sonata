#!/usr/bin/env node
// r5 — drive one real 0.152.0 session per Sonata permission mode and read back
// what `turn_context` records (SL-8, objective 2).
//
// r4 found NO 0.152.0 turn_context carrying `danger-full-access` in the local
// corpus (every 0.152.0 thread on this machine is a Sonata smoke session spawned
// ask-for-approval), so the load-bearing reconcile case — full-access's unique
// `(danger-full-access, never)` projection — was UNMEASURED at this version.
// r5 measures it directly by spawning one session per row of
// CODEX_PERMISSION_MODE_FLAGS (terminal-host.ts) with the identical
// sandbox / approval / approvals_reviewer triple, then parsing the rollout the
// run produced.
//
// The prompt is deliberately tool-free so an `on-request` arm can never park on
// an approval request.
//
// Usage: node r5-permission-mode-drive.mjs [--out <file>]

import { execFileSync, spawnSync } from "node:child_process";
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
const ROOT = "/private/tmp/sonata-sync-2026-09";

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

say("# r5 — live turn_context per Sonata permission mode");
say(`codex --version : ${measuredVersion}`);
say(`expected        : ${EXPECT}${drift ? "   *** DRIFT — capture retained ***" : ""}`);
say(`captured at     : ${new Date().toISOString()}`);
say();

// Verbatim from CODEX_PERMISSION_MODE_FLAGS (terminal-host.ts) — read, not
// re-derived, so a drift in the table shows up here as a failed match.
const MODES = [
  { mode: "ask-for-approval", sandbox: "workspace-write", approval: "on-request", reviewer: "user" },
  { mode: "approve-for-me", sandbox: "workspace-write", approval: "on-request", reviewer: "auto_review" },
  { mode: "full-access", sandbox: "danger-full-access", approval: "never", reviewer: "user" },
];

const results = [];
for (const row of MODES) {
  const cwd = path.join(ROOT, `r5-${row.mode}`);
  fs.mkdirSync(cwd, { recursive: true });
  const startedAt = Date.now();
  // NOTE: the headless `exec` form has no `-a` flag (that is the TUI form's);
  // the approval axis is set through its config key instead, which is the same
  // value `-a` writes. Everything else matches the spawn table verbatim.
  const argv = [
    "exec",
    "--skip-git-repo-check",
    "-C",
    cwd,
    "-s",
    row.sandbox,
    "-c",
    `approval_policy="${row.approval}"`,
    "-c",
    `approvals_reviewer="${row.reviewer}"`,
    `Reply with exactly SONATA_SL8_R5_${row.mode.toUpperCase().replace(/-/g, "_")} and nothing else. Do not call any tool.`,
  ];
  say(`## ${row.mode}`);
  say(`  spawn: codex ${argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
  const run = spawnSync("codex", argv, { encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] });
  say(`  exit: ${run.status}${run.error ? ` (${run.error.message})` : ""}`);

  // Find the rollout this run just wrote: newest session_meta whose cwd matches
  // and whose timestamp is at/after the spawn.
  const found = newestRolloutFor(cwd, startedAt - 20_000);
  if (!found) {
    say("  rollout: NOT FOUND");
    say();
    results.push({ ...row, rollout: null });
    continue;
  }
  say(`  rollout: ${sanitize(found)}`);
  const contexts = readTurnContexts(found);
  say(`  turn_context records: ${contexts.length}`);
  for (const c of contexts) {
    say(
      `    sandbox_policy.type=${JSON.stringify(c.sandbox)}  approval_policy=${JSON.stringify(c.approval)}  approvals_reviewer=${JSON.stringify(c.reviewer)}  permission_profile.type=${JSON.stringify(c.profile)}`,
    );
    say(`    model=${JSON.stringify(c.model)}  effort=${JSON.stringify(c.effort)}`);
  }
  const first = contexts[0];
  if (first) {
    const projects = first.sandbox === "danger-full-access" && first.approval === "never";
    say(
      `  codexPermissionModeFromTurnContext(${JSON.stringify(first.sandbox)}, ${JSON.stringify(first.approval)}) ⇒ ${projects ? '"full-access"' : "null (keeps mirror)"}`,
    );
    say(`  spawn reviewer=${row.reviewer} vs turn_context reviewer=${JSON.stringify(first.reviewer)}`);
  }
  say();
  results.push({ ...row, rollout: found, contexts });
}

say("## verdict table");
say(
  `${"mode".padEnd(18)}${"spawn (sandbox, approval, reviewer)".padEnd(52)}${"turn_context (sandbox, approval, reviewer)".padEnd(52)}reconcile`,
);
for (const r of results) {
  const c = r.contexts?.[0];
  const spawnTriple = `(${r.sandbox}, ${r.approval}, ${r.reviewer})`;
  const seen = c ? `(${c.sandbox}, ${c.approval}, ${c.reviewer})` : "(no rollout)";
  const reconcile = c && c.sandbox === "danger-full-access" && c.approval === "never" ? "full-access" : "null";
  say(`${r.mode.padEnd(18)}${spawnTriple.padEnd(52)}${seen.padEnd(52)}${reconcile}`);
}
say();

function newestRolloutFor(cwd, notBeforeMs) {
  const now = new Date();
  const dir = path.join(
    CODEX_HOME,
    "sessions",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  );
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((e) => e.endsWith(".jsonl"));
  } catch {
    return null;
  }
  const matches = [];
  for (const e of entries) {
    const p = path.join(dir, e);
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      continue;
    }
    if (stat.mtimeMs < notBeforeMs) continue;
    let first;
    try {
      first = fs.readFileSync(p, "utf8").split("\n", 1)[0];
    } catch {
      continue;
    }
    try {
      const r = JSON.parse(first);
      if (r?.type === "session_meta" && r.payload?.cwd === cwd) matches.push({ p, m: stat.mtimeMs });
    } catch {
      /* not ours */
    }
  }
  matches.sort((a, b) => b.m - a.m);
  return matches[0]?.p ?? null;
}

function readTurnContexts(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || !t.includes('"turn_context"')) continue;
    let r;
    try {
      r = JSON.parse(t);
    } catch {
      continue;
    }
    if (r?.type !== "turn_context") continue;
    const p = r.payload ?? {};
    const sb = p.sandbox_policy;
    const pp = p.permission_profile;
    out.push({
      sandbox: sb && typeof sb === "object" ? sb.type : sb,
      approval: typeof p.approval_policy === "object" && p.approval_policy !== null ? `object{${Object.keys(p.approval_policy).join(",")}}` : p.approval_policy,
      reviewer: p.approvals_reviewer,
      profile: pp && typeof pp === "object" ? pp.type : pp,
      model: p.model,
      effort: p.effort,
    });
  }
  return out;
}

if (OUT) {
  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`\n[written] ${OUT}`);
}
process.exit(drift ? 1 : 0);
