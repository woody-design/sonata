import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The Codex injection edge (control-plane S2) — the mirror of
 * `cli-signal/claude-runtime-settings.ts` in ROLE, not mechanism.
 *
 * Codex GA'd a hook system that clones Claude Code's hook contract
 * field-for-field (verified 2026-07-06, codex-cli 0.142.5), but its injection
 * seam and trust model differ, so this edge is Codex-specific:
 *
 *  - Injection is a Duet-named PROFILE FILE, `$CODEX_HOME/duet.config.toml`,
 *    layered onto the user's own config by `codex -p duet` (CONFIG_PROFILE_V2).
 *    Additive and inert: Duet writes ONLY this file; the user's config.toml,
 *    MCP servers, auth, trust, and history are never touched, and nothing fires
 *    unless Duet passes `-p duet`. Profile `[hooks]` UNION with the user's own
 *    hooks both ways (verified) — no clobber.
 *  - Trust binds to the EXACT hook command string, and untrusted/misconfigured
 *    hooks are SILENTLY skipped (probe hazard). So every command routes through
 *    a STABLE shim path (`<binDir>/codex-*-shim.js`) whose text is
 *    task-invariant: the one-time Codex trust ceremony then survives every task
 *    and every app update. Per-task binding travels via the `DUET_RUNTIME_DIR`
 *    environment variable the shims read at runtime (hooks inherit the spawn
 *    env — verified), never argv.
 *  - The hook SET is FROZEN at S2 — the complete final shape (5 core events →
 *    sink; PermissionRequest → broker) is registered now even though S2 consumes
 *    only SessionStart, because adding or editing a hook definition later
 *    re-triggers Codex's trust ceremony. Interim behavior is gated by runtime
 *    flags the shims check (an answering-enabled marker), never by definition
 *    edits: the broker shim is inert-until-marker (S3 drops the marker).
 *
 * The schema is written against PROBE-VERIFIED facts (codex-cli 0.142.5), NOT
 * vendor docs: PascalCase event names, STRING command (not argv array), the
 * `[[hooks.Event]]` / `[[hooks.Event.hooks]]` TOML shape with
 * `type = "command"`, and a per-hook `timeout` in seconds.
 */

/** The stable shim home (`duetBinDir()`, e.g. `~/.duet/bin`) — the ONE input
 *  the controller supplies, because Duet-home is the controller's path truth.
 *  The profile file location is THIS module's truth (codexProfilePath). */
export interface CodexHookPaths {
  binDir: string;
}

/** The profile name Duet layers via `codex -p <name>`. */
export const CODEX_DUET_PROFILE = "duet";

/** Shim filenames — part of the FROZEN command strings; never rename without
 *  accepting a Codex re-trust for every user. */
const SINK_SHIM = "codex-hook-sink.js";
const BROKER_SHIM = "codex-approval-broker.js";

/** The sink subdir under a task's runtime dir — single-sourced so the two
 *  path helpers AND the shim template agree by construction. */
const HOOKS_SUBDIR = "hooks";
const APPROVALS_SUBDIR = "approvals";

/**
 * The Duet Codex hook profile file — an ADDITIVE, Duet-named file inside the
 * user's Codex home, layered by `codex -p duet`. Honors `$CODEX_HOME` (so the
 * user's real Codex world is respected, and tests/live-passes can isolate to a
 * temp home) and defaults to `~/.codex`. Duet writes ONLY this file; the user's
 * own `config.toml` is never read or modified. This module owns the resolution
 * (the declared owner of Codex path truth).
 */
export function codexProfilePath(): string {
  const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(home, "duet.config.toml");
}

/** Fire-and-forget sink events (the 5 core events Codex emits and Duet's
 *  watcher consumes). PermissionRequest is DELIBERATELY absent — it is owned by
 *  the broker shim (a second sink on it would double-write the payload).
 *  Codex's verified event set is exactly these + PermissionRequest; no
 *  Notification / StopFailure / SubagentStop (Claude-only), so none are
 *  registered — no consumer, no claim. */
const SINK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;

/**
 * The broker's hook `timeout` (seconds). It must exceed the broker's internal
 * hold ceiling so Codex never kills it mid-decision (S3 concern); in S2 the
 * broker is inert and returns instantly, but the FROZEN definition already
 * carries the final timeout so S3 needs no definition edit (which would
 * re-trigger trust).
 */
const APPROVAL_HOOK_TIMEOUT_S = 120;

