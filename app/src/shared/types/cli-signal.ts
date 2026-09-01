/**
 * CLI signal layer (Slice 1) — structured-first observation of the hosted CLI.
 *
 * The payload below is NOT "Claude's" — it is the hook contract both Claude Code
 * and Codex speak, wire-field-for-wire-field (verified 2026-07-06 on codex
 * 0.142.5: same envelope, same values vocabulary, `tool_name:"Bash"`). Sonata
 * treats it as an emerging industry standard and adopts it verbatim (snake_case
 * wire names, no Sonata renames); provider metadata lives OUTSIDE the payload in
 * `HookEnvelope`.
 *
 * Phase 0 (2026-06-13, real claude 2.1.177 under sonata's spawn) established the
 * medium truths this layer is built on:
 *  - Hooks UNION across every settings source, so sonata injects its own hooks
 *    into the `--settings` file without clobbering the user's.
 *  - The reliable structured signals are HOOKS, not OSC: `PermissionRequest`
 *    (approval, names the tool), `Stop` (turn end), `UserPromptSubmit` /
 *    `Pre`/`PostToolUse` (activity). OSC 9;4 does NOT arrive (2.1.177 gates it
 *    behind a terminal-capability handshake node-pty never answers).
 *  - `Notification(idle_prompt|permission_prompt)` does NOT fire — so we lean on
 *    `Stop` and `PermissionRequest` instead. **SUPERSEDED — see below.**
 *
 * That last one is NO LONGER TRUE and the correction matters (upstream sync
 * 2026-09-01, SL-2b, claude 2.1.257, probe `spikes/upstream-sync-2026-09/claude/
 * q11-hook-coverage.mjs`): `Notification` DOES fire now, with
 * `notification_type: "idle_prompt"` and `message: "Claude is waiting for your
 * input"`, measured twice at Stop+60.2s / Stop+60.1s (the bundle's default
 * `messageIdleNotifThresholdMs` is 60000). Sonata already injects `Notification`,
 * so it already arrives. It is deliberately NOT consumed as a turn-end or
 * readiness signal: it is anchored on the SAME turn-end `Stop` is, and never
 * arrived in the 100s following either of the two measured Stop-less endings (a
 * user Esc mid-turn, a user denying a tool). A signal that only fires when Stop
 * fired adds no coverage — see `stoplessTurnEndConfirmed` for what does.
 */

import type { RuntimeProvider, TaskId } from "./domain";

/**
 * Hook events sonata injects + observes. Discriminator = `hook_event_name`.
 *
 * The first six — `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
 * `PostToolUse`, `PermissionRequest`, `Stop` — are the shared core BOTH
 * providers emit (Codex's verified set, 2026-07-06).
 *
 * `SubagentStart` / `SubagentStop` are the subagent lifecycle pair. Codex emits
 * BOTH (verified 0.144.4, S6) with rich payloads (`agent_id`, `agent_type`,
 * `agent_transcript_path`) and Sonata feeds them into the status-strip roster;
 * Claude emits only `SubagentStop` (no `SubagentStart`) and its roster is
 * derived from the session file instead, so Claude's `SubagentStop` stays a
 * cli-state no-op. `StopFailure` (structured API error) and `Notification`
 * are Claude-observed only — Codex has no equivalent.
 *
 * `PreCompact` / `PostCompact` are the context-compaction lifecycle pair. Both
 * providers fire them (Codex verified 0.144.4, P2; Claude verified 2.1.210, P3),
 * and Codex now registers them in its sink for signal completeness — but Sonata
 * consumes NEITHER into cli-state or run lifecycle: the Reading compaction marker
 * is TRANSCRIPT-derived (Claude's `system/compact_boundary`, Codex's `compacted`),
 * so it survives resume/replay where an ephemeral hook could not.
 *
 * `SessionEnd` (Codex 0.145.0+, #33895: fires on thread teardown, 3s timeout
 * cap, `reason: "other"`) and `DirectoryAdded` (Claude 2.1.219+: fires after
 * `/add-dir` with `how_added`) are KNOWN, NOT WIRED — neither appears in
 * `SINK_EVENTS` / `INJECTED_HOOK_EVENTS`, so neither ever reaches the sink.
 * They live in the union as capability documentation (the union is capability;
 * the injection lists are policy — upstream-sync 2026-08-03). SessionEnd is
 * the registered UNLOCK candidate for discriminating a graceful codex quit
 * from a silent death (hypothesis UNVERIFIED — probe before wiring).
 *
 * SessionEnd, CLAUDE side, MEASURED (SL-2b, 2.1.257, q11 arm s5): it DOES fire
 * under Sonata's `--settings` injection — `reason: "prompt_input_exit"` on
 * `/exit`, ~300ms before the pty dies. Its reason enum in the 2.1.257 bundle is
 * `clear|resume|logout|prompt_input_exit|other`, i.e. session TEARDOWN, not a
 * turn boundary — so it is not a completion signal and stays unwired here.
 *
 * 2.1.257 declares 33 events (`var Hh=[…]` in the bundle). Two more are measured
 * and unwired: `PostToolUseFailure` fires INSTEAD of `PostToolUse` when a tool
 * errors (carrying the error text), and `PermissionDenied` does NOT fire for a
 * native-UI denial. Both belong to SL-9's hooks audit, not to this union yet.
 */
