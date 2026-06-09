import type {
  DeliveryItemId,
  DeliveryQueueItem,
  DeliveryReceipt,
  DeliveryTaskState,
  RuntimeProvider,
  RunId,
  TaskId,
} from "../shared/types/domain";
import type { RuntimeEvent } from "../shared/types/events";
import type { TranscriptBlock } from "../shared/types/transcript";
import { cleanTerminal, type PromptSubmission, type TerminalHost } from "./terminal-host";

const DEFAULT_RECEIPT_TIMEOUT_MS = 45_000;
const BACKFILL_RECEIPT_WINDOW_MS = 15 * 60_000;

export interface DeliveryControllerOptions {
  taskId: TaskId;
  provider: RuntimeProvider;
  terminalHost: TerminalHost;
  eventSink: (event: RuntimeEvent) => void;
  hasLiveTranscriptSource: () => boolean;
  receiptTimeoutMs?: number;
}

interface InFlightDelivery {
  itemId: DeliveryItemId;
  submittedAtMs: number;
  allowPtyEchoReceipt: boolean;
  ptyEchoTail: string;
}

interface PtyEchoBackfill {
  itemId: DeliveryItemId;
  text: string;
  runId: RunId | null;
  submittedAtMs: number;
  expiresAtMs: number;
}

export class DeliveryController {
  private readonly taskId: TaskId;
  private readonly provider: RuntimeProvider;
  private readonly terminalHost: TerminalHost;
  private readonly eventSink: (event: RuntimeEvent) => void;
  private readonly hasLiveTranscriptSource: () => boolean;
  private readonly receiptTimeoutMs: number;
  private readonly items: DeliveryQueueItem[] = [];
  private readonly ptyEchoBackfills: PtyEchoBackfill[] = [];
  private seq = 0;
  private inFlight: InFlightDelivery | null = null;
  private receiptTimer: NodeJS.Timeout | null = null;

  constructor(options: DeliveryControllerOptions) {
    this.taskId = options.taskId;
    this.provider = options.provider;
    this.terminalHost = options.terminalHost;
    this.eventSink = options.eventSink;
    this.hasLiveTranscriptSource = options.hasLiveTranscriptSource;
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  }

  enqueue(text: string): DeliveryQueueItem {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Cannot queue an empty prompt.");
    }

