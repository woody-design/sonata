import os from "node:os";
import path from "node:path";

/**
 * The single source of truth for Sonata's on-disk home.
 *
 * Everything Sonata owns and hides — per-task records, the Claude runtime sink,
 * attachment blobs, global config, caches, logs — lives under ONE root computed
 * HERE and nowhere else. Never hardcode "~/.sonata" elsewhere: a rename stays a
 * one-constant change ONLY while this remains the lone place the root is named.
 * (Proven by the 2026-07-17 Duet→Sonata rename: no startup-relocation code —
 * the old ~/.duet home moves in a one-shot external migration at cutover; see
 * product-thinking/2026-07-17-sonata-cutover-runbook.md.)
 *
 * Resolution (highest precedence first):
 *   1. SONATA_DATA_DIR — explicit override. The workshop launcher sets it to keep
 *      dev data isolated from the daily driver; tests set it to a scratch dir; a
 *      future rename's migration would set it. Also the P7 escape hatch.
 *   2. ~/.sonata — the default home, a sibling of ~/.claude and ~/.codex.
 *
 * Deliberately env-driven (not derived from the Electron app name): it matches
 * how the two worktrees already isolate themselves (SONATA_DATA_DIR,
 * SONATA_SETTINGS_DIR, --user-data-dir set per launch) and keeps this module pure
 * Node — callable from tests and the main process without importing electron.
 */
export function sonataDataRoot(): string {
  const override = process.env.SONATA_DATA_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".sonata");
}

// ── Top-level lifecycle separation: config / data / cache / logs (P2) ────────
// All Sonata-owned and hidden, split by lifecycle so backup / cleanup / portability
// can treat each differently: config is precious + portable, data is precious +
// machine-local, cache is disposable, logs are diagnostic.

/** Global preferences (the small JSON settings stores). Precious, portable. */
export function sonataConfigDir(): string {
  return path.join(sonataDataRoot(), "config");
}

/** Disposable derived artifacts (thumbnails, etc.). Safe to delete anytime. */
export function sonataCacheDir(): string {
  return path.join(sonataDataRoot(), "cache");
}

/** Diagnostic logs. */
export function sonataLogsDir(): string {
  return path.join(sonataDataRoot(), "logs");
}

/**
 * Stable executable-shim home (Codex control plane, S2). The Codex hook
 * profile registers `node <this dir>/codex-*-shim.js` command strings. These
 * paths are task-invariant and homedir-stable (rooted at sonataDataRoot(), per
 * the one-root rule above) so the hook command hash stays constant — Sonata
 * refreshes the shim FILE bytes freely (the command string, not the script
 * contents, is what the profile names), and the path never moves. (D4
 * overturned 2026-07-06: this stability once aimed to persist a trust grant;
 * codex doesn't persist trust for a profile layer, so Sonata bypasses trust —
 * the stability now only keeps the bypassed hooks byte-identical.) Task binding
 * travels via the SONATA_RUNTIME_DIR env var the shims read at runtime, never argv.
 */
export function sonataBinDir(): string {
  return path.join(sonataDataRoot(), "bin");
}

// ── Per-task data, keyed by taskId (P3/P4: identity, never a decoded name) ────

/** Parent of every task's record dir; the scan root for the session index. */
export function projectsDataDir(): string {
  return path.join(sonataDataRoot(), "data", "projects");
}

/**
 * A task's record dir: task.json, runtime-report.json, transcript-sources.json.
 * Sonata-owned bookkeeping — NEVER the agent's working directory (that is the
 * user's visible work, kept cleanly separate; see D7). Replaces the old
 * `storageRoot`, whose double duty (records AND cwd) this layout dissolves.
 */
export function projectRecordRoot(taskId: string): string {
  return path.join(projectsDataDir(), taskId);
}

/**
 * A Claude session's runtime sink: hooks/, usage/, claude-runtime-settings.json.
 * Moved out of the agent's providerCwd (D8) so Sonata writes nothing into the
 * user's repo. Regenerable per session; --settings and the hook command carry
 * this absolute path and the watchers poll it (G1 verified Claude fires hooks
 * from a --settings file located outside the agent cwd).
 */
export function runtimeDir(taskId: string): string {
  return path.join(sonataDataRoot(), "data", "runtime", taskId);
}

/**
 * A task's materialized attachment blobs (D6). Sonata-owned; pasted bitmaps are
 * copied here, referenced files are never copied.
 */
export function attachmentsRootForTask(taskId: string): string {
  return path.join(sonataDataRoot(), "data", "attachments", taskId);
}
