import type { SlashCommandEntry } from "../types/slash";

/**
 * Routing of a "/" entry (S3, two-window contract §1 machine #2). Two ways:
 *
 * - "skill"       → prompt macro. Complete `/<name> ` into the composer and
 *                   keep composing; submit sends it as one message.
 * - "passthrough" → everything else submits verbatim. Panels a command opens
 *                   render in the co-visible terminal window, where the user
 *                   operates them natively.
 *
 * The old 5-way split (control/panel/unknown) compensated for a HIDDEN
 * terminal — a blindly-injected panel was an invisible dialog that swallowed
 * the next paste (probe s1). The satellite terminal window killed that
 * premise: visible = answerable.
 *
 * Pure and UI-free so it is unit-testable in isolation (`smoke:slash-intent`)
 * and shared by both submit entry points (pick + typed).
 */
export type SlashIntent = "skill" | "passthrough";

export function classifySlashIntent(entry: SlashCommandEntry | null | undefined): SlashIntent {
  return entry?.kind === "skill" ? "skill" : "passthrough";
}
