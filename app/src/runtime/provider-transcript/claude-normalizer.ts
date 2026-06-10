import type { TaskId } from "../../shared/types/domain";
import type { ToolCallBlock, TranscriptAttachment, TranscriptBlock } from "../../shared/types/transcript";
import {
  boundText,
  INPUT_PREVIEW_LIMIT,
  parseJsonRecord,
  prettyJson,
  RESULT_PREVIEW_LIMIT,
  toolSummary,
} from "./block-helpers";

/**
 * Normalizes Claude Code session JSONL records into transcript blocks.
 *
 * Turn rules:
 * - Meta user records are context injection and are skipped.
 * - A typed prompt or command invocation always starts a new turn.
 * - Legacy user records without promptSource keep the older fallback heuristic:
 *   real text starts a turn once the previous turn has assistant content.
 * - Records that only carry tool_result blocks are plumbing: they resolve
 *   pending tool calls and never affect turn state.
 * - Sidechain (subagent) records are skipped entirely.
 */
export class ClaudeSessionNormalizer {
  private readonly taskId: TaskId;
  private readonly sourceId: string;
  private seq = 0;
  private turnSeq = 0;
  private currentTurnKey: string | null = null;
  private turnHasAssistant = false;
  private readonly pendingToolCalls = new Map<string, ToolCallBlock>();

  constructor(options: { taskId: TaskId; sourceId: string }) {
    this.taskId = options.taskId;
    this.sourceId = options.sourceId;
  }

  consumeLine(line: string): TranscriptBlock[] {
    const record = parseJsonRecord(line);
    if (!record || record.isSidechain === true) {
      return [];
    }

    const type = record.type;
    if (type === "user") {
      return this.consumeUserRecord(record);
    }
    if (type === "assistant") {
      return this.consumeAssistantRecord(record);
    }
    return [];
  }

  private consumeUserRecord(record: Record<string, unknown>): TranscriptBlock[] {
    if (record.isMeta === true) {
      return [];
    }

    const message = record.message as Record<string, unknown> | undefined;
    const content = message?.content;
    const ts = recordTimestamp(record);
    const upserts: TranscriptBlock[] = [];

    const textParts: string[] = [];
    const attachments: TranscriptAttachment[] = [];
    if (typeof content === "string") {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      for (const blockValue of content) {
        const block = blockValue as Record<string, unknown>;
        if (block.type === "tool_result") {
          const updated = this.resolveToolResult(block, ts);
          if (updated) {
            upserts.push(updated);
          }
        } else if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "image") {
          const source = block.source as Record<string, unknown> | undefined;
          attachments.push({
            kind: "image" as const,
            source: "provider-content" as const,
            path: null,
            mediaType: typeof source?.media_type === "string" ? source.media_type : null,
          });
        }
      }
    }

    const userText = cleanUserText(textParts.join("\n"));
    if (!userText && attachments.length === 0) {
      return upserts;
    }

    const command = parseCommandInvocation(userText);
    const promptSource = typeof record.promptSource === "string" ? record.promptSource : null;
    const startsTurn =
      promptSource === "typed" ||
      promptSource === "queued" ||
      command !== null ||
      this.currentTurnKey === null ||
      this.turnHasAssistant;
    if (!startsTurn) {
      // Context injection (skill body, command expansion) inside a fresh turn.
      return upserts;
    }

    const promptId = typeof record.promptId === "string" ? record.promptId : null;
    this.currentTurnKey = promptId ?? `turn-${++this.turnSeq}`;
    this.turnHasAssistant = false;

