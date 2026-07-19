import type { ClaudePermissionMode, ReasoningEffort } from "./domain";
import { isReasoningEffort } from "./domain";

/**
 * Sonata-owned launch policy for Claude sessions (NOT Claude's own state —
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
  /** Start new Claude sessions with Remote Control on (spawn `--remote-control`),
   *  so they come up phone-reachable without arming each one by hand. */
  defaultRemoteControl: boolean;
  /** The model new Claude sessions start on (copy-at-entry: seeded into the New
   *  Chat draft, never retro-applied to an open draft). A CONCRETE alias, never
   *  null — the settings picker excludes "Native Default" (per-session only). The
   *  fallback is today's hardcoded launch model, so existing installs see no
   *  drift. Validated by string presence only here; the CLI tolerates any alias
   *  at launch and the settings menu is the enforcement point. */
  defaultModel: string;
  /** The reasoning effort new Claude sessions start on (copy-at-entry twin of
   *  `defaultModel`). Validated by `ReasoningEffort` union membership only; the
   *  per-model gating (which tiers a model can accept) is clamped at the UI and
   *  at draft seeding, not here (layer fence — the shared layer cannot import
   *  reading-core's MODEL_OPTIONS). */
  defaultReasoningEffort: ReasoningEffort;
}

export const DEFAULT_CLAUDE_SETTINGS: ClaudeSettings = {
  defaultPermissionMode: "default",
  defaultRemoteControl: false,
  // Today's hardcoded launch defaults (state.ts createInitialState) — zero
  // behavior drift for an install that never touches the new setting.
  defaultModel: "opus",
  defaultReasoningEffort: "high",
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
    defaultRemoteControl:
      typeof value.defaultRemoteControl === "boolean"
        ? value.defaultRemoteControl
        : DEFAULT_CLAUDE_SETTINGS.defaultRemoteControl,
    // A non-empty string is a concrete model alias; anything else (absent in a
    // pre-field file, or blank) falls back to the launch default.
    defaultModel:
      typeof value.defaultModel === "string" && value.defaultModel
        ? value.defaultModel
        : DEFAULT_CLAUDE_SETTINGS.defaultModel,
    defaultReasoningEffort: isReasoningEffort(value.defaultReasoningEffort)
      ? value.defaultReasoningEffort
      : DEFAULT_CLAUDE_SETTINGS.defaultReasoningEffort,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
