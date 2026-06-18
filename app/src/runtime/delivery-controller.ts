import type {
  DeliveryControlChange,
  DeliveryAttachment,
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
// Anthropic's own background-job infra treats "wedged on a dialog" as a
// timeout-detected state (~45s). Same stance here: a queued message blocked
// this long with no understandable reason gets an honest signal, not silence.
const DEFAULT_WEDGE_AFTER_MS = 45_000;
const DEFAULT_WEDGE_CHECK_INTERVAL_MS = 5_000;
// pump() is event-driven, but NO blocker is trusted to re-pump on its own
// resolution event: the accepts-input gate flips silently (PTY-quiet recovery
// emits no event), and even the "event-backed" blockers (run/approval/modal) can
// clear with no pump-triggering event — a startup or post-resume interstitial
// that disarms leaves the queue wedged forever (observed: fresh-session and
// post-restart "stuck Queued"). So while ANY queued item is blocked, the pump
// polls at this cadence until it can deliver; the timer is idempotent + unref'd,
// and the 5s wedge alarm backs a genuinely stuck queue.
const DEFAULT_PUMP_RETRY_INTERVAL_MS = 500;

export interface DeliveryControllerOptions {
  taskId: TaskId;
  provider: RuntimeProvider;
  terminalHost: TerminalHost;
  eventSink: (event: RuntimeEvent) => void;
  hasLiveTranscriptSource: () => boolean;
  applyControlChange?: (change: DeliveryControlChange) => Promise<void>;
  cleanupAttachments?: (attachments: DeliveryAttachment[]) => void;
  receiptTimeoutMs?: number;
  /** Test injection points; production uses the 45s/5s/500ms defaults. */
  wedgeAfterMs?: number;
  wedgeCheckIntervalMs?: number;
  pumpRetryIntervalMs?: number;
}

interface InFlightDelivery {
  itemId: DeliveryItemId;
  kind: "prompt" | "control";
  submittedAtMs: number;
  allowPtyEchoReceipt: boolean;
  ptyEchoTail: string;
}

interface PtyEchoBackfill {
  itemId: DeliveryItemId;
  text: string;
  attachments: DeliveryAttachment[];
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
  private readonly applyControlChange: ((change: DeliveryControlChange) => Promise<void>) | null;
  private readonly cleanupAttachments: ((attachments: DeliveryAttachment[]) => void) | null;
  private readonly receiptTimeoutMs: number;
  private readonly items: DeliveryQueueItem[] = [];
  private readonly ptyEchoBackfills: PtyEchoBackfill[] = [];
  private seq = 0;
  private inFlight: InFlightDelivery | null = null;
  private receiptTimer: NodeJS.Timeout | null = null;
  private readonly wedgeAfterMs: number;
  private wedgeTimer: NodeJS.Timeout | null = null;
  private blockedSinceMs: number | null = null;
  private wedgedSince: string | null = null;
  private readonly pumpRetryIntervalMs: number;
  private pumpRetryTimer: NodeJS.Timeout | null = null;

  constructor(options: DeliveryControllerOptions) {
    this.taskId = options.taskId;
    this.provider = options.provider;
    this.terminalHost = options.terminalHost;
    this.eventSink = options.eventSink;
    this.hasLiveTranscriptSource = options.hasLiveTranscriptSource;
    this.applyControlChange = options.applyControlChange ?? null;
    this.cleanupAttachments = options.cleanupAttachments ?? null;
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
    this.wedgeAfterMs = options.wedgeAfterMs ?? DEFAULT_WEDGE_AFTER_MS;
    this.pumpRetryIntervalMs = options.pumpRetryIntervalMs ?? DEFAULT_PUMP_RETRY_INTERVAL_MS;
    this.wedgeTimer = setInterval(
      () => this.evaluateWedge(),
      options.wedgeCheckIntervalMs ?? DEFAULT_WEDGE_CHECK_INTERVAL_MS,
    );
    // Never keep a process alive just to watch for wedges.
    this.wedgeTimer.unref?.();
  }

  enqueue(text: string, attachments: DeliveryAttachment[] = []): DeliveryQueueItem {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) {
      throw new Error("Cannot queue an empty prompt without attachments.");
    }

    const item: DeliveryQueueItem = {
      id: `delivery-${Date.now()}-${++this.seq}`,
      taskId: this.taskId,
      kind: "prompt",
      text: trimmed,
      control: null,
      attachments: attachments.map((attachment) => ({ ...attachment })),
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

  enqueueControl(change: DeliveryControlChange): DeliveryQueueItem {
    const label = change.label.trim();
    if (!label) {
      throw new Error("Cannot queue an unlabeled control change.");
    }

    const item: DeliveryQueueItem = {
      id: `delivery-${Date.now()}-${++this.seq}`,
      taskId: this.taskId,
      kind: "control",
      text: label,
      control: change,
      attachments: [],
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
      throw new Error("Cannot cancel an item while it is being delivered.");
    }
    const [item] = this.items.splice(index, 1);
    if (item?.attachments.length) {
      this.cleanupAttachments?.(item.attachments);
    }
    this.emitState();
    this.pump();
  }

  retry(itemId: DeliveryItemId): void {
    const item = this.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      return;
    }
    if (item.status !== "undelivered") {
      throw new Error("Only undelivered items can be retried.");
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
    this.clearPumpRetry();
    if (this.wedgeTimer) {
      clearInterval(this.wedgeTimer);
      this.wedgeTimer = null;
    }
  }

  /**
   * A static panel emits no events (P1), so the wedge check needs its own
   * clock. "Wedged" = queued items blocked with no understandable reason:
   * a run, an approval, or the human holding the keys all explain
   * themselves elsewhere.
   */
  private evaluateWedge(): void {
    const hasQueued = this.items.some((item) => item.status === "queued");
    const understandablyBusy =
      this.terminalHost.hasActiveRun() ||
      this.terminalHost.isApprovalActive() ||
      this.terminalHost.isHumanHoldingInput();
    const blocked = hasQueued && !this.inFlight && !understandablyBusy && !this.canDeliver();
    if (!blocked) {
      this.blockedSinceMs = null;
      if (this.wedgedSince !== null) {
        this.wedgedSince = null;
        this.emitState();
      }
      return;
    }
    this.blockedSinceMs ??= Date.now();
    if (this.wedgedSince === null && Date.now() - this.blockedSinceMs >= this.wedgeAfterMs) {
      this.wedgedSince = new Date().toISOString();
      this.emitState();
    }
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
      modalActive: this.terminalHost.isModalActive(),
      idleComposer: this.terminalHost.isIdleComposerReady(),
      acceptsInput: this.terminalHost.acceptsPromptInput(),
      wedgedSince: this.wedgedSince,
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
      this.clearPumpRetry();
      this.emitState();
      return;
    }
    if (!this.canDeliver()) {
      // A queued item can't go out yet — poll until it can. We do NOT trust the
      // blocker to re-pump on its own resolution event. The event-backed blockers
      // (run/approval/modal) usually do, but a startup or post-resume interstitial
      // can clear with NO pump-triggering event, which wedged the queue forever
      // (fresh-session and post-restart "stuck Queued"). A 500ms canDeliver
      // re-check while blocked is negligible (the timer is unref'd and idempotent),
      // and the 5s wedge alarm still backs a genuinely stuck queue.
      this.schedulePumpRetry();
      this.emitState();
      return;
    }

    this.clearPumpRetry();
    this.deliver(next);
  }


  private schedulePumpRetry(): void {
    if (this.pumpRetryTimer) {
      return;
    }
    this.pumpRetryTimer = setTimeout(() => {
      this.pumpRetryTimer = null;
      this.pump();
    }, this.pumpRetryIntervalMs);
    // Never keep the process alive just to retry a blocked queue.
    this.pumpRetryTimer.unref?.();
  }

  private clearPumpRetry(): void {
    if (!this.pumpRetryTimer) {
      return;
    }
    clearTimeout(this.pumpRetryTimer);
    this.pumpRetryTimer = null;
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
      // A detected panel blocks delivery as STATE — the idle-prompt
      // heuristic alone is one arrow keypress away from lying (P1b).
      !this.terminalHost.isModalActive() &&
      // Single writer: while the human is actively typing in the terminal, the
      // queue holds (S2). A keystroke into a live panel can flip the idle
      // heuristic (P1b), so an automation paste must never land mid-burst — this
      // is a safety property, scoped to the activity window rather than a mode.
      !this.terminalHost.isHumanHoldingInput() &&
      // Structural accepts-input gate: delivers as soon as the provider
      // composer exists (~3s), without waiting for the task-ready floor.
      this.terminalHost.acceptsPromptInput()
    );
  }

  private deliver(item: DeliveryQueueItem): void {
    item.status = "delivering";
    item.deliveringAt = new Date().toISOString();
    item.failureReason = null;
    this.emitState();

    if (item.kind === "control") {
      void this.deliverControl(item);
      return;
    }

    let submission: PromptSubmission | null = null;
    try {
      submission = this.terminalHost.submitPrompt(item.text, {
        attachments: item.attachments.map((attachment) => ({ path: attachment.path })),
      });
    } catch (error) {
      item.status = isDeliveryGuardError(error) ? "queued" : "undelivered";
      item.deliveringAt = null;
      item.failureReason = isDeliveryGuardError(error)
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
      kind: "prompt",
      submittedAtMs: Date.parse(submission.submittedAt),
      allowPtyEchoReceipt:
        item.attachments.length === 0 && this.provider === "claude" && !this.hasLiveTranscriptSource(),
      ptyEchoTail: "",
    };
    this.armReceiptTimer(item.id);
    this.emitState();
  }

  private async deliverControl(item: DeliveryQueueItem): Promise<void> {
    if (!item.control) {
      item.status = "undelivered";
      item.deliveringAt = null;
      item.failureReason = "Control change was missing its target.";
      this.emitState();
      return;
    }
    if (!this.applyControlChange) {
      item.status = "undelivered";
      item.deliveringAt = null;
      item.failureReason = "No native control driver is available for this Task.";
      this.emitState();
      return;
    }

    this.inFlight = {
      itemId: item.id,
      kind: "control",
      submittedAtMs: Date.now(),
      allowPtyEchoReceipt: false,
      ptyEchoTail: "",
    };
    this.emitState();

    try {
      await this.applyControlChange(item.control);
      const receipt: DeliveryReceipt = {
        source: "native-control",
        receivedAt: new Date().toISOString(),
        runId: null,
        sourceId: null,
        blockId: null,
        backfilled: false,
      };
      this.completeDelivery(item, receipt);
    } catch (error) {
      item.status = "undelivered";
      item.deliveringAt = null;
      item.failureReason = error instanceof Error ? error.message : String(error);
      this.inFlight = null;
      this.emitState();
    }
  }

  private handlePtyData(data: string): void {
    if (this.inFlight?.kind !== "prompt" || !this.inFlight.allowPtyEchoReceipt) {
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
      attachments: item.attachments.map((attachment) => ({ ...attachment })),
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
    if (!this.inFlight || this.inFlight.kind !== "prompt") {
      return;
    }
    const item = this.items.find((candidate) => candidate.id === this.inFlight?.itemId);
    if (!item || item.status !== "delivering" || !matchesReceipt(item, block)) {
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
        matchesReceipt(candidate, block) &&
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
      kind: "prompt",
      text: backfill.text,
      control: null,
      attachments: backfill.attachments.map((attachment) => ({ ...attachment })),
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
        kind: "prompt",
        text: "",
        control: null,
        attachments: [],
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

function matchesReceipt(
  item: { text: string; attachments: DeliveryAttachment[] },
  block: Extract<TranscriptBlock, { kind: "user-message" }>,
): boolean {
  const prompt = normalizeReceiptText(item.text);
  const received = normalizeReceiptText(block.text);
  const textMatches =
    prompt.length === 0 ||
    prompt === received ||
    (block.command !== null && prompt.startsWith(block.command));
  if (!textMatches) {
    return false;
  }

  const expectedImages = item.attachments.length;
  if (expectedImages === 0) {
    return true;
  }
  const receivedImages = (block.attachments ?? []).filter((attachment) => attachment.kind === "image").length;
  return receivedImages >= expectedImages || imageMarkerCount(block.text) >= expectedImages;
}

function containsPromptEcho(rawText: string, text: string): boolean {
  const clean = normalizeText(cleanTerminal(rawText));
  return clean.includes(normalizeText(text));
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function normalizeReceiptText(value: string): string {
  return normalizeText(value).replace(/\[Image\s+#\d+\]/gi, "").replace(/[ \t]+/g, " ").trim();
}

function imageMarkerCount(value: string): number {
  return value.match(/\[Image\s+#\d+\]/gi)?.length ?? 0;
}

/**
 * Guard errors are states, not failures: the screen is temporarily owned by
 * an approval, an interactive panel, or the human (take-over). The item
 * stays queued and delivers when the state clears — never silently into it.
 */
function isDeliveryGuardError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("native approval screen") ||
    message.includes("interactive panel") ||
    message.includes("controlling the terminal")
  );
}
