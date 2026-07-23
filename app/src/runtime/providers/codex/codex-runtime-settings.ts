import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ANSWERED_PREFIX,
  APPROVALS_SUBDIR,
  APPROVAL_POLL_MS,
  ASK_PREFIX,
  EXPIRED_PREFIX,
  REPLY_PREFIX,
  approvalsDirectory,
} from "../../cli-signal/approval-protocol";
import { SONATA_INTERPRETER_PREFIX } from "../../interpreter";

/**
 * The Codex injection edge (control-plane S2) — the mirror of
 * `cli-signal/claude-runtime-settings.ts` in ROLE, not mechanism.
 *
 * D4 OVERTURNED (2026-07-06): the "one-time trust ceremony survives every task /
 * app update" framing below is MOOT. Field use proved codex does NOT persist
 * hook trust for a `-p sonata` PROFILE layer (only User/SessionFlags layers can),
 * so Sonata passes `--dangerously-bypass-hook-trust` on every spawn (in
 * `codexArgs`). The stable shim path still matters — it keeps the hook COMMAND
 * HASH constant so the bypassed hooks stay identical — but it no longer persists
 * a trust grant. Wherever the comments below say "trust ceremony persists," read
 * "shim stays hash-stable." Research: `spikes/codex-hook-trust-research/`.
 *
 * Codex GA'd a hook system that clones Claude Code's hook contract
 * field-for-field (verified 2026-07-06, codex-cli 0.142.5), but its injection
 * seam and trust model differ, so this edge is Codex-specific:
 *
 *  - Injection is a Sonata-named PROFILE FILE, `$CODEX_HOME/sonata.config.toml`,
 *    layered onto the user's own config by `codex -p sonata` (CONFIG_PROFILE_V2).
 *    Additive and inert: Sonata writes ONLY this file; the user's config.toml,
 *    MCP servers, auth, trust, and history are never touched, and nothing fires
 *    unless Sonata passes `-p sonata`. Profile `[hooks]` UNION with the user's own
 *    hooks both ways (verified) — no clobber.
 *  - Trust binds to the EXACT hook command string, and untrusted/misconfigured
 *    hooks are SILENTLY skipped (probe hazard). So every command routes through
 *    a STABLE shim path (`<binDir>/codex-*-shim.js`) whose text is
 *    task-invariant: the one-time Codex trust ceremony then survives every task
 *    and every app update. Per-task binding travels via the `SONATA_RUNTIME_DIR`
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

/** The stable shim home (`sonataBinDir()`, e.g. `~/.sonata/bin`) — the ONE input
 *  the controller supplies, because Sonata-home is the controller's path truth.
 *  The profile file location is THIS module's truth (codexProfilePath). */
export interface CodexHookPaths {
  binDir: string;
  /** The cwd to add to the trust ledger for this spawn, or null/absent to add
   *  none. POLICY (which cwds qualify) lives in the controller; this module is
   *  mechanism only — it records what it is given and governs carry-forward. */
  pretrustCwd?: string | null;
}

/** The profile name Sonata layers via `codex -p <name>`. */
export const CODEX_SONATA_PROFILE = "sonata";

/** Shim filenames — part of the FROZEN command strings; never rename without
 *  accepting a Codex re-trust for every user. */
const SINK_SHIM = "codex-hook-sink.js";
const BROKER_SHIM = "codex-approval-broker.js";

/** The sink subdir under a task's runtime dir — single-sourced so the two
 *  path helpers AND the shim template agree by construction. The approvals
 *  subdir + broker file prefixes come from the shared `approval-protocol`
 *  module (interpolated into the broker shim below) so the Codex broker can
 *  never desync from the Claude broker / the ApprovalWatcher. */
const HOOKS_SUBDIR = "hooks";

/** The marker file Sonata drops in a task's approvals dir to arm the broker shim's
 *  hold-and-answer path. Absent (S2, or any task whose card wiring is not live)
 *  → the broker exits 0 with no output → Codex's native card shows instantly.
 *  Present (S3, once Sonata is watching the task's approvals) → the broker holds
 *  and answers from Sonata's reply file. Single-sourced: the shim template
 *  interpolates it, and `codex-approvals.ts` reuses it to write/clear the marker,
 *  so the two can never drift. */
export const CODEX_ANSWERING_MARKER = "answering-enabled";

