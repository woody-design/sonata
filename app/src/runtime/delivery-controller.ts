import type {
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
import { quotePathForText } from "./shell-quote";
import { cleanTerminal, type PromptSubmission, type TerminalHost } from "./terminal-host";

const DEFAULT_RECEIPT_TIMEOUT_MS = 45_000;
const BACKFILL_RECEIPT_WINDOW_MS = 15 * 60_000;
// Gate key for id-less approval events (the scraped native panel — Codex,
// the broker's timeout fallback, resurfaces). One screen, one panel.
const SCRAPE_APPROVAL_KEY = "scrape-panel";
// pump() is event-driven, but the boot latch opens with no pump-triggering
// event: the structural composer check in pump() IS the boot signal (the
// `task:accepts-input` event that used to announce it was retired in S6 —
// its emitter lived inside the starved between-runs poller and never fired
// in the full app; the poll opens the latch ~1s after spawn, probe
// s6-diags). While a queued item is blocked, the pump re-checks at this
// cadence until it can deliver; the timer is idempotent + unref'd.
// (Send-is-send removed the wedge alarm — a queued item is now always
// either understandably blocked, or shown its reason by the per-item
// delivery label.)
const DEFAULT_PUMP_RETRY_INTERVAL_MS = 500;

export interface DeliveryControllerOptions {
  taskId: TaskId;
  provider: RuntimeProvider;
  terminalHost: TerminalHost;
  eventSink: (event: RuntimeEvent) => void;
  hasLiveTranscriptSource: () => boolean;
  receiptTimeoutMs?: number;
  /** Test injection point; production uses the 500ms default. */
  pumpRetryIntervalMs?: number;
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
  private readonly receiptTimeoutMs: number;
  private readonly items: DeliveryQueueItem[] = [];
  private readonly ptyEchoBackfills: PtyEchoBackfill[] = [];
  private seq = 0;
  private inFlight: InFlightDelivery | null = null;
  // Boot latch (send-is-send): the CLI's composer-ready is a screen scrape
  // that can stay false forever under a continuously-animating TUI. We gate
  // the FIRST send on it once — the latch flips the first time the composer
  // accepts input and never closes — then stop re-gating delivery on the
  // scrape. After boot, a send writes as soon as no approval owns the
  // screen; the CLI's own queue absorbs anything mid-turn. Exposed on
  // DeliveryTaskState as the honest "still starting?" display bit (S6).
  private bootLatched = false;
  // "A question is addressed to the human" — KEYED per ask (S6 review P1: a
  // single boolean reopened the gate on the FIRST decision while a second
  // broker ask was still pending — and, worse, while an EXPIRED ask's native
  // panel sat rendered, the digit-swallow class). Broker asks key by their
  // approvalId; the scrape's rendered panel keys by a sentinel (one panel at
  // a time on a single screen). An `approval:expired` transitions its key to
  // "expired" instead of removing it — the ask is still pending (native
  // panel incoming), so the gate stays closed through the expiry→scrape gap
  // (S2 reviewer P1/P2 semantics, now per-ask). Ownership transfers when the
  // scrape side resolves: a no-id decision clears the sentinel AND the
  // oldest expired key (panels render in ask order — the answered panel IS
  // that ask). The scrape flag (isApprovalActive) only sees rendered panels,
  // so it misses the whole broker-hold window — these keys are what cover it.
  private readonly pendingApprovalKeys = new Map<string, "asked" | "expired">();
  private receiptTimer: NodeJS.Timeout | null = null;
  private readonly pumpRetryIntervalMs: number;
  private pumpRetryTimer: NodeJS.Timeout | null = null;

  constructor(options: DeliveryControllerOptions) {
    this.taskId = options.taskId;
    this.provider = options.provider;
    this.terminalHost = options.terminalHost;
    this.eventSink = options.eventSink;
    this.hasLiveTranscriptSource = options.hasLiveTranscriptSource;
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
    this.pumpRetryIntervalMs = options.pumpRetryIntervalMs ?? DEFAULT_PUMP_RETRY_INTERVAL_MS;
  }

  enqueue(text: string, attachments: DeliveryAttachment[] = []): DeliveryQueueItem {
    const trimmed = text.trim();
    // Channel split (owned here so item.text == what is delivered → receipts
    // match, and referenced originals never enter item.attachments → cleanup
    // can never delete them): images chip natively; a file/folder is a path
    // mention folded into the prompt text. A non-image path does not chip, so
    // placing it in the text — quoted, on its own line — is the honest wire.
    const imageAttachments = attachments.filter(
      (attachment) => attachment.kind !== "file" && attachment.kind !== "folder",
    );
    const referencePaths = attachments
      .filter((attachment) => attachment.kind === "file" || attachment.kind === "folder")
      .map((attachment) => quotePathForText(attachment.path));
    const fullText = [trimmed, ...referencePaths].filter((part) => part.length > 0).join("\n");
    if (!fullText && imageAttachments.length === 0) {
      throw new Error("Cannot queue an empty prompt without attachments.");
    }

    const item: DeliveryQueueItem = {
      id: `delivery-${Date.now()}-${++this.seq}`,
      taskId: this.taskId,
      text: fullText,
      attachments: imageAttachments.map((attachment) => ({ ...attachment })),
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

  dispose(): void {
    this.clearReceiptTimer();
    this.clearPumpRetry();
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
    if (event.type === "approval:detected") {
      this.pendingApprovalKeys.set(event.payload.approvalId ?? SCRAPE_APPROVAL_KEY, "asked");
    } else if (event.type === "approval:decision") {
      const approvalId = event.payload.approvalId ?? null;
      if (approvalId) {
        this.pendingApprovalKeys.delete(approvalId);
      } else {
        // A scrape/native answer resolves the RENDERED panel. If expired
        // broker asks are queued behind it, that panel IS the oldest of them
        // (panels render in ask order) — transfer ownership (see the field).
        this.pendingApprovalKeys.delete(SCRAPE_APPROVAL_KEY);
        for (const [key, state] of this.pendingApprovalKeys) {
          if (state === "expired") {
            this.pendingApprovalKeys.delete(key);
            break;
          }
        }
      }
    } else if (event.type === "approval:expired") {
      // Still pending — the native panel is taking over; the key gates on.
      if (event.payload.approvalId) {
        this.pendingApprovalKeys.set(event.payload.approvalId, "expired");
      }
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
      // The honest "is the CLI still starting?" bit for display copy: false
      // only before the boot latch opens. The old idleComposer/acceptsInput
      // fields (continuous composer-ready scrapes) were retired in S6 —
      // idleComposer gated on the starved task-ready flag and read
      // permanently false in the full app.
      bootLatched: this.bootLatched,
      queue: this.items.map((item) => ({ ...item })),
    };
  }

  private pump(): void {
    // Boot latch: latch the first time the structural check reports the
    // composer ready (the ONLY boot signal since S6 — see the pump-retry
    // comment above). After that the scrape never re-gates delivery
    // (send-is-send). Kept here (not in canDeliver) so canDeliver stays a
    // pure query for state()/wedge reads.
    if (!this.bootLatched && this.terminalHost.acceptsPromptInput()) {
      this.bootLatched = true;
    }
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
      // (run/approval) usually do, but a startup or post-resume interstitial
      // can clear with NO pump-triggering event, which wedged the queue forever
      // (fresh-session and post-restart "stuck Queued"). A 500ms canDeliver
      // re-check while blocked is negligible (the timer is unref'd and idempotent).
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
    // An undelivered item does NOT block the queue (S6). Send-is-send: the
    // bytes were written — "undelivered" means "no receipt observed", a
    // report, not a delivery gate. The old head-block was a queue-era hold
    // with no unblock affordance left (the retry surface died with the S1c
    // panel), so one missed receipt silently killed every later send.
    for (const item of this.items) {
      if (item.status === "queued") {
        return item;
      }
    }
    return null;
  }

  private canDeliver(): boolean {
    return (
      !this.inFlight &&
      // One-shot boot readiness — NOT a continuous scrape gate. Once the CLI
      // has accepted input, we never wait on the (animating-TUI-fragile)
      // idle-prompt scrape again.
      this.bootLatched &&
      // Write-through (Claude): a mid-turn send writes straight into the CLI's
      // native queue — do NOT hold on an active run. The queued message's run
      // begins honestly on its own UserPromptSubmit hook when the CLI dequeues
      // it. Codex has no native queue signal, so it keeps holding until the run
      // ends (Stop/scrape → re-pump).
      (this.provider === "claude" || !this.terminalHost.hasActiveRun()) &&
      // Pending-question guard: a pasted prompt's characters would be consumed
      // as answers by a live approval panel (digit-swallow → unintended
      // approval). `isApprovalActive` is the scrape flag (rendered panels
      // only); the keyed map also covers hook-broker approvals — where no
      // panel renders while the broker holds — PER ASK, so deciding one of
      // two concurrent asks cannot reopen the gate (S6 review P1). This is
      // the ONLY question-guard: slash-opened panels no longer hold delivery
      // (S3, decision A) — a paste into a panel the user opened themselves is
      // visible in the co-present terminal and recoverable, while a detector
      // false-positive would be an invisible hold (the S1 wedge class).
      !this.terminalHost.isApprovalActive() &&
      this.pendingApprovalKeys.size === 0
    );
  }

  private deliver(item: DeliveryQueueItem): void {
    item.status = "delivering";
    item.deliveringAt = new Date().toISOString();
    item.failureReason = null;
    this.emitState();

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
    // Write-through (mid-turn send → no run started → runId null): the bytes are
    // in the CLI's native queue (P2/P6) — it's sent. Its transcript block only
    // arrives when the CLI DEQUEUES it, which can be far later than the 45s
    // receipt timeout (behind a long current turn). Arming the timer here would
    // false-mark a delivered message "undelivered" AND, once inFlight cleared,
    // the late transcript block could no longer reconcile it (reviewer P1) —
    // made worse by S1c removing the retry surface. So complete now with a
    // native-queue receipt; the transcript is corroboration, not a gate.
    if (!submission.runId) {
      this.completeDelivery(item, {
        source: "native-queue",
        receivedAt: new Date().toISOString(),
        runId: null,
        sourceId: null,
        blockId: null,
        backfilled: false,
      });
      return;
    }
    // A slash run (verbatim command on an idle composer, S3) can never earn a
    // transcript receipt: local commands write no user-block to the JSONL, and
    // the echo path is off once the transcript is live. Arming the 45s timer
    // marked it undelivered — and at the time an undelivered head blocked
    // nextQueuedItem() forever (the S4 /config wedge, s4-diags/skill-dispatch
    // evidence; S6 removed the head-block, but a false "Undelivered" report
    // would still be a lie). Sent-is-sent: the write happened and the
    // command's effect is visible in the co-present terminal; the run's own
    // completion is tracked separately by the structural idle re-check.
    if (submission.kind === "slash") {
      this.completeDelivery(item, {
        source: "slash-write",
        receivedAt: new Date().toISOString(),
        runId: submission.runId,
        sourceId: null,
        blockId: null,
        backfilled: false,
      });
      return;
    }
    this.inFlight = {
      itemId: item.id,
      submittedAtMs: Date.parse(submission.submittedAt),
      allowPtyEchoReceipt:
        item.attachments.length === 0 && this.provider === "claude" && !this.hasLiveTranscriptSource(),
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
    if (!this.inFlight) {
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
      text: backfill.text,
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
      // The missed receipt is reported, not enforced — anything queued
      // behind this item flows immediately (S6, no head-block).
      this.pump();
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
 * an approval. The item stays queued and delivers when the state clears —
 * never silently into it.
 */
function isDeliveryGuardError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("native approval screen");
}