/** Path the sink drops `hook-*.json` into, under a task's runtime dir. The
 *  shim derives this from `DUET_RUNTIME_DIR` — same layout Claude's sink
 *  writes, so the same HookWatcher consumes both. */
export function codexHooksDirectory(runtimeDir: string): string {
  return path.join(runtimeDir, HOOKS_SUBDIR);
}

/** Path the broker uses for ask/reply/expired/marker files (S3). */
export function codexApprovalsDirectory(runtimeDir: string): string {
  return path.join(runtimeDir, APPROVALS_SUBDIR);
}

/**
 * Ensure the Duet Codex profile + shims exist and are current (write-if-changed
 * on all three files). Idempotent and task-invariant: the profile content
 * depends only on `binDir`, and the shims read their per-task binding from the
 * environment — so repeated spawn-prep calls converge on byte-identical files,
 * which is what makes the profile sha-stable and the trust ceremony one-time.
 *
 * Throws only on a genuinely unsafe state (unwritable dir, ENOSPC, or a
 * shell-unsafe shim path) — the caller degrades to a hookless spawn.
 */
export function ensureCodexRuntimeSettings(paths: CodexHookPaths): void {
  const profilePath = codexProfilePath();
  fs.mkdirSync(paths.binDir, { recursive: true });
  writeIfChanged(path.join(paths.binDir, SINK_SHIM), SINK_SHIM_SOURCE);
  writeIfChanged(path.join(paths.binDir, BROKER_SHIM), BROKER_SHIM_SOURCE);

  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  writeIfChanged(profilePath, buildProfileToml(paths.binDir));
}

/** The frozen command strings the user trusts once. `node "<abs path>"`:
 *  double-quoted so a homedir with spaces is shell-safe, and `node` bare (not
 *  an absolute interpreter path) so the string stays stable across app updates
 *  — the whole point of the stable-shim design. */
function sinkCommand(binDir: string): string {
  return `node "${guardShimPath(path.join(binDir, SINK_SHIM))}"`;
}

function brokerCommand(binDir: string): string {
  return `node "${guardShimPath(path.join(binDir, BROKER_SHIM))}"`;
}

/** The shim path is embedded inside a shell double-quoted argument. Reject the
 *  characters that would break OUT of that quoting or trigger shell expansion
 *  (`"` $ backtick backslash) — a homedir with one is effectively impossible,
 *  but fail LOUDLY (the caller degrades to a hookless spawn) rather than emit a
 *  command string that mis-parses or expands. The single-quote guard for the
 *  TOML literal wrapper lives in tomlLiteralString. */
function guardShimPath(shimPath: string): string {
  if (/["$`\\]/.test(shimPath)) {
    throw new Error(`Codex shim path has a shell-unsafe character: ${shimPath}`);
  }
  return shimPath;
}

/** Emit the profile TOML deterministically (stable event order, stable
 *  formatting) so the sha is provable across spawns. Command values use TOML
 *  LITERAL strings (single-quote delimited, no escape processing) so the
 *  embedded double-quotes stay verbatim — a homedir would have to contain a
 *  single quote to break this, which macOS/Linux paths effectively never do. */
function buildProfileToml(binDir: string): string {
  const header = [
    "# Duet-managed Codex hook profile — DO NOT EDIT (regenerated by Duet).",
    "#",
    "# Additive: `codex -p duet` layers this onto your own ~/.codex/config.toml",
    "# (union, never clobber). Duet writes ONLY this file; your config, MCP",
    "# servers, auth, and session history are untouched.",
    "#",
    "# This is the FINAL frozen hook set: Duet registers every event now (even",
    "# ones it does not yet consume) so adding one later never re-triggers the",
    "# Codex trust ceremony. Commands route through stable ~/.duet/bin shims;",
    "# per-task binding travels via the DUET_RUNTIME_DIR environment variable,",
    "# so these command strings stay identical across every task.",
    "",
  ];
  const blocks: string[] = [];
  for (const event of SINK_EVENTS) {
    blocks.push(hookBlock(event, sinkCommand(binDir), null));
  }
  blocks.push(hookBlock("PermissionRequest", brokerCommand(binDir), APPROVAL_HOOK_TIMEOUT_S));
  return `${header.join("\n")}\n${blocks.join("\n")}`;
}

/** One `[[hooks.Event]]` / `[[hooks.Event.hooks]]` block (probe-verified shape).
 *  No `matcher` — omitted means match-all (probe-verified; the sink/broker want
 *  every tool). */
function hookBlock(event: string, command: string, timeoutSeconds: number | null): string {
  const lines = [
    `[[hooks.${event}]]`,
    `[[hooks.${event}.hooks]]`,
    `type = "command"`,
    `command = ${tomlLiteralString(command)}`,
  ];
  if (timeoutSeconds !== null) {
    lines.push(`timeout = ${timeoutSeconds}`);
  }
  lines.push("");
  return lines.join("\n");
}

function tomlLiteralString(value: string): string {
  // TOML literal strings do not process escapes; guard the one character that
  // would terminate them early. Paths with a single quote are effectively
  // impossible here, but fail loudly rather than emit malformed TOML.
  if (value.includes("'")) {
    throw new Error(`Codex hook command must not contain a single quote: ${value}`);
  }
  return `'${value}'`;
}

function writeIfChanged(filePath: string, contents: string): void {
  try {
    if (fs.readFileSync(filePath, "utf8") === contents) {
      return;
    }
  } catch {
    // missing / unreadable → write below
  }
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, filePath);
}