export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PermissionRequest"
  | "Notification"
  | "Stop"
  | "StopFailure"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact"
  | "DirectoryAdded";

/**
 * A hook payload (stdin JSON), keyed by the fields observed in Phase 0.
 * Permissive on purpose: the CLI may add fields and we only read a few — the
 * boundary validates only consumed fields and passes unknown ones through.
 */
export interface HookPayload {
  hook_event_name?: HookEventName | string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  /** UserPromptSubmit — the prompt the CLI actually received (drives
   *  hook-driven run-start; carries the verbatim text + prompt_id). */
  prompt?: string;
  prompt_id?: string;
  /** PermissionRequest / Pre/PostToolUse */
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  /** Stop */
  stop_hook_active?: boolean;
  last_assistant_message?: unknown;
  /** The turn a hook belongs to. Codex carries it on every mid-turn event
   *  (rollout `turn_id`); it keys the subagent roster to its launch turn. */
  turn_id?: string;
  /** SubagentStart / SubagentStop (Codex, verified 0.144.4). `agent_id` is the
   *  child agent's stable id (the roster join key); `agent_type` is its kind
   *  ("default" for a plain subagent); `agent_transcript_path` points at the
   *  child's OWN rollout file — Sonata does not read it (future door). */
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  /** StopFailure — structured API error, e.g. "model_not_found" (probed S6). */
  error?: string;
  /** Notification. Absent on 2.1.177; LIVE at 2.1.257 — the measured values are
   *  `idle_prompt` (60s after a turn end) with `message: "Claude is waiting for
   *  your input"`. The bundle's full enum also carries `permission_prompt`,
   *  `auth_success`, `elicitation_dialog`, `agent_needs_input`,
   *  `agent_completed`, … (presence-only evidence, unprobed). */
  notification_type?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * A provider-stamped hook payload. The `payload` stays the verbatim standard
 * contract (above); everything Sonata knows ABOUT it — which provider emitted it,
 * which task it belongs to, when we saw it — lives here, OUTSIDE the wire shape,
 * so "aligned with the standard or not" stays greppable forever.
 *
 * Type-only for now: the watcher still delivers a bare `HookPayload` + runtime
 * dir. Stamping the envelope (provider/taskId at the controller) is a later
 * slice's job — this type declares the target shape without wiring it.
 */
export interface HookEnvelope {
  provider: RuntimeProvider;
  taskId: TaskId;
  receivedAt: string;
  payload: HookPayload;
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
