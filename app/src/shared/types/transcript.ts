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
  | "system-note";

interface TranscriptBlockBase {
  id: string;
  taskId: TaskId;
  sourceId: string;
  provider: RuntimeProvider;
  /** Groups blocks into conversational turns (provider turn id or synthesized). */
  turnKey: string;
  /** Duet Run attribution. Null when the turn cannot be matched to a Run. */
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

export interface SystemNoteBlock extends TranscriptBlockBase {
  kind: "system-note";
  text: string;
}

export type TranscriptBlock =
  | UserMessageBlock
  | AssistantTextBlock
  | ThinkingBlock
  | ToolCallBlock
  | SystemNoteBlock;

export const TRANSCRIPT_SOURCES_SCHEMA_ID = "duet.transcript-sources.v1" as const;
export const TRANSCRIPT_SOURCES_SCHEMA_VERSION = 1 as const;

export interface TranscriptSourcesFileV1 {
  schemaId: typeof TRANSCRIPT_SOURCES_SCHEMA_ID;
  version: typeof TRANSCRIPT_SOURCES_SCHEMA_VERSION;
  taskId: TaskId;
  sources: TranscriptSourceRef[];
}
