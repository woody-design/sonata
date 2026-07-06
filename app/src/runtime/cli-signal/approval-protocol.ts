import path from "node:path";

/**
 * The approval broker's on-disk protocol — the SINGLE source of truth for the
 * ask/reply/expired/answered file contract, shared by every producer (the Claude
 * broker `approval-broker.ts`, the Codex broker shim), the neutral
 * `ApprovalWatcher` that consumes it, and Duet's reply/expiry paths in the
 * controller. Both providers speak this identical protocol in the identical
 * `<runtimeDir>/approvals` layout, so single-sourcing it here means a rename can
 * never silently desync a producer from the consumer — the failure mode is
 * invisible (cards stop, the broker holds the full timeout, degrades to native,
 * no error anywhere), so the contract must be a literal, not a convention
 * (reviewer R2/C3).
 *
 * The Codex broker shim, being frozen trusted TEXT, interpolates these values at
 * generation time (it cannot import at runtime); the parity smoke asserts the
 * shim and the Claude broker agree on every constant here.
 */

/** The approvals control subdir under a task's runtime dir (provider-neutral). */
export const APPROVALS_SUBDIR = "approvals";

/** One-shot control-file prefixes (tmp+rename so a reader only sees a complete
 *  file). `<prefix><id>.json`. */
export const ASK_PREFIX = "ask-";
export const REPLY_PREFIX = "reply-";
export const EXPIRED_PREFIX = "expired-";
export const ANSWERED_PREFIX = "answered-";

/** Broker hold-poll / watcher poll cadence (ms). */
export const APPROVAL_POLL_MS = 100;

/** The ONE neutral resolver for a task's approvals control dir. Both providers'
 *  broker+marker paths and the watcher resolve through this — no provider module
 *  owns the layout. */
export function approvalsDirectory(runtimeDir: string): string {
  return path.join(runtimeDir, APPROVALS_SUBDIR);
}
