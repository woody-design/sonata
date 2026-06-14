/**
 * CLI signal layer (Slice 1) — structured-first observation of the hosted CLI.
 *
 * Phase 0 (2026-06-13, real claude 2.1.177 under duet's spawn) established the
 * medium truths this layer is built on:
 *  - Hooks UNION across every settings source, so duet injects its own hooks
 *    into the `--settings` file without clobbering the user's.
 *  - The reliable structured signals are HOOKS, not OSC: `PermissionRequest`
 *    (approval, names the tool), `Stop` (turn end), `UserPromptSubmit` /
 *    `Pre`/`PostToolUse` (activity). OSC 9;4 does NOT arrive (2.1.177 gates it
 *    behind a terminal-capability handshake node-pty never answers).
 *  - `Notification(idle_prompt|permission_prompt)` does NOT fire — so we lean on
 *    `Stop` and `PermissionRequest` instead.
 */

/** Claude hook events duet injects + observes. Discriminator = `hook_event_name`. */
export type ClaudeHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PermissionRequest"
  | "Notification"
  | "Stop"
  | "SubagentStop";

/**
 * A Claude hook payload (stdin JSON), keyed by the fields observed in Phase 0.
 * Permissive on purpose: the CLI may add fields and we only read a few.
 */
export interface ClaudeHookPayload {
  hook_event_name?: ClaudeHookEventName | string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  /** PermissionRequest / Pre/PostToolUse */
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  /** Stop */
  stop_hook_active?: boolean;
  last_assistant_message?: unknown;
  /** Notification (observed absent on 2.1.177, kept for forward-compat) */
  notification_type?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * The single in-memory CLI activity state the renderer subscribes to. Fed
 * primarily by hooks (busy/idle/approval transitions) with the existing
 * terminal-host signals (prompt:submitted, approval:detected, completion
 * heuristics) as corroboration/safety-net.
 */
export type CliActivity = "idle" | "busy" | "waiting-approval" | "turn-ended";

export interface CliStateSnapshot {
  activity: CliActivity;
  /** Tool the agent is running / awaiting approval for, when a hook names it. */
  tool: string | null;
  /** Approval kind when waiting-approval (from the scrape fallback or a hook). */
  approvalKind: string | null;
  /** What last drove the state — for telemetry/debugging, never UI copy. */
  source: string;
  /** ISO timestamp of the last change. */
  changedAt: string;
}
