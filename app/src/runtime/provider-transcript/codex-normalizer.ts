import type { TaskId } from "../../shared/types/domain";
import type { ToolCallBlock, TranscriptBlock } from "../../shared/types/transcript";
import {
  boundText,
  INPUT_PREVIEW_LIMIT,
  parseJsonRecord,
  prettyJson,
  RESULT_PREVIEW_LIMIT,
  toolSummary,
} from "./block-helpers";

/**
 * Normalizes Codex rollout JSONL records into transcript blocks.
 *
 * Codex stores conversational text twice: as `response_item` protocol records
 * and as `event_msg` UI events. Text is read from event_msg only
 * (user_message / agent_message) and tool activity from response_item only
 * (function_call / *_output), so duplication is impossible by construction.
 */
export class CodexRolloutNormalizer {
  private readonly taskId: TaskId;
  private readonly sourceId: string;
  private seq = 0;
  private turnSeq = 0;
  private currentTurnKey: string | null = null;
  private readonly pendingToolCalls = new Map<string, ToolCallBlock>();

  constructor(options: { taskId: TaskId; sourceId: string }) {
    this.taskId = options.taskId;
    this.sourceId = options.sourceId;
  }

  consumeLine(line: string): TranscriptBlock[] {
    const record = parseJsonRecord(line);
    if (!record) {
      return [];
    }

    const ts = typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload) {
      return [];
    }

    if (record.type === "event_msg") {
      return this.consumeEventMsg(payload, ts);
    }
    if (record.type === "response_item") {
      return this.consumeResponseItem(payload, ts);
    }
    if (record.type === "compacted") {
      return [this.systemNote("Context compacted by the provider.", ts)];
    }
    return [];
  }

  private consumeEventMsg(payload: Record<string, unknown>, ts: string): TranscriptBlock[] {
    if (payload.type === "user_message" && typeof payload.message === "string") {
      const text = payload.message.trim();
      if (!text) {
        return [];
      }
      this.currentTurnKey = `turn-${++this.turnSeq}`;
      return [
        {
          kind: "user-message",
          id: this.nextBlockId("user"),
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "codex",
          turnKey: this.currentTurnKey,
          runId: null,
          ts,
          seq: ++this.seq,
          text,
          command: text.startsWith("/") ? text.split(/\s/, 1)[0] ?? null : null,
        },
      ];
    }

    if (payload.type === "agent_message" && typeof payload.message === "string") {
      const text = payload.message.trim();
      if (!text) {
        return [];
      }
      return [
        {
          kind: "assistant-text",
          id: this.nextBlockId("text"),
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "codex",
          turnKey: this.ensureTurn(),
          runId: null,
          ts,
          seq: ++this.seq,
          markdown: text,
        },
      ];
    }

    return [];
  }

  private consumeResponseItem(payload: Record<string, unknown>, ts: string): TranscriptBlock[] {
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : this.nextBlockId("call");
      const input = parseToolArguments(payload);
      const inputPreview = boundText(prettyJson(input), INPUT_PREVIEW_LIMIT);
      const toolCall: ToolCallBlock = {
        kind: "tool-call",
        id: `${this.sourceId}:tool:${callId}`,
        taskId: this.taskId,
        sourceId: this.sourceId,
        provider: "codex",
        turnKey: this.ensureTurn(),
        runId: null,
        ts,
        seq: ++this.seq,
        callId,
        toolName: typeof payload.name === "string" ? payload.name : "tool",
        summary: toolSummary(input),
        inputPreview: inputPreview.text,
        inputTruncated: inputPreview.truncated,
        status: "running",
        resultPreview: null,
        resultTruncated: false,
        durationMs: null,
      };
      this.pendingToolCalls.set(callId, toolCall);
      return [toolCall];
    }

    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : null;
      const pending = callId ? this.pendingToolCalls.get(callId) : undefined;
      if (!callId || !pending) {
        return [];
      }
      this.pendingToolCalls.delete(callId);

      const output = typeof payload.output === "string" ? payload.output : prettyJson(payload.output);
      const result = boundText(output, RESULT_PREVIEW_LIMIT);
      const startedMs = Date.parse(pending.ts);
      const endedMs = Date.parse(ts);
      return [
        {
          ...pending,
          status: codexOutputStatus(output),
          resultPreview: result.text,
          resultTruncated: result.truncated,
          durationMs:
            Number.isNaN(startedMs) || Number.isNaN(endedMs)
              ? null
              : Math.max(0, endedMs - startedMs),
        },
      ];
    }

    if (payload.type === "web_search_call") {
      const action = payload.action as Record<string, unknown> | undefined;
      return [
        {
          kind: "tool-call",
          id: this.nextBlockId("web-search"),
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "codex",
          turnKey: this.ensureTurn(),
          runId: null,
          ts,
          seq: ++this.seq,
          callId: this.nextBlockId("web-search-call"),
          toolName: "web_search",
          summary: toolSummary(action ?? payload),
          inputPreview: boundText(prettyJson(action ?? {}), INPUT_PREVIEW_LIMIT).text,
          inputTruncated: false,
          status: "ok",
          resultPreview: null,
          resultTruncated: false,
          durationMs: null,
        },
      ];
    }

    if (payload.type === "reasoning") {
      const summary = reasoningSummaryText(payload.summary);
      if (!summary) {
        return [];
      }
      return [
        {
          kind: "thinking",
          id: this.nextBlockId("thinking"),
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "codex",
          turnKey: this.ensureTurn(),
          runId: null,
          ts,
          seq: ++this.seq,
          text: summary,
        },
      ];
    }

    return [];
  }

  private systemNote(text: string, ts: string): TranscriptBlock {
    return {
      kind: "system-note",
      id: this.nextBlockId("system"),
      taskId: this.taskId,
      sourceId: this.sourceId,
      provider: "codex",
      turnKey: this.ensureTurn(),
      runId: null,
      ts,
      seq: ++this.seq,
      text,
    };
  }

  private ensureTurn(): string {
    if (this.currentTurnKey === null) {
      this.currentTurnKey = `turn-${++this.turnSeq}`;
    }
    return this.currentTurnKey;
  }

  private nextBlockId(suffix: string): string {
    return `${this.sourceId}:${suffix}-${this.seq + 1}`;
  }
}

function parseToolArguments(payload: Record<string, unknown>): unknown {
  const args = payload.arguments ?? payload.input;
  if (typeof args !== "string") {
    return args ?? {};
  }
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

function codexOutputStatus(output: string): "ok" | "error" {
  const match = output.match(/exited with code (\d+)/i);
  if (match) {
    return match[1] === "0" ? "ok" : "error";
  }
  return "ok";
}

function reasoningSummaryText(summary: unknown): string {
  if (!Array.isArray(summary)) {
    return "";
  }
  return summary
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