    const item: DeliveryQueueItem = {
      id: `delivery-${Date.now()}-${++this.seq}`,
      taskId: this.taskId,
      text: trimmed,
      status: "queued",
      enqueuedAt: new Date().toISOString(),
      deliveringAt: null,
      runId: null,
      receipt: null,
      failureReason: null,
    };
    this.items.push(item);
    this.emitState();
    this.pump();
    return item;
  }

  cancel(itemId: DeliveryItemId): void {
    const index = this.items.findIndex((item) => item.id === itemId);
    if (index === -1) {
      return;
    }
    if (this.items[index]?.status === "delivering") {
      throw new Error("Cannot cancel a message while it is being delivered.");
    }
    this.items.splice(index, 1);
    this.emitState();
    this.pump();
  }

  retry(itemId: DeliveryItemId): void {
    const item = this.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      return;
    }
    if (item.status !== "undelivered") {
      throw new Error("Only undelivered messages can be retried.");
    }
    item.status = "queued";
    item.failureReason = null;
    item.deliveringAt = null;
    item.runId = null;
    item.receipt = null;
    this.emitState();
    this.pump();
  }

  dispose(): void {
    this.clearReceiptTimer();
  }

  handleRuntimeEvent(event: RuntimeEvent): void {
    if (event.type === "pty:data") {
      this.handlePtyData(event.payload.data);
      return;
    }
    if (event.type === "transcript:blocks") {
      this.handleTranscriptBlocks(event.payload.upserts);
      return;
    }
    this.pump();
  }

  state(): DeliveryTaskState {
    return {
      taskId: this.taskId,
      provider: this.provider,
      deliverable: this.canDeliver(),
      activeRun: this.terminalHost.hasActiveRun(),
      approvalActive: this.terminalHost.isApprovalActive(),
      idleComposer: this.terminalHost.isIdleComposerReady(),
      queue: this.items.map((item) => ({ ...item })),
    };
  }

  private pump(): void {
    if (this.inFlight) {
      this.emitState();
      return;
    }

    const next = this.nextQueuedItem();
    if (!next) {
      this.emitState();
      return;
    }
    if (!this.canDeliver()) {
      this.emitState();
      return;
    }

    this.deliver(next);
  }

  private nextQueuedItem(): DeliveryQueueItem | null {
    for (const item of this.items) {
      if (item.status === "undelivered") {
        return null;
      }
      if (item.status === "queued") {
        return item;
      }
    }
    return null;
  }

  private canDeliver(): boolean {
    return (
      !this.inFlight &&
      !this.terminalHost.hasActiveRun() &&
      !this.terminalHost.isApprovalActive() &&
      this.terminalHost.isIdleComposerReady()
    );
  }

  private deliver(item: DeliveryQueueItem): void {
    item.status = "delivering";
    item.deliveringAt = new Date().toISOString();
    item.failureReason = null;
    this.emitState();

    let submission: PromptSubmission | null = null;
    try {
      submission = this.terminalHost.submitPrompt(item.text);
    } catch (error) {
      item.status = isApprovalGuardError(error) ? "queued" : "undelivered";
      item.deliveringAt = null;
      item.failureReason = isApprovalGuardError(error)
        ? null
        : error instanceof Error
          ? error.message
          : String(error);
      this.inFlight = null;
      this.emitState();
      return;
    }

    if (!submission) {
      item.status = "undelivered";
      item.deliveringAt = null;
      item.failureReason = "Prompt text was empty after trimming.";
      this.emitState();
      return;
    }

    item.runId = submission.runId;
    this.inFlight = {
      itemId: item.id,
      submittedAtMs: Date.parse(submission.submittedAt),
      allowPtyEchoReceipt: this.provider === "claude" && !this.hasLiveTranscriptSource(),
      ptyEchoTail: "",
    };
    this.armReceiptTimer(item.id);
    this.emitState();
  }

  private handlePtyData(data: string): void {
    if (!this.inFlight?.allowPtyEchoReceipt) {
      return;
    }
    const item = this.items.find((candidate) => candidate.id === this.inFlight?.itemId);
    if (!item || item.status !== "delivering") {
      return;
    }

    this.inFlight.ptyEchoTail = `${this.inFlight.ptyEchoTail}${data}`.slice(-16_000);
    if (!containsPromptEcho(this.inFlight.ptyEchoTail, item.text)) {
      return;
    }

    const submittedAtMs = this.inFlight.submittedAtMs;
    const receipt: DeliveryReceipt = {
      source: "pty-composer-echo",
      receivedAt: new Date().toISOString(),
      runId: item.runId,
      sourceId: null,
      blockId: null,
      backfilled: false,
    };
    this.completeDelivery(item, receipt);
    this.ptyEchoBackfills.push({
      itemId: item.id,
      text: item.text,
      runId: item.runId,
      submittedAtMs,
      expiresAtMs: Date.now() + BACKFILL_RECEIPT_WINDOW_MS,
    });
  }

  private handleTranscriptBlocks(blocks: TranscriptBlock[]): void {
    this.dropExpiredBackfills();
    for (const block of blocks) {
      if (block.kind !== "user-message") {
        continue;
      }
      this.receiptFromUserBlock(block);
      this.backfillPtyReceipt(block);
    }
    this.pump();
  }

  private receiptFromUserBlock(block: Extract<TranscriptBlock, { kind: "user-message" }>): void {
    if (!this.inFlight) {
      return;
    }
    const item = this.items.find((candidate) => candidate.id === this.inFlight?.itemId);
    if (!item || item.status !== "delivering" || !matchesReceiptText(item.text, block)) {
      return;
    }

    const receipt: DeliveryReceipt = {
      source: "provider-transcript",
      receivedAt: new Date().toISOString(),
      runId: block.runId ?? item.runId,
      sourceId: block.sourceId,
      blockId: block.id,
      backfilled: false,
    };
    this.completeDelivery(item, receipt);
  }

  private backfillPtyReceipt(block: Extract<TranscriptBlock, { kind: "user-message" }>): void {
    const backfill = this.ptyEchoBackfills.find(
      (candidate) =>
        candidate.expiresAtMs > Date.now() &&
        matchesReceiptText(candidate.text, block) &&
        Math.abs(Date.parse(block.ts) - candidate.submittedAtMs) <= BACKFILL_RECEIPT_WINDOW_MS,
    );
    if (!backfill) {
      return;
    }

    const receipt: DeliveryReceipt = {
      source: "provider-transcript",
      receivedAt: new Date().toISOString(),
      runId: block.runId ?? backfill.runId,
      sourceId: block.sourceId,
      blockId: block.id,
      backfilled: true,
    };
    this.emitReceipt(backfill.itemId, {
      id: backfill.itemId,
      taskId: this.taskId,
      text: backfill.text,
      status: "delivered",
      enqueuedAt: new Date(backfill.submittedAtMs).toISOString(),
      deliveringAt: new Date(backfill.submittedAtMs).toISOString(),
      runId: receipt.runId,
      receipt,
      failureReason: null,
    }, receipt);
  }

  private completeDelivery(item: DeliveryQueueItem, receipt: DeliveryReceipt): void {
    this.clearReceiptTimer();
    item.status = "delivered";
    item.receipt = receipt;
    item.failureReason = null;
    this.emitReceipt(item.id, item, receipt);

    const index = this.items.findIndex((candidate) => candidate.id === item.id);
    if (index !== -1) {
      this.items.splice(index, 1);
    }
    this.inFlight = null;
    this.emitState();
    this.pump();
  }

  private armReceiptTimer(itemId: DeliveryItemId): void {
    this.clearReceiptTimer();
    this.receiptTimer = setTimeout(() => {
      const item = this.items.find((candidate) => candidate.id === itemId);
      if (!item || item.status !== "delivering") {
        return;
      }
      item.status = "undelivered";
      item.failureReason = "No delivery receipt was observed in the provider transcript.";
      this.inFlight = null;
      this.clearReceiptTimer();
      this.emitState();
    }, this.receiptTimeoutMs);
  }

  private clearReceiptTimer(): void {
    if (!this.receiptTimer) {
      return;
    }
    clearTimeout(this.receiptTimer);
    this.receiptTimer = null;
  }

  private dropExpiredBackfills(): void {
    const now = Date.now();
    for (let index = this.ptyEchoBackfills.length - 1; index >= 0; index -= 1) {
      if ((this.ptyEchoBackfills[index]?.expiresAtMs ?? 0) <= now) {
        this.ptyEchoBackfills.splice(index, 1);
      }
    }
  }

  private emitState(): void {
    this.emitEvent("delivery:state", this.state());
  }

  private emitReceipt(
    itemId: DeliveryItemId,
    item: DeliveryQueueItem | null,
    receipt: DeliveryReceipt,
  ): void {
    this.emitEvent("delivery:receipt", {
      taskId: this.taskId,
      itemId,
      item: item ? { ...item } : {
        id: itemId,
        taskId: this.taskId,
        text: "",
        status: "delivered",
        enqueuedAt: receipt.receivedAt,
        deliveringAt: receipt.receivedAt,
        runId: receipt.runId,
        receipt,
        failureReason: null,
      },
      receipt,
    });
  }

  private emitEvent<T extends RuntimeEvent["type"]>(
    type: T,
    payload: Extract<RuntimeEvent, { type: T }>["payload"],
  ): void {
    this.eventSink({
      type,
      payload,
      ts: new Date().toISOString(),
    } as Extract<RuntimeEvent, { type: T }>);
  }
}

function matchesReceiptText(
  text: string,
  block: Extract<TranscriptBlock, { kind: "user-message" }>,
): boolean {
  const prompt = text.trim();
  const received = block.text.trim();
  return prompt === received || (block.command !== null && prompt.startsWith(block.command));
}

function containsPromptEcho(rawText: string, text: string): boolean {
  const clean = normalizeText(cleanTerminal(rawText));
  return clean.includes(normalizeText(text));
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function isApprovalGuardError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("native approval screen");
}
