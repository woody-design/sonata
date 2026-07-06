import fs from "node:fs";
import path from "node:path";
import type { ApprovalDecision } from "../../../shared/types/domain";
import { CODEX_ANSWERING_MARKER, codexApprovalsDirectory } from "./codex-runtime-settings";

/**
 * The Codex approvals edge (control-plane S3) — the two provider-specific pieces
 * of the approval channel that the shared broker/watcher cannot know:
 *
 *  1. The DECISION JSON the broker emits to answer a `PermissionRequest`. Codex's
 *     envelope matches Claude's `PermissionRequest` shape at the top level
 *     (`hookSpecificOutput.hookEventName` + `decision.behavior`, verified
 *     0.142.5), but Codex only honors `behavior: "allow" | "deny"`. Persistent
 *     "Always allow" rules (Claude's `updatedPermissions`/`addRules`) are
 *     UNVERIFIED on Codex — an open probe, out of scope — so an `approve-always`
 *     maps to a plain one-shot allow here, never a guessed rule shape.
 *  2. The answering MARKER lifecycle: the broker shim is inert (native card,
 *     zero stall) until Duet drops the marker, and Duet drops it exactly when
 *     the approval-card wiring is live for the task (it is watching the task's
 *     approvals dir). Single-sourced with the shim via `CODEX_ANSWERING_MARKER`.
 */

/**
 * Build the `PermissionRequest` decision JSON the Codex broker emits to the CLI.
 * `deny` → block; everything else → one-shot allow (see the "Always" note above).
 */
export function codexBrokerDecisionJson(decision: ApprovalDecision): unknown {
  const behavior = decision === "deny" ? "deny" : "allow";
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior },
    },
  };
}

/** Absolute path to a task's answering-enabled marker. */
export function codexAnsweringMarkerPath(runtimeDir: string): string {
  return path.join(codexApprovalsDirectory(runtimeDir), CODEX_ANSWERING_MARKER);
}

/**
 * Arm the broker's hold-and-answer path for a task by dropping the marker the
 * shim checks. Idempotent; creates the approvals dir if needed. Called when Duet
 * starts watching the task's approvals (i.e. the card channel is live).
 */
export function enableCodexAnswering(runtimeDir: string): void {
  const dir = codexApprovalsDirectory(runtimeDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CODEX_ANSWERING_MARKER), "");
  } catch {
    // Best-effort: an unwritable marker just means the broker stays inert (the
    // native card takes over) — the honest degrade, never a thrown spawn.
  }
}

/**
 * Disarm answering (task closed / no longer watched): the broker reverts to the
 * instant-native-card path. Best-effort; a stale marker is harmless because the
 * broker only ever runs while Duet is spawning — and Duet re-drops the marker on
 * the next watch — so answering is never falsely armed without a live watcher.
 */
export function disableCodexAnswering(runtimeDir: string): void {
  try {
    fs.rmSync(codexAnsweringMarkerPath(runtimeDir), { force: true });
  } catch {
    // best-effort
  }
}
