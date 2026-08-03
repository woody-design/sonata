import type { RunId, RuntimeProvider, TaskId } from "./domain";

/**
 * The semantic transcript contract.
 *
 * This is the product's reading spine: provider-neutral semantic blocks with
 * explicit provenance. Data sources are adapters around this contract —
 * provider session files today, structured SDK/app-server streams later.
 * Surfaces render the contract, never a specific provider format.
 */

export type TranscriptSourceKind = "provider-session-file" | "terminal-fallback";

export type TranscriptFileFormat = "claude-session-jsonl" | "codex-rollout-jsonl";

export interface TranscriptSourceRef {
  sourceId: string;
  provider: RuntimeProvider;
  format: TranscriptFileFormat;
  path: string;
  providerSessionId: string | null;
  locatedAt: string;
}

export type TranscriptBlockKind =
  | "user-message"
  | "assistant-text"
  | "thinking"
  | "tool-call"
  | "plan"
  | "agents"
  | "system-note"
  | "compaction";

interface TranscriptBlockBase {
  id: string;
  taskId: TaskId;
  sourceId: string;
  provider: RuntimeProvider;
  /** Groups blocks into conversational turns (provider turn id or synthesized). */
  turnKey: string;
  /** Sonata Run attribution. Null when the turn cannot be matched to a Run. */
  runId: RunId | null;
  ts: string;
  /** Ordering within one source. */
  seq: number;
}

export interface UserMessageBlock extends TranscriptBlockBase {
  kind: "user-message";
  text: string;
  /** Slash command name when the message is a command invocation. */
  command: string | null;
  attachments: TranscriptAttachment[];
}

export interface TranscriptAttachment {
  kind: "image";
  source: "local-path" | "provider-content";
  path: string | null;
  mediaType: string | null;
}

export interface AssistantTextBlock extends TranscriptBlockBase {
  kind: "assistant-text";
  markdown: string;
}

export interface ThinkingBlock extends TranscriptBlockBase {
  kind: "thinking";
  text: string;
}

export type ToolCallStatus = "running" | "ok" | "error";

export interface ToolCallBlock extends TranscriptBlockBase {
  kind: "tool-call";
  callId: string;
  toolName: string;
  /** One-line human summary: the command, the file path, the query. */
  summary: string;
  inputPreview: string;
  inputTruncated: boolean;
  status: ToolCallStatus;
  resultPreview: string | null;
  resultTruncated: boolean;
  durationMs: number | null;
}

export type PlanItemStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  /** Step description: TodoWrite `content` (claude) / `step` (codex). */
  text: string;
  /** Present-continuous label while active: TodoWrite `activeForm`. */
  activeLabel: string | null;
  status: PlanItemStatus;
}

/**
 * The agent's own plan state (claude TodoWrite / codex update_plan).
 * Both providers send FULL state on every call, so one block per turn is
 * upserted in place — latest call wins. The id is stable per turn.
 */
export interface PlanBlock extends TranscriptBlockBase {
  kind: "plan";
  items: PlanItem[];
}

export interface SystemNoteBlock extends TranscriptBlockBase {
  kind: "system-note";
  text: string;
  /** For continuation turns opened by a machine-injected user record
   *  (promptSource:"system" — task-notifications, /loop wakeups): the
   *  verbatim injected prompt. Run attribution matches it against
   *  `run.prompt` (legacy text bridge) and the reading surface suppresses
   *  husk runs by it. Absent on ordinary notes. */
  sourcePrompt?: string | null;
}

export type AgentRunStatus = "running" | "done";

export interface AgentRunItem {
  /** The spawning `Agent` tool_use id — the stable join key for this agent. */
  toolUseId: string;
  /** Human label: the `Agent` tool's `description` ("Research … facts"), or a
   *  `Workflow`'s name ("deep-research"). */
  name: string;
  /** Optional one-line description shown after the name — a `Workflow`'s
   *  summary ("Deep research harness — fan-out web searches …"). Null for a
   *  plain `Agent`, whose name already is its description. */
  detail: string | null;
  /** subagent_type ("general-purpose"), or "workflow" for a Workflow launch. */
  agentType: string;
  status: AgentRunStatus;
  /** Spawn timestamp (ISO). Drives the live elapsed clock while running. */
  startedAt: string;
  /** Wall-clock duration once the agent comes to rest. CLI-reported when the
   *  notification carries it, else computed from the completion timestamp. */
  durationMs: number | null;
}

