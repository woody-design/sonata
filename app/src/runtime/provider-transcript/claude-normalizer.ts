import type { TaskId } from "../../shared/types/domain";
import type {
  PlanBlock,
  PlanItem,
  ToolCallBlock,
  TranscriptAttachment,
  TranscriptBlock,
} from "../../shared/types/transcript";
import {
  boundText,
  INPUT_PREVIEW_LIMIT,
  parseJsonRecord,
  parsePlanItems,
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
  private readonly turnPlans = new Map<string, PlanBlock>();
  /** Session-level task state for the 2.1.17x TaskCreate/TaskUpdate tools. */
  private readonly sessionTasks = new Map<string, PlanItem>();
  private readonly pendingPlanCalls = new Map<string, PendingPlanCall>();

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
        if (block.name === "TodoWrite") {
          // Legacy full-state plan tool (pre-2.1.17x sessions). One upserted
          // block per turn; the orphan tool_result drops naturally in
          // resolveToolResult. Malformed input falls through to the generic
          // tool-call path below.
          const items = parsePlanItems(block.input);
          if (items) {
            upserts.push(this.upsertPlanBlock(items, ts));
            continue;
          }
        }
        const toolCall = this.buildToolCall(block, ts);
        if (block.name === "TaskCreate") {
          // Current plan tool: the task id exists only in the RESULT text,
          // so the create is buffered and applied in resolveToolResult. The
          // pre-built generic block is the evidence fallback if the result
          // cannot be parsed.
          const input = block.input as Record<string, unknown> | undefined;
          const subject =
            typeof input?.subject === "string" && input.subject.trim() ? input.subject : null;
          if (subject) {
            this.pendingPlanCalls.set(block.id, {
              kind: "create",
              toolCall,
              text: subject,
              activeLabel:
                typeof input?.activeForm === "string" && input.activeForm.trim()
                  ? input.activeForm
                  : null,
            });
            continue;
          }
        }
        if (block.name === "TaskUpdate") {
          // Self-contained delta: applies on use; the result is swallowed.
          // Unknown task ids stay visible as generic tool calls.
          const planUpdate = this.applyTaskUpdate(block.input, ts);
          if (planUpdate) {
            this.pendingPlanCalls.set(block.id, { kind: "update" });
            upserts.push(planUpdate);
            continue;
          }
        }
        this.pendingToolCalls.set(block.id, toolCall);
        upserts.push(toolCall);
      }
    }
    return upserts;
  }

  private buildToolCall(block: Record<string, unknown>, ts: string): ToolCallBlock {
    const input = block.input;
    const inputPreview = boundText(prettyJson(input), INPUT_PREVIEW_LIMIT);
    return {
      kind: "tool-call",
      id: `${this.sourceId}:tool:${block.id as string}`,
      taskId: this.taskId,
      sourceId: this.sourceId,
      provider: "claude",
      turnKey: this.currentTurnKey ?? this.openImplicitTurn(),
      runId: null,
      ts,
      seq: ++this.seq,
      callId: block.id as string,
      toolName: typeof block.name === "string" ? block.name : "tool",
      summary: toolSummary(input),
      inputPreview: inputPreview.text,
      inputTruncated: inputPreview.truncated,
      status: "running",
      resultPreview: null,
      resultTruncated: false,
      durationMs: null,
    };
  }

  private applyTaskUpdate(input: unknown, ts: string): PlanBlock | null {
    const record = (input ?? {}) as Record<string, unknown>;
    const taskId =
      typeof record.taskId === "string"
        ? record.taskId
        : typeof record.taskId === "number"
          ? String(record.taskId)
          : null;
    if (!taskId || !this.sessionTasks.has(taskId)) {
      return null;
    }
    const item = this.sessionTasks.get(taskId) as PlanItem;
    const status = record.status;
    if (status === "deleted") {
      this.sessionTasks.delete(taskId);
    } else {
      if (status === "pending" || status === "in_progress" || status === "completed") {
        item.status = status;
      }
      if (typeof record.subject === "string" && record.subject.trim()) {
        item.text = record.subject;
      }
      if (typeof record.activeForm === "string" && record.activeForm.trim()) {
        item.activeLabel = record.activeForm;
      }
    }
    return this.upsertPlanBlock(this.sessionTaskItems(), ts);
  }

  private sessionTaskItems(): PlanItem[] {
    return [...this.sessionTasks.values()].map((item) => ({ ...item }));
  }

  private upsertPlanBlock(items: PlanItem[], ts: string): PlanBlock {
    const turnKey = this.currentTurnKey ?? this.openImplicitTurn();
    const existing = this.turnPlans.get(turnKey);
    const updated: PlanBlock = existing
      ? { ...existing, items, ts }
      : {
          kind: "plan",
          id: `${this.sourceId}:plan:${turnKey}`,
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "claude",
          turnKey,
          runId: null,
          ts,
          seq: ++this.seq,
          items,
        };
    this.turnPlans.set(turnKey, updated);
    return updated;
  }

  private resolveToolResult(block: Record<string, unknown>, ts: string): TranscriptBlock | null {
    const callId = block.tool_use_id;
    if (typeof callId !== "string") {
      return null;
    }
    const pendingPlan = this.pendingPlanCalls.get(callId);
    if (pendingPlan) {
      this.pendingPlanCalls.delete(callId);
      if (pendingPlan.kind === "update") {
        return null;
      }
      const created = toolResultText(block.content).match(/Task #(\d+) created/i);
      if (created && block.is_error !== true) {
        this.sessionTasks.set(created[1] as string, {
          text: pendingPlan.text,
          activeLabel: pendingPlan.activeLabel,
          status: "pending",
        });
        return this.upsertPlanBlock(this.sessionTaskItems(), ts);
      }
      // Unparseable create result: surface the buffered generic tool call
      // resolved with this result — never lose evidence to a parser.
      this.pendingToolCalls.set(callId, pendingPlan.toolCall);
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

type PendingPlanCall =
  | { kind: "create"; toolCall: ToolCallBlock; text: string; activeLabel: string | null }
  | { kind: "update" };

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
