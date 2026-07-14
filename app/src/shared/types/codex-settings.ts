import type { CodexApprovalMode } from "./domain";

/**
 * Duet-owned launch policy for Codex sessions (the Duet mirror of
 * `ClaudeSettings` — this is Duet's standing default, not Codex's own
 * config). `defaultApprovalMode` is the approval policy new Codex sessions
 * launch with, so a user who trusts the direction can set it once instead
 * of answering every command.
 *
 * The offered pool excludes `on-failure`: Codex 0.144 marks it deprecated in
 * its docs. It stays a valid PERSISTED value, though — a user who set it
 * before keeps launching with `-a on-failure` (still parses) and the Settings
 * UI renders their stored value as a legacy entry until they pick another.
 * Offered pool and persistable union are therefore deliberately distinct.
 */
export const CODEX_DEFAULT_APPROVAL_MODE_OPTIONS = [
  "untrusted",
  "on-request",
  "never",
] as const satisfies readonly CodexApprovalMode[];

export type CodexDefaultApprovalMode =
  (typeof CODEX_DEFAULT_APPROVAL_MODE_OPTIONS)[number];

/** Every `-a` value Duet will persist and spawn with, including the deprecated
 *  `on-failure` (kept for back-compat). Superset of the offered pool. */
const CODEX_PERSISTABLE_APPROVAL_MODES = [
  "untrusted",
  "on-request",
  "on-failure",
  "never",
] as const satisfies readonly CodexApprovalMode[];

export interface CodexSettings {
  defaultApprovalMode: CodexApprovalMode;
}

export const DEFAULT_CODEX_SETTINGS: CodexSettings = {
  // Codex's own default; matches the value Duet hardcoded before this store
  // existed, so an un-set store is behaviour-neutral.
  defaultApprovalMode: "on-request",
};

/** True for a value the Settings menu currently OFFERS (excludes the
 *  deprecated `on-failure`). Drives the "(legacy)" marking of a stored value. */
export function isCodexDefaultApprovalMode(
  value: unknown,
): value is CodexDefaultApprovalMode {
  return CODEX_DEFAULT_APPROVAL_MODE_OPTIONS.includes(
    value as CodexDefaultApprovalMode,
  );
}

/** True for any value Duet will persist and spawn with (offered pool +
 *  deprecated `on-failure`). Normalize validates against THIS so a pre-existing
 *  `on-failure` default is never silently rewritten. */
export function isCodexPersistableApprovalMode(
  value: unknown,
): value is CodexApprovalMode {
  return CODEX_PERSISTABLE_APPROVAL_MODES.includes(value as CodexApprovalMode);
}

export function normalizeCodexSettings(value: unknown): CodexSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_CODEX_SETTINGS };
  }
  return {
    defaultApprovalMode: isCodexPersistableApprovalMode(value.defaultApprovalMode)
      ? value.defaultApprovalMode
      : DEFAULT_CODEX_SETTINGS.defaultApprovalMode,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