/**
 * How long the broker HOLDS the CLI waiting for Sonata's card answer before giving
 * up to Codex's native card. INDEPENDENT of the Claude broker's hold (580s since
 * drawer S0) — do NOT re-sync them: this 60s sits under the frozen hook
 * `timeout` (120s), and that 120 is part of the exact trusted command definition
 * (ARCHITECTURE.md hook-trust) — raising it silently untrusts the hook. Extending
 * the codex hold needs its own probe (timeout semantics + re-trust path) first.
 * The frozen timeout sits comfortably above the hold so Codex never kills the
 * broker mid-poll (which would read as a crash, not a graceful fallback). The
 * shim reads an optional `SONATA_BROKER_HOLD_MS` env override (same env-binding
 * rationale as `SONATA_RUNTIME_DIR`; used by tests, never changes the trusted
 * command string), falling back to this default. */
const APPROVAL_BROKER_HOLD_MS = 60_000;

/**
 * The Sonata Codex hook profile file — an ADDITIVE, Sonata-named file inside the
 * user's Codex home, layered by `codex -p sonata`. Honors `$CODEX_HOME` (so the
 * user's real Codex world is respected, and tests/live-passes can isolate to a
 * temp home) and defaults to `~/.codex`. Sonata writes ONLY this file; the user's
 * own `config.toml` is never read or modified. This module owns the resolution
 * (the declared owner of Codex path truth).
 */
export function codexProfilePath(): string {
  const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(home, "sonata.config.toml");
}

/** Fire-and-forget sink events (the events Codex emits and Sonata's watcher
 *  consumes). PermissionRequest is DELIBERATELY absent — it is owned by the
 *  broker shim (a second sink on it would double-write the payload).
 *
 *  The five core events are the run-lifecycle spine. `SubagentStart` /
 *  `SubagentStop` (verified firing under this injection at 0.144.4, S6) feed the
 *  status-strip agent roster: Codex subagents run in their OWN rollout files, so
 *  the parent rollout the normalizer tails never shows them — these hooks are the
 *  only source. `PreCompact` / `PostCompact` (verified firing under this injection
 *  at 0.144.4, P2) are registered for signal completeness: they flow to the sink
 *  like every other event. Sonata does NOT consume them today — the Reading
 *  compaction marker is TRANSCRIPT-derived (the rollout's `compacted` record), so
 *  it survives resume/replay where an ephemeral hook could not. `Notification` /
 *  `StopFailure` stay unregistered (Claude-only, no Codex equivalent). */
const SINK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
] as const;

/**
 * The broker's hook `timeout` (seconds). It must exceed the broker's internal
 * hold ceiling so Codex never kills it mid-decision (S3 concern); in S2 the
 * broker is inert and returns instantly, but the FROZEN definition already
 * carries the final timeout so S3 needs no definition edit (which would
 * re-trigger trust).
 */
const APPROVAL_HOOK_TIMEOUT_S = 120;

/**
 * Hard ceiling on the shim's hold, regardless of the `SONATA_BROKER_HOLD_MS`
 * override. The override is env-delivered (tests use it), but an env var
 * inherited into production above the frozen hook `timeout` (120s) would let
 * Codex KILL the hook mid-poll BEFORE the shim writes `expired-<id>.json` — no
 * graceful native-card takeover, the card wedges. Clamp 20s below the hook
 * timeout so the shim always reaches its own expiry + cleanup first. Shim BYTES
 * only — the frozen command string (what trust binds to) is untouched.
 */
const APPROVAL_BROKER_HOLD_CEILING_MS = (APPROVAL_HOOK_TIMEOUT_S - 20) * 1000;

/** Path the sink drops `hook-*.json` into, under a task's runtime dir. The
 *  shim derives this from `SONATA_RUNTIME_DIR` — same layout Claude's sink
 *  writes, so the same HookWatcher consumes both. */
export function codexHooksDirectory(runtimeDir: string): string {
  return path.join(runtimeDir, HOOKS_SUBDIR);
}

/** Path the broker uses for ask/reply/expired/marker files (S3). Delegates to
 *  the shared neutral resolver — the approvals layout is a protocol constant. */
export function codexApprovalsDirectory(runtimeDir: string): string {
  return approvalsDirectory(runtimeDir);
}

/**
 * Ensure the Sonata Codex profile + shims exist and are current (write-if-changed
 * on all three files). The shims are task-invariant (they read their per-task
 * binding from the environment). The profile is CONVERGENT, not task-invariant:
 * its hook blocks depend only on `binDir`, but its trust ledger also depends on
 * the existing on-disk profile and `pretrustCwd`. Same inputs (binDir, existing
 * ledger state, pretrustCwd) → same bytes, so write-if-changed still holds and
 * the trust ceremony stays one-time; concurrent spawns each fold their own cwd
 * into the accumulating ledger rather than clobbering the last spawn's entry.
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
  const existing = readProfileIfExists(profilePath);
  writeIfChanged(profilePath, buildProfileToml(paths.binDir, existing, paths.pretrustCwd ?? null));
}

/** The current profile bytes, or "" when absent/unreadable — the ledger's
 *  carry-forward source. Never throws: a missing profile is the first-spawn
 *  case, and an unreadable one degrades to an empty ledger (write-if-changed
 *  then rewrites it). */