/**
 * Background work the turn fanned out to — a claude `Agent` (one sub-agent) or
 * a `Workflow` (a whole background fleet, e.g. the deep-research skill, shown
 * coarsely as one row). Like PlanBlock, one block per turn upserted in place:
 * a spawn adds a running row, the matching task-notification settles it to
 * done. It is a live dashboard while work runs and a permanent archive after.
 *
 * Scope is what the main session itself launched. Nested children — a sub-
 * agent's own agents, or a workflow's internal agents (the terminal's "+N") —
 * are not surfaced here; their spawns never reach the main session stream.
 */
export interface AgentRosterBlock extends TranscriptBlockBase {
  kind: "agents";
  items: AgentRunItem[];
}

export type CompactionTrigger = "manual" | "auto";

/**
 * A context-compaction boundary: the point where the provider summarized the
 * conversation to reclaim its working-memory window. Transcript-derived (NOT
 * hook-derived), so it survives resume/replay byte-identically — Claude's
 * `system/compact_boundary` record, Codex's top-level `compacted` record.
 * One block per compaction event, at the compaction point, its own turn group;
 * the Reading surface draws it as a calm state-register separator, never a
 * turn card. The full transcript above the line is untouched — only the model's
 * working memory was summarized; copy must never say cleared/reset/lost.
 *
 * A state-register kind, like `system-note`: it is NOT in the daemon's narrow
 * `BlockView` (contracts-v2 B2/B3 surface only user-message + assistant-text),
 * so the frozen Part A consumer reduces it to nothing — the daemon's mirror
 * assembly ignores any kind it does not promote (sonata-eink daemon/src/mirror/
 * turns.ts). Adding it is additive under the contract's extensibility (B6).
 *
 * `trigger` is the one v2-disclosure-relevant field carried where cheap
 * (manual vs auto compaction). The summary TEXT is deliberately NOT carried in
 * v1: Claude exposes plaintext (its `isCompactSummary` user record, or the
 * PostCompact hook) but Codex's is encrypted (Fernet) — a disclosure v2 is
 * Claude-only. The normalizer seams for that consumption are commented at the
 * source records; this block stays minimal until v2 needs them.
 */
export interface CompactionBlock extends TranscriptBlockBase {
  kind: "compaction";
  /** Claude carries manual/auto in `compactMetadata.trigger`; Codex's
   *  `compacted` record carries none → null. */
  trigger: CompactionTrigger | null;
  /** Present ONLY when the source record matched a measured failure signature:
   *  Codex's `compacted` record carried a replacement history with no summary
   *  item at all (#36642 — a compaction that discards the conversation instead
   *  of summarizing it; open and unfixed at 0.146.0, and no error is reported
   *  anywhere). A SIGNATURE, not a verdict: the summary is encrypted, so Sonata
   *  can see that none was written, never that the model actually lost the
   *  thread — the Reading copy hedges accordingly.
   *
   *  Absent on Claude, on healthy records, and on ANY record shape the
   *  assessment does not fully recognize (see assessCodexCompactionIntegrity) —
   *  absence means "nothing to report", never "verified intact". Additive under
   *  the frozen contract's B6 extensibility; the daemon's `BlockView` never
   *  promoted this kind at all, so no external consumer is affected. */
  integrity?: "summary-missing";
}

export type TranscriptBlock =
  | UserMessageBlock
  | AssistantTextBlock
  | ThinkingBlock
  | ToolCallBlock
  | PlanBlock
  | AgentRosterBlock
  | SystemNoteBlock
  | CompactionBlock;

export const TRANSCRIPT_SOURCES_SCHEMA_ID = "sonata.transcript-sources.v1" as const;
export const TRANSCRIPT_SOURCES_SCHEMA_VERSION = 1 as const;

export interface TranscriptSourcesFileV1 {
  schemaId: typeof TRANSCRIPT_SOURCES_SCHEMA_ID;
  version: typeof TRANSCRIPT_SOURCES_SCHEMA_VERSION;
  taskId: TaskId;
  sources: TranscriptSourceRef[];
}