// ── Frozen shim sources ──────────────────────────────────────────────────────
// These are the exact bytes Duet writes to the stable shim paths. They are
// plain CommonJS Node scripts (run as `node <path>`), self-contained so the
// TRUSTED TEXT is decoupled from any refactor of the Claude-side sink. Trust
// binds to the profile's command STRING, not these bytes, so Duet may refresh
// the content freely (S3 rewrites the broker); the command string never changes.

/** Reads the hook payload (JSON) on stdin and writes it as ONE uniquely-named
 *  file into `$DUET_RUNTIME_DIR/hooks` via tmp+rename — the exact protocol of
 *  `cli-signal/hook-sink.ts`, but keyed by env (task-invariant argv). Exit 0
 *  always; observation must never block the CLI's turn. */
const SINK_SHIM_SOURCE = `"use strict";
// Duet Codex hook sink — FROZEN shim (control plane S2). Task binding arrives
// via the DUET_RUNTIME_DIR env var (hooks inherit the spawn env), never argv,
// so the command string this file is invoked by stays task-invariant and the
// one-time Codex trust ceremony persists. Regenerated by Duet at spawn-prep.
const fs = require("node:fs");
const path = require("node:path");
const runtimeDir = process.env.DUET_RUNTIME_DIR;
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) { raw += chunk; });
process.stdin.on("end", function () {
  if (!runtimeDir) return;
  const trimmed = raw.replace(/\\s+$/, "");
  if (!trimmed) return;
  try {
    const dir = path.join(runtimeDir, "${HOOKS_SUBDIR}");
    fs.mkdirSync(dir, { recursive: true });
    const seq = Date.now().toString(36) + "-" + process.hrtime.bigint().toString(36) + "-" + process.pid;
    const file = path.join(dir, "hook-" + seq + ".json");
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, trimmed, "utf8");
    fs.renameSync(tmp, file);
  } catch (_e) {
    // Never surface a sink failure to the CLI.
  }
});
`;

/** S2: inert. Reads stdin (so Codex never sees a broken pipe), checks for the
 *  answering-enabled marker in `$DUET_RUNTIME_DIR/approvals/`; absent (always,
 *  in S2) → exit 0 with NO stdout → Codex renders its native approval card
 *  instantly, zero stall. S3 rewrites this file with the hold-and-answer loop
 *  once the marker ships — no profile/definition change, so no re-trust. */
const BROKER_SHIM_SOURCE = `"use strict";
// Duet Codex approval broker — FROZEN command, refreshable content (S2 inert).
// The profile registers this on PermissionRequest with a timeout; that command
// string is what the one-time trust ceremony binds to and never changes. This
// file's BYTES, however, Duet refreshes freely — S3 replaces this inert body
// with the hold-and-answer loop once the answering-enabled marker exists.
const fs = require("node:fs");
const path = require("node:path");
const runtimeDir = process.env.DUET_RUNTIME_DIR;
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) { raw += chunk; });
process.stdin.on("end", function () {
  let answering = false;
  try {
    if (runtimeDir) {
      answering = fs.existsSync(path.join(runtimeDir, "${APPROVALS_SUBDIR}", "answering-enabled"));
    }
  } catch (_e) {
    answering = false;
  }
  if (!answering) {
    // S2 always lands here (the marker never exists): no stdout → Codex renders
    // its native approval card instantly, zero stall.
    process.exit(0);
  }
  // S3: the hold-and-answer loop (surface ask-<id>.json, poll reply-<id>.json,
  // emit the decision JSON to stdout) lands here, gated on the marker above.
  process.exit(0);
});
`;