function readProfileIfExists(profilePath: string): string {
  try {
    return fs.readFileSync(profilePath, "utf8");
  } catch {
    return "";
  }
}

/** The frozen command strings the user trusts once:
 *  `ELECTRON_RUN_AS_NODE=1 "${SONATA_NODE:-node}" "<abs path>"`. The shim path is
 *  double-quoted so a homedir with spaces is shell-safe; the interpreter is
 *  Sonata's own Electron-as-node via the env-keyed `${SONATA_NODE:-node}` (never
 *  an absolute interpreter path), so the command string stays stable across app
 *  updates and machines — the whole point of the stable-shim design — while no
 *  longer depending on an undeclared host `node`. See SONATA_INTERPRETER_PREFIX
 *  for the full rationale (ships-our-own-runtime, version pinning, fallback). */
function sinkCommand(binDir: string): string {
  return `${SONATA_INTERPRETER_PREFIX} "${guardShimPath(path.join(binDir, SINK_SHIM))}"`;
}

function brokerCommand(binDir: string): string {
  return `${SONATA_INTERPRETER_PREFIX} "${guardShimPath(path.join(binDir, BROKER_SHIM))}"`;
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
function buildProfileToml(binDir: string, existingProfile: string, pretrustCwd: string | null): string {
  const header = [
    "# Sonata-managed Codex hook profile — DO NOT EDIT (regenerated by Sonata).",
    "#",
    "# Additive: `codex -p sonata` layers this onto your own ~/.codex/config.toml",
    "# (union, never clobber). Sonata writes ONLY this file; your config, MCP",
    "# servers, auth, and session history are untouched.",
    "#",
    "# Sonata registers the events it consumes (run lifecycle + subagent roster +",
    "# the PermissionRequest broker). Adding an event rewrites this file, but that",
    "# is safe: Sonata spawns with --dangerously-bypass-hook-trust (D4), so a changed",
    "# hook-trust hash never re-prompts. Commands route through stable ~/.sonata/bin",
    "# shims run by Sonata's own bundled runtime (ELECTRON_RUN_AS_NODE=1 with",
    "# ${SONATA_NODE:-node}), so no host Node install is required; per-task binding",
    "# travels via the SONATA_RUNTIME_DIR environment variable, so these command",
    "# strings stay identical across every task and machine.",
    "",
  ];
  const blocks: string[] = [];
  for (const event of SINK_EVENTS) {
    blocks.push(hookBlock(event, sinkCommand(binDir), null));
  }
  blocks.push(hookBlock("PermissionRequest", brokerCommand(binDir), APPROVAL_HOOK_TIMEOUT_S));
  // Hook blocks stay byte-identical to a ledger-less profile; the ledger is a
  // separate, deterministically-emitted section appended after them.
  return `${header.join("\n")}\n${blocks.join("\n")}${buildTrustLedger(existingProfile, pretrustCwd)}`;
}

/**
 * The trust-ledger section: `[projects."<path>"] trust_level = "trusted"` entries
 * that suppress codex's directory-trust dialog for a `-p sonata` boot. Governed by
 * regeneration:
 *  - carry forward every EXISTING entry whose directory still exists on disk —
 *    human grants (dialog answers codex appended here) survive; dead task/temp
 *    dirs self-prune;
 *  - add this spawn's `pretrustCwd` when the controller's policy said so;
 *  - sort by path and emit deterministically, so the same inputs converge on the
 *    same bytes.
 * Empty ledger → empty string, so a profile with nothing to trust is byte-identical
 * to the pre-ledger output.
 */
function buildTrustLedger(existingProfile: string, pretrustCwd: string | null): string {
  const paths = new Set<string>();
  for (const existing of parseTrustedProjectPaths(existingProfile)) {
    // Prune ONLY when the path is gone; keep every entry that still exists,
    // whatever created it — human grants are sacred.
    if (fs.existsSync(existing)) {
      paths.add(existing);
    }
  }
  if (pretrustCwd) {
    paths.add(pretrustCwd);
  }
  if (paths.size === 0) {
    return "";
  }
  const comment = [
    "",
    "# Trust ledger — project directories Sonata pre-trusts so a `codex -p sonata`",
    "# boot skips the directory-trust dialog. Governed by regeneration: an entry",
    "# survives only while its directory exists on disk (grants codex appended here",
    "# are preserved; dead task/temp dirs self-prune). Sorted and emitted",
    "# deterministically — same inputs, same bytes.",
    "",
  ];
  const entries = [...paths].sort().map(projectTrustBlock);
  return `${comment.join("\n")}\n${entries.join("\n")}`;
}

/** One `[projects."<path>"]` / `trust_level = "trusted"` block. The path is a TOML
 *  basic string via `JSON.stringify` (double-quoted, escape-safe) — the exact form
 *  codex itself writes. */
function projectTrustBlock(dirPath: string): string {
  return `[projects.${JSON.stringify(dirPath)}]\ntrust_level = "trusted"\n`;
}

/**
 * Parse the trusted-project paths out of an existing profile, tolerating the form
 * codex itself appends (`[projects."<abs path>"]` newline `trust_level = "trusted"`).
 * Preserve ONLY entries that carry `trust_level = "trusted"`; anything else (an
 * untrusted level, a shape we don't recognize, an unparseable key) is dropped from
 * carry-forward rather than guessed at.
 */
function parseTrustedProjectPaths(profile: string): string[] {
  const lines = profile.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^\[projects\.(.+)\]\s*$/.exec(lines[i] ?? "");
    if (!header?.[1]) {
      continue;
    }
    const dirPath = parseTomlBasicKey(header[1]);
    if (dirPath === null) {
      continue;
    }
    // A `[projects."..."]` table's body runs until the next section header.
    let trusted = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j] ?? "";
      if (/^\s*\[/.test(line)) {
        break;
      }
      if (/^\s*trust_level\s*=\s*"trusted"\s*$/.test(line)) {
        trusted = true;
      }
    }
    if (trusted) {
      out.push(dirPath);
    }
  }
  return out;
}

