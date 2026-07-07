import type { CodexApprovalMode } from "./domain";

/**
 * Duet-owned launch policy for Codex sessions (the Duet mirror of
 * `ClaudeSettings` — this is Duet's standing default, not Codex's own
 * config). `defaultApprovalMode` is the approval policy new Codex sessions
 * launch with, so a user who trusts the direction can set it once instead
 * of answering every command.
 *
 * All four of Codex's official `--ask-for-approval` (`-a`) values are
 * exposed as standing options — unlike Claude, none of them is a gated
 * power mode, so the whole vocabulary is a coherent everyday default.
 */
export const CODEX_DEFAULT_APPROVAL_MODE_OPTIONS = [
  "untrusted",
  "on-request",
  "on-failure",
  "never",
] as const satisfies readonly CodexApprovalMode[];

export type CodexDefaultApprovalMode =
  (typeof CODEX_DEFAULT_APPROVAL_MODE_OPTIONS)[number];

export interface CodexSettings {
  defaultApprovalMode: CodexDefaultApprovalMode;
}

export const DEFAULT_CODEX_SETTINGS: CodexSettings = {
  // Codex's own default; matches the value Duet hardcoded before this store
  // existed, so an un-set store is behaviour-neutral.
  defaultApprovalMode: "on-request",
};

export function isCodexDefaultApprovalMode(
  value: unknown,
): value is CodexDefaultApprovalMode {
  return CODEX_DEFAULT_APPROVAL_MODE_OPTIONS.includes(
    value as CodexDefaultApprovalMode,
  );
}

export function normalizeCodexSettings(value: unknown): CodexSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_CODEX_SETTINGS };
  }
  return {
    defaultApprovalMode: isCodexDefaultApprovalMode(value.defaultApprovalMode)
      ? value.defaultApprovalMode
      : DEFAULT_CODEX_SETTINGS.defaultApprovalMode,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
