import type { ClaudePermissionMode } from "./domain";

/**
 * Duet-owned launch policy for Claude sessions (NOT Claude's own state —
 * this never touches ~/.claude.json). `defaultPermissionMode` is the mode
 * new Claude sessions launch in, so a user who trusts the direction can
 * set it once instead of approving every tool call.
 *
 * The exposed standing options mirror Claude's official Shift+Tab cycle
 * minus `plan` (read-only is a momentary mode, an odd standing default)
 * and minus the gated power modes (`bypassPermissions` needs the native
 * dangerous-mode opt-in; `dontAsk` is a CI/allowlist mode). Those stay out
 * of the everyday default until they earn a deliberately-gated home.
 */
export const CLAUDE_DEFAULT_PERMISSION_MODE_OPTIONS = [
  "default",
  "acceptEdits",
  "auto",
] as const satisfies readonly ClaudePermissionMode[];

export type ClaudeDefaultPermissionMode =
  (typeof CLAUDE_DEFAULT_PERMISSION_MODE_OPTIONS)[number];

export interface ClaudeSettings {
  defaultPermissionMode: ClaudeDefaultPermissionMode;
}

export const DEFAULT_CLAUDE_SETTINGS: ClaudeSettings = {
  defaultPermissionMode: "default",
};

export function isClaudeDefaultPermissionMode(
  value: unknown,
): value is ClaudeDefaultPermissionMode {
  return CLAUDE_DEFAULT_PERMISSION_MODE_OPTIONS.includes(
    value as ClaudeDefaultPermissionMode,
  );
}

export function normalizeClaudeSettings(value: unknown): ClaudeSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_CLAUDE_SETTINGS };
  }
  return {
    defaultPermissionMode: isClaudeDefaultPermissionMode(value.defaultPermissionMode)
      ? value.defaultPermissionMode
      : DEFAULT_CLAUDE_SETTINGS.defaultPermissionMode,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