/** A `[projects.<key>]` header's key as codex writes it — a double-quoted TOML
 *  basic string (JSON-compatible escaping). Returns null for any other shape
 *  (e.g. a literal-string key) so the caller drops it rather than guessing. */
function parseTomlBasicKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return null;
  }
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
// These are the exact bytes Sonata writes to the stable shim paths. They are
// plain CommonJS Node scripts (invoked via the SONATA_INTERPRETER_PREFIX shape,
// `ELECTRON_RUN_AS_NODE=1 "${SONATA_NODE:-node}" "<path>"`), self-contained so the
// TRUSTED TEXT is decoupled from any refactor of the Claude-side sink. Trust
// binds to the profile's command STRING, not these bytes, so Sonata may refresh
// the content freely (S3 rewrites the broker); the command string never changes.

/** Reads the hook payload (JSON) on stdin and writes it as ONE uniquely-named
 *  file into `$SONATA_RUNTIME_DIR/hooks` via tmp+rename — the exact protocol of
 *  `cli-signal/hook-sink.ts`, but keyed by env (task-invariant argv). Exit 0
 *  always; observation must never block the CLI's turn. */
const SINK_SHIM_SOURCE = `"use strict";
// Sonata Codex hook sink — FROZEN shim (control plane S2). Task binding arrives
// via the SONATA_RUNTIME_DIR env var (hooks inherit the spawn env), never argv,
// so the command string this file is invoked by stays task-invariant and the
// one-time Codex trust ceremony persists. Regenerated by Sonata at spawn-prep.
const fs = require("node:fs");
const path = require("node:path");
const runtimeDir = process.env.SONATA_RUNTIME_DIR;
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

/** S3: the hold-and-answer broker. Reads the PermissionRequest payload on stdin;
 *  if Sonata has armed answering for this task (the answering-enabled marker
 *  exists in `$SONATA_RUNTIME_DIR/approvals/`), it surfaces `ask-<id>.json`, holds
 *  the CLI polling for `reply-<id>.json`, and prints the decision JSON to stdout
 *  on reply (Codex's structured answer channel) — the exact protocol of
 *  `cli-signal/approval-broker.ts`, but keyed by env (task-invariant argv). On
 *  timeout it writes `expired-<id>.json` and exits 0 with NO output → Codex
 *  renders its native card (graceful fallback, probe-verified). Absent marker →
 *  exit 0 immediately (instant native card, zero stall). Never writes stderr; a
 *  broker failure must never block or corrupt the CLI's turn. The command string
 *  this file is invoked by is FROZEN; only these BYTES change, so no re-trust. */
const BROKER_SHIM_SOURCE = `"use strict";
// Sonata Codex approval broker — FROZEN command, refreshable content (control
// plane S3). The profile registers this on PermissionRequest with a timeout;
// that command string is what the one-time trust ceremony binds to and never
// changes. This file's BYTES, however, Sonata refreshes freely. Task binding +
// control dir arrive via the SONATA_RUNTIME_DIR env var (hooks inherit the spawn
// env), never argv, so the command string stays task-invariant. Regenerated by
// Sonata at spawn-prep.
const fs = require("node:fs");
const path = require("node:path");
const runtimeDir = process.env.SONATA_RUNTIME_DIR;
const POLL_MS = ${APPROVAL_POLL_MS};
const holdMs = Math.min(
  Number(process.env.SONATA_BROKER_HOLD_MS) || ${APPROVAL_BROKER_HOLD_MS},
  ${APPROVAL_BROKER_HOLD_CEILING_MS},
);
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) { raw += chunk; });
process.stdin.on("end", function () {
  if (!runtimeDir) { process.exit(0); }
  const controlDir = path.join(runtimeDir, "${APPROVALS_SUBDIR}");
  let answering = false;
  try {
    answering = fs.existsSync(path.join(controlDir, "${CODEX_ANSWERING_MARKER}"));
  } catch (_e) {
    answering = false;
  }
  if (!answering) {
    // No card wiring live for this task: no stdout → Codex renders its native
    // approval card instantly, zero stall.
    process.exit(0);
  }
  let payload = {};
  try { payload = JSON.parse((raw || "").trim() || "{}"); } catch (_e) { payload = { parseError: true }; }
  // Sortable, collision-free id across concurrent brokers (parallel tool
  // approvals): wall clock + hrtime + pid.
  const id = Date.now().toString(36) + "-" + process.hrtime.bigint().toString(36) + "-" + process.pid;
  const askPath = path.join(controlDir, "${ASK_PREFIX}" + id + ".json");
  const replyPath = path.join(controlDir, "${REPLY_PREFIX}" + id + ".json");
  const expiredPath = path.join(controlDir, "${EXPIRED_PREFIX}" + id + ".json");
  const answeredPath = path.join(controlDir, "${ANSWERED_PREFIX}" + id + ".json");
  function writeAtomic(filePath, contents) {
    const tmp = filePath + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, contents, "utf8");
    fs.renameSync(tmp, filePath);
  }
  function readReply() {
    try { return fs.existsSync(replyPath) ? fs.readFileSync(replyPath, "utf8") : null; } catch (_e) { return null; }
  }
  function answer(decision) {
    // The ask cleanup MUST be independent of the audit write: if writeAtomic
    // throws (ENOSPC), a nested rmSync would be skipped → the ask-<id>.json
    // lingers and Sonata's card never clears. Each step gets its own try.
    try { writeAtomic(answeredPath, decision); } catch (_e) { /* audit best-effort */ }
    try { fs.rmSync(replyPath, { force: true }); } catch (_e) { /* best-effort */ }
    try { fs.rmSync(askPath, { force: true }); } catch (_e) { /* best-effort */ }
    process.stdout.write(decision);
    process.exit(0);
  }
  try {
    fs.mkdirSync(controlDir, { recursive: true });
    writeAtomic(askPath, JSON.stringify({ id: id, receivedAt: new Date().toISOString(), payload: payload }));
  } catch (_e) {
    // Could not surface the ask → fall back to the native card immediately.
    process.exit(0);
  }
  const deadline = Date.now() + holdMs;
  const timer = setInterval(function () {
    const decision = readReply();
    if (decision !== null) {
      clearInterval(timer);
      answer(decision);
    }
    if (Date.now() > deadline) {
      clearInterval(timer);
      // FINAL reply check before giving up: a reply written in the poll gap must
      // still win, else Sonata records an answer the CLI never received and the turn
      // wedges (reviewer C2). Mirrors approval-broker.ts.
      const late = readReply();
      if (late !== null) { answer(late); }
      // Cleanup independent of the marker write (see answer()): the ask must be
      // removed even if writeAtomic throws, or the card never clears.
      try { writeAtomic(expiredPath, "{}"); } catch (_e) { /* best-effort */ }
      try { fs.rmSync(askPath, { force: true }); } catch (_e) { /* best-effort */ }
      process.exit(0); // no stdout → Codex renders its native card
    }
  }, POLL_MS);
  // NOTE: deliberately NOT unref'd — the interval must keep the event loop alive
  // until the broker decides or times out.
});
`;
