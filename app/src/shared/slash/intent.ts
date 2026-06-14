import type { SlashCommandEntry } from "../types/slash";

/**
 * Semantic routing of a "/" entry (CLI Slice 4). `/` is overloaded with
 * distinct intents; the composer routes by intent, not by one homogeneous
 * passthrough (architecture doc Layer 2):
 *
 * - "skill"       → prompt macro. Complete `/<name> ` into the composer and keep
 *                   composing; submit sends it as one message (delivery already
 *                   dispatches it reliably — Slice 4 Phase 0).
 * - "control"     → stateful control with a duet-native popover (`/model`,
 *                   `/effort`, `/permissions`).
 * - "panel"       → interactive TUI panel (`/config`, `/resume`, …). Blind
 *                   injection leaves an invisible dialog that swallows the next
 *                   paste (probe s1), so these route to the take-over floor (S3)
 *                   where the user drives the native surface.
 * - "passthrough" → local/session/prompt builtins (`/status`, `/clear`,
 *                   `/init`) that submit verbatim and behave correctly through
 *                   the PTY.
 * - "unknown"     → not in the registry. Degrades to the floor (never a silent
 *                   hang); the caller may keep a gentle confirm first.
 *
 * Pure and UI-free so it is unit-testable in isolation (`smoke:slash-intent`)
 * and shared by both submit entry points (pick + typed).
 */
export type SlashIntent = "skill" | "control" | "panel" | "passthrough" | "unknown";

export function classifySlashIntent(entry: SlashCommandEntry | null | undefined): SlashIntent {
  if (!entry) {
    return "unknown";
  }
  if (entry.kind === "skill") {
    return "skill";
  }
  // A native-menu control is checked before "panel": `/model` carries
  // behavior:"panel" AND nativeMenu:"model" — the duet popover wins.
  if (entry.nativeMenu) {
    return "control";
  }
  if (entry.behavior === "panel") {
    return "panel";
  }
  return "passthrough";
}
