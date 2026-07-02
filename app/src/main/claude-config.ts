import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The single write path for `~/.claude.json` — the user's REAL, daily-driver
 * Claude config, shared with every claude process on the machine. Duet makes
 * exactly two kinds of edits (the resume-bridge revert and the project-trust
 * pre-write), and both flow through `updateClaudeConfig` so the safety rules
 * live in one place:
 *
 * - **Backup-once**: before Duet's first-ever write, the exact bytes the
 *   mutation was computed from are copied to `<config>.duet-bak` and verified.
 *   An existing backup is never overwritten — it stays the oldest pre-Duet
 *   recovery point.
 * - **Atomic**: tmp file + rename; the config is never open for in-place edit.
 * - **Concurrent-writer aware**: the CLI rewrites this file whole (last-writer
 *   wins, its own convention). If the file changes between our read and our
 *   write, the mutation is recomputed from a fresh read — once; a second
 *   conflict aborts rather than racing.
 * - **Format-faithful**: the CLI serializes with `JSON.stringify(_, null, 2)`
 *   and no trailing newline; writing the same format keeps every byte outside
 *   the mutated key identical (verified against the real 258KB config).
 * - **Never creates the file**: a missing or unparseable config means claude's
 *   own state is not what we understand — degrade to the caller's fallback
 *   (for trust, the native dialog) instead of guessing.
 */

export interface ClaudeConfigWriteOptions {
  /** Test seam; defaults to the real `~/.claude.json`. */
  configPath?: string;
  /** Backup destination; `null` disables. Defaults to `<configPath>.duet-bak`. */
  backupPath?: string | null;
}

export interface ClaudeConfigUpdateResult {
  applied: boolean;
  reason:
    | "written"
    | "no-change"
    | "config-missing"
    | "config-invalid"
    | "conflict"
    | "write-failed";
  /** True when this write created the backup (first Duet write ever). */
  backupCreated: boolean;
}

export function defaultClaudeConfigPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

/**
 * Read-modify-write `~/.claude.json` under the rules above. `mutate` receives
 * the parsed config and returns whether it changed anything; returning false
 * skips the write entirely (idempotence is the mutator's contract). The
 * mutator may run twice (conflict retry) — it must be pure over its input.
 */
export function updateClaudeConfig(
  mutate: (config: Record<string, unknown>) => boolean,
  options: ClaudeConfigWriteOptions = {},
): ClaudeConfigUpdateResult {
  const configPath = options.configPath ?? defaultClaudeConfigPath();
  const backupPath =
    options.backupPath === null ? null : (options.backupPath ?? `${configPath}.duet-bak`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw: string;
    let statBefore: fs.Stats;
    try {
      statBefore = fs.statSync(configPath);
      raw = fs.readFileSync(configPath, "utf8");
    } catch {
      return { applied: false, reason: "config-missing", backupCreated: false };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { applied: false, reason: "config-invalid", backupCreated: false };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { applied: false, reason: "config-invalid", backupCreated: false };
    }

    if (!mutate(parsed as Record<string, unknown>)) {
      return { applied: false, reason: "no-change", backupCreated: false };
    }

    try {
      // Back up the exact bytes this mutation was computed from, then verify
      // the copy landed before the original is touched.
      let backupCreated = false;
      if (backupPath && !fs.existsSync(backupPath)) {
        fs.writeFileSync(backupPath, raw, "utf8");
        if (fs.readFileSync(backupPath, "utf8") !== raw) {
          return { applied: false, reason: "write-failed", backupCreated: false };
        }
        backupCreated = true;
      }

      // The CLI may have rewritten the file while we worked on the snapshot —
      // renaming over its write would silently revert it. Recompute instead.
      let statNow: fs.Stats;
      try {
        statNow = fs.statSync(configPath);
      } catch {
        return { applied: false, reason: "config-missing", backupCreated };
      }
      if (statNow.mtimeMs !== statBefore.mtimeMs || statNow.size !== statBefore.size) {
        continue;
      }

      const tempPath = `${configPath}.duet-tmp-${process.pid}`;
      fs.writeFileSync(tempPath, JSON.stringify(parsed, null, 2), "utf8");
      fs.renameSync(tempPath, configPath);
      return { applied: true, reason: "written", backupCreated };
    } catch {
      return { applied: false, reason: "write-failed", backupCreated: false };
    }
  }

  return { applied: false, reason: "conflict", backupCreated: false };
}

/**
 * The projects-map key claude actually checks: the realpath of the cwd.
 * Evidence: every temp-dir entry claude itself writes is keyed
 * `/private/var/...`, never `/var/...` (macOS), matching the realpath keying
 * of `~/.claude/projects` (session-locator).
 */
export function claudeProjectKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export interface EnsureProjectTrustResult extends ClaudeConfigUpdateResult {
  /** The projects-map key that was checked / written. */
  projectKey: string;
}

/**
 * Pre-grant folder trust for a workspace the user designated in Duet's own UI
 * (two-window contract §2: the folder-designating gesture IS the consent —
 * the native "do you trust this folder?" dialog is redundant for it, so it is
 * eliminated, not mirrored).
 *
 * Writes the minimal flag claude checks — `hasTrustDialogAccepted: true` —
 * into `projects[realpath(cwd)]`, merging with any existing entry (a previous
 * explicit decline stored `false`; a fresh pick is fresh consent and overrides
 * it). 155+ of the real config's project entries carry exactly this one flag
 * and never prompt (S4 phase-0 survey), so no onboarding companions are
 * written. No-ops when the entry is already trusted.
 */
export function ensureClaudeProjectTrust(
  cwd: string,
  options: ClaudeConfigWriteOptions = {},
): EnsureProjectTrustResult {
  const projectKey = claudeProjectKey(cwd);
  const result = updateClaudeConfig((config) => {
    const existing = config.projects;
    if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
      // A projects map we don't understand — leave the file alone; the
      // native dialog (scrape fallback) handles trust for this session.
      return false;
    }
    const projects = (existing ?? {}) as Record<string, unknown>;
    const entry = projects[projectKey];
    const entryRecord =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    if (entryRecord.hasTrustDialogAccepted === true) {
      return false;
    }
    projects[projectKey] = { ...entryRecord, hasTrustDialogAccepted: true };
    config.projects = projects;
    return true;
  }, options);
  return { ...result, projectKey };
}
