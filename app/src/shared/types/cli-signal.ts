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
 * (SL-9 tried to measure the CODEX half too and did NOT reproduce it: the arm's
 * `/quit` never left the composer, so codex `SessionEnd` remains UNPROBED under
 * Sonata's injection. It is registered in this slice's profile only by the probe,
 * not by production.)
 *
 * `Interrupt` (codex 0.150.0+, #40511) is the ONE injection-list change SL-9
 * makes, and it is a turn ENDING, not a capability note. MEASURED at 0.152.1
 * through the production spawn: a genuine mid-turn interrupt fires `Interrupt`
 * ~140ms later and NO `Stop` ever follows for that turn. It is now in codex's
 * `SINK_EVENTS` and routes to the SAME consumer `Stop` has
 * (`completeRunFromTurnEnd`): an existing need, structurally answered. The A/B
 * is deliberately unflattering to the change and recorded that way — the same
 * spawn WITHOUT the registration still closed the run, at +2019ms, off the
 * terminal-idle scrape; with it, +253ms off the hook. The win is channel
 * (event, not repaint) and confidence, not a rescued wedge. Payload = codex's own embedded
 * `interrupt.command.input` schema (session_id, turn_id, transcript_path, cwd,
 * model, permission_mode, hook_event_name), verified field-for-field against the
 * measured payload. Claude has no equivalent — SL-2b measured a claude user-Esc
 * firing nothing at all, which is why `stoplessTurnEndConfirmed` still carries
 * that side.
 *
 * MEASURED, and it belongs to Sonata's own stop button rather than to this union:
 * at codex 0.152.1 the interrupt is bound to **Ctrl+C, not Esc**. Three Esc paths
 * (a human `writeUserInput`, a raw `writeRaw`, and production `stopRun()`) each
 * left the turn running to completion with an ordinary `Stop`; only Ctrl+C
 * interrupted, and only Ctrl+C fired `Interrupt`. 0.152.1 ships a configurable
 * keymap with `interrupt_turn` as a named action, so the binding is now a
 * variable. Flagged, not fixed here — the stop encoding lives in terminal-host.
 *
 * THE CENSUS (SL-9, upstream sync 2026-09; claude 2.1.258 / codex 0.152.1). Both
 * providers were driven through PRODUCTION injection with every event their own
 * binary declares registered on Sonata's own sink, and the members below are what
 * was MEASURED to arrive. Evidence: `spikes/upstream-sync-2026-09/claude/
 * h1-hook-census.capture.txt` and `codex/h3-hook-census-interrupt.capture.txt`.
 *
 *  - claude 2.1.258 declares 33 events; ELEVEN fired across a standard turn plus
 *    a `/model` switch. Six of them were not in this union before:
 *    `PostToolUseFailure` (fires INSTEAD of `PostToolUse` on a tool error, with
 *    `error` + `is_interrupt` + `duration_ms`), `PostToolBatch` (fires ALONGSIDE
 *    both, carrying `tool_calls[]` with each response), `MessageDisplay` (per
 *    assistant message: `delta`/`index`/`final`/`message_id`/`turn_id`),
 *    `InstructionsLoaded` (per memory file: `file_path`/`memory_type`/
 *    `load_reason`), and the `PreModelSwitch`/`PostModelSwitch` pair.
 *  - codex 0.152.1 declares TWELVE (`HookEventsToml`); `Interrupt` is the only
 *    one Sonata did not already know about, and it is now WIRED (see below).
 *  - `PermissionDenied` is declared by claude and has never been observed to
 *    fire — not on a native-UI denial (SL-2b s6) and not anywhere in SL-9's
 *    census. It sits here as declared capability with a measured negative, so a
 *    future slice does not re-derive it. Codex declares no such event at all,
 *    nor any `PostToolUseFailure`: on codex a failed tool is an ordinary
 *    `PostToolUse`.
 *
 * What SL-9 DECLINED to add (and it is not "everything that did not fire" — ten
 * of the union's members below have never been observed to fire either, because
 * this union has always carried known-but-unwired capability): the twelve claude
 * names the census left with no evidence of ANY kind — `Setup`, `TeammateIdle`,
 * `TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult`,
 * `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `CwdChanged`,
 * `FileChanged`, `UserPromptExpansion`. A name Sonata does not inject, has never
 * seen arrive, and cannot say anything measured about documents nothing; it is a
 * transcription of the vendor's enum, and the captures already hold that list in
 * full. `DirectoryAdded` is the counterexample that shows the line is about
 * EVIDENCE rather than firing: it never fired here either, but a prior slice
 * measured its trigger and payload, so it stays.
 *
 * `PreModelSwitch`/`PostModelSwitch` MEASURED payload (2.1.258, both events carry
 * the identical key set): `from_model` + `to_model` (canonical API ids),
 * `requested_model` (the alias the user typed), `source` ("command"), plus the
 * cache economics of the switch (`context_tokens`, `prompt_cache_warm`,
 * `cache_ttl`, `estimated_cache_write_usd`, `pricing`). Deliberately UNWIRED
 * here: this is the evidence for the registered `PostModelSwitch` unlock (D2 —
 * "confirm a mid-session switch against the MIRROR, not the stream", the F19/F22
 * register items), and that unlock is its own slice, not a table edit. Note one
 * measured wrinkle for whoever takes it: `PreModelSwitch` fired TWICE, 103ms
 * apart with a byte-identical payload, for a single switch.
 */
export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  /** Claude only, MEASURED — replaces `PostToolUse` when the tool errors. */
  | "PostToolUseFailure"
  /** Claude only, MEASURED — one event per tool batch, alongside the per-tool pair. */
  | "PostToolBatch"
  | "PermissionRequest"
  /** Claude only, declared since ≥2.1.257 and never MEASURED to fire. */
  | "PermissionDenied"
  | "Notification"
  | "Stop"
  | "StopFailure"
  /** Codex only, MEASURED — a user interrupt ends the turn INSTEAD of `Stop`. */
  | "Interrupt"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact"
  /** Claude only, MEASURED — the model/effort switch pair (unlock evidence, unwired). */
  | "PreModelSwitch"
  | "PostModelSwitch"
  /** Claude only, MEASURED — one per memory file loaded at session start. */
  | "InstructionsLoaded"
  /** Claude only, MEASURED — one per assistant message rendered. */
  | "MessageDisplay"
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
  /**
   * The CLI's permission mode at hook time. MEASURED CORRECTION (SL-9, claude
   * 2.1.258): `SessionStart` no longer carries this key AT ALL — SL-5's F29
   * recorded it as present-but-`null` at 2.1.257, and at 2.1.258 it is simply
   * absent. `applyHookPermissionMode` already reads it defensively, so the
   * consequence is unchanged (the first hook to move the permission mirror is
   * still the first TURN's, not the session's) — but the register item's shape
   * is now wrong and this is the correction.
   */
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
  /**
   * PAYLOAD GROWTH measured in SL-9's census, declared here so the next reader
   * does not mistake a new field for an undocumented one. NONE of these is read
   * by Sonata today — they are recorded because "what the envelope carries" is
   * the question a future consumer starts from.
   *
   * BOTH providers now stamp `model` on every event (claude: the display id,
   * e.g. `claude-opus-5[1m]`; codex: `gpt-5.6-sol`). Claude additionally stamps
   * `scratchpad_dir` everywhere, `source` on `SessionStart` ("startup"), `effort`
   * (`{level}`) on the tool and `Stop` events, and `background_tasks` +
   * `session_crons` on `Stop`/`SubagentStop`.
   *
   * The `effort` one is worth a second look by whoever takes the register item
   * "the claude effort axis is OPTIONAL and Sonata models it as mandatory"
   * (SL-4, F17/F20): a per-turn effort mirror now arrives on the hook channel,
   * which is a different and cheaper answer than the statusline payload.
   */
  model?: string;
  source?: string;
  effort?: unknown;
  scratchpad_dir?: string;
  background_tasks?: unknown;
  session_crons?: unknown;
  /** PostToolUseFailure (claude, MEASURED) — alongside `error`. `is_interrupt`
   *  distinguishes a tool the USER killed from one that failed on its own. */
  is_interrupt?: boolean;
  duration_ms?: number;
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