    upserts.push({
      kind: "user-message",
      id: this.blockId(record, "user"),
      taskId: this.taskId,
      sourceId: this.sourceId,
      provider: "claude",
      turnKey: this.currentTurnKey,
      runId: null,
      ts,
      seq: ++this.seq,
      text: command ? command.display : userText,
      command: command ? command.name : null,
      attachments,
    });
    return upserts;
  }

  private consumeAssistantRecord(record: Record<string, unknown>): TranscriptBlock[] {
    const message = record.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) {
      return [];
    }

    const ts = recordTimestamp(record);
    this.ensureTurn(record);
    const upserts: TranscriptBlock[] = [];

    for (const [index, blockValue] of content.entries()) {
      const block = blockValue as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        this.turnHasAssistant = true;
        upserts.push({
          kind: "assistant-text",
          id: this.blockId(record, `text-${index}`),
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "claude",
          turnKey: this.currentTurnKey ?? this.openImplicitTurn(),
          runId: null,
          ts,
          seq: ++this.seq,
          markdown: block.text,
        });
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        this.turnHasAssistant = true;
        upserts.push({
          kind: "thinking",
          id: this.blockId(record, `thinking-${index}`),
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "claude",
          turnKey: this.currentTurnKey ?? this.openImplicitTurn(),
          runId: null,
          ts,
          seq: ++this.seq,
          text: block.thinking,
        });
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        this.turnHasAssistant = true;
        const input = block.input;
        const inputPreview = boundText(prettyJson(input), INPUT_PREVIEW_LIMIT);
        const toolCall: ToolCallBlock = {
          kind: "tool-call",
          id: `${this.sourceId}:tool:${block.id}`,
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "claude",
          turnKey: this.currentTurnKey ?? this.openImplicitTurn(),
          runId: null,
          ts,
          seq: ++this.seq,
          callId: block.id,
          toolName: typeof block.name === "string" ? block.name : "tool",
          summary: toolSummary(input),
          inputPreview: inputPreview.text,
          inputTruncated: inputPreview.truncated,
          status: "running",
          resultPreview: null,
          resultTruncated: false,
          durationMs: null,
        };
        this.pendingToolCalls.set(block.id, toolCall);
        upserts.push(toolCall);
      }
    }
    return upserts;
  }

  private resolveToolResult(block: Record<string, unknown>, ts: string): ToolCallBlock | null {
    const callId = block.tool_use_id;
    if (typeof callId !== "string") {
      return null;
    }
    const pending = this.pendingToolCalls.get(callId);
    if (!pending) {
      return null;
    }
    this.pendingToolCalls.delete(callId);

    const result = boundText(toolResultText(block.content), RESULT_PREVIEW_LIMIT);
    const startedMs = Date.parse(pending.ts);
    const endedMs = Date.parse(ts);
    const updated: ToolCallBlock = {
      ...pending,
      status: block.is_error === true ? "error" : "ok",
      resultPreview: result.text,
      resultTruncated: result.truncated,
      durationMs:
        Number.isNaN(startedMs) || Number.isNaN(endedMs) ? null : Math.max(0, endedMs - startedMs),
    };
    return updated;
  }

  private ensureTurn(record: Record<string, unknown>): void {
    if (this.currentTurnKey !== null) {
      return;
    }
    const promptId = typeof record.promptId === "string" ? record.promptId : null;
    this.currentTurnKey = promptId ?? `turn-${++this.turnSeq}`;
  }

  private openImplicitTurn(): string {
    this.currentTurnKey = `turn-${++this.turnSeq}`;
    return this.currentTurnKey;
  }

  private blockId(record: Record<string, unknown>, suffix: string): string {
    const uuid = typeof record.uuid === "string" ? record.uuid : `seq-${this.seq + 1}`;
    return `${this.sourceId}:${uuid}:${suffix}`;
  }
}

function recordTimestamp(record: Record<string, unknown>): string {
  return typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const block = item as Record<string, unknown>;
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function cleanUserText(text: string): string {
  const withoutReminders = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "");
  return withoutReminders.trim();
}

function parseCommandInvocation(text: string): { name: string; display: string } | null {
  const nameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (!nameMatch) {
    return null;
  }
  const name = nameMatch[1]?.trim() ?? "";
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = argsMatch?.[1]?.trim() ?? "";
  const display = args ? `${name} ${args}` : name;
  return { name, display };
}
