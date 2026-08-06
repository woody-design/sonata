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
import { normalizePromptForMatch } from "../shared/prompt-markers";
import { quotePathForText } from "./shell-quote";
import {
  ATTACHMENT_SUBMIT_WORST_CASE_MS,
  cleanTerminal,
  type PromptSubmission,
  type TerminalHost,
} from "./terminal-host";

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

// After the boot latch opens, hold the FIRST delivery this long before the
// bytes go out. Claude's TUI silently swallows the submit Enter inside a
// boot-init window that ends ≈SessionStart+300ms (probe
// spikes/first-prompt-enter-race, claude 2.1.210) — the pasted prompt text
// sticks in the composer, unsent. 500 ≈ 1.7× margin past the window's tail.
// Enforced in canDeliver(), so it covers BOTH latch paths (hook-first and the
// scrape fallback) and is permanently satisfied ~1s after boot — it costs
// nothing on any later send.
const DEFAULT_BOOT_DELIVERY_GRACE_MS = 500;

// The heal layer: if an in-flight prompt has earned no receipt by these
// elapsed delays, re-send the submit Enter (terminalHost.nudgePromptSubmit).
// This catches a first Enter the boot grace did NOT cover — and stays correct
// if a future CLI version shifts the swallow window (effect-verification, not
// a timing bet). An extra Enter on an already-empty composer is a no-op, so
// re-sending is safe.
//
// INVARIANT (echo-branch safety): the FIRST rung must stay below
// HUMAN_ACTIVE_WINDOW_MS (3500ms, terminal-host). The echo-reconciliation branch
// (attemptEnterRetry) fires an Enter for an item completed by the paint-only
// pty-echo receipt; its proof that it can't submit over a human's composed text
// relies on isHumanActivelyTyping blanketing all of [0, first-rung]. Retune the
// delays only while preserving `enterRetryDelaysMs[0] < HUMAN_ACTIVE_WINDOW_MS`.
const DEFAULT_ENTER_RETRY_DELAYS_MS = [2_500, 6_000];

export interface DeliveryControllerOptions {
  taskId: TaskId;
  provider: RuntimeProvider;
  terminalHost: TerminalHost;
  eventSink: (event: RuntimeEvent) => void;
  hasLiveTranscriptSource: () => boolean;
  receiptTimeoutMs?: number;
  /** Test injection point; production uses the 500ms default. */
  pumpRetryIntervalMs?: number;
  /** Boot-init Enter-swallow grace; production uses the 500ms default. Tests
   *  that assert immediate submission pass 0. */
  bootDeliveryGraceMs?: number;
  /** Elapsed delays at which an unreceipted in-flight prompt re-sends its
   *  submit Enter; production uses [2500, 6000]. Tests pass [] to disable. */
  enterRetryDelaysMs?: number[];
  /** Attachment submit worst-case for the startup margin assert; production
   *  uses the real ATTACHMENT_SUBMIT_WORST_CASE_MS. A mechanics test that sends
   *  no attachments passes 0 so its deliberately-tiny ladder is admissible. */
  attachmentWorstCaseMs?: number;
}

interface InFlightDelivery {
  itemId: DeliveryItemId;
  submittedAtMs: number;
  allowPtyEchoReceipt: boolean;
  ptyEchoTail: string;
  // UPS proved this delivery genuinely submitted (notePromptSubmittedByCli),
  // even though its transcript receipt has not yet landed. The Enter-retry
  // strict branch skips once set — a nudge now could Enter into an option-prompt
  // the model raced onto the screen after the real submit (the H1 class).
  submissionCorroborated: boolean;
}

interface PtyEchoBackfill {
  itemId: DeliveryItemId;
  text: string;
  attachments: DeliveryAttachment[];
  runId: RunId | null;
  submittedAtMs: number;
  expiresAtMs: number;
  // The provider transcript has since corroborated a REAL submission for this
  // item (a user-block matched). Until then the echo receipt only proves the
  // text painted into the composer — not that the Enter submitted — so the
  // Enter-retry's echo branch may still nudge (see attemptEnterRetry).
  corroborated: boolean;
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
  // Epoch ms at which the boot latch flipped (set once, alongside bootLatched).
  // canDeliver() holds the first send until bootDeliveryGraceMs has elapsed
  // from here — the Enter-swallow window is timed from the CLI's boot, and the
  // latch open is our earliest structural proxy for it.
  private bootLatchedAt: number | null = null;
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
  private readonly bootDeliveryGraceMs: number;
  private readonly enterRetryDelaysMs: number[];
  private enterRetryTimers: NodeJS.Timeout[] = [];
  // Enter re-sends the in-flight prompt earned (reported in the timeout's
  // failureReason). Reset when a fresh delivery goes in-flight.
  private enterRetriesAttempted = 0;
  // Monotonic delivery counter: bumped on every deliver() (any provider, any
  // completion shape). An Enter-retry ladder captures the value at arm time; a
  // rung whose captured seq is stale means a LATER delivery has since touched
  // the composer, so its Enter would land on someone else's prompt — skip it
  // (the stale-rung-into-item-B class). The echo branch survives its own
  // completion precisely because that completion does NOT bump this.
  private deliverySeq = 0;
  private attachmentNotice: string | null = null;
  // Emit-on-change (S1): the serialized DeliveryTaskState of the last event this
  // controller actually put on the wire, or null before the first one. See
  // emitState() for why the contract lives here.
  private lastEmittedState: string | null = null;

  constructor(options: DeliveryControllerOptions) {
    this.taskId = options.taskId;
    this.provider = options.provider;
    this.terminalHost = options.terminalHost;
    this.eventSink = options.eventSink;
    this.hasLiveTranscriptSource = options.hasLiveTranscriptSource;
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
    this.pumpRetryIntervalMs = options.pumpRetryIntervalMs ?? DEFAULT_PUMP_RETRY_INTERVAL_MS;
    this.bootDeliveryGraceMs = options.bootDeliveryGraceMs ?? DEFAULT_BOOT_DELIVERY_GRACE_MS;
    this.enterRetryDelaysMs = options.enterRetryDelaysMs ?? DEFAULT_ENTER_RETRY_DELAYS_MS;
    // Encode the attachment-margin invariant as a hard startup gate: an
    // attachment send's Enter can fire as late as ATTACHMENT_SUBMIT_WORST_CASE_MS
    // after submit, so the FIRST heal rung must sit strictly above that — else a
    // nudge could Enter while the paste sequence is still legitimately mid-flight
    // (and, for an effect-re-stamped ladder, the rung is re-armed from the Enter,
    // which must still fall after the worst case). Fail loud so a future retune of
    // either constant can never silently break the ladder. Vacuous when the
    // ladder is disabled (tests pass []).
    const attachmentWorstCaseMs = options.attachmentWorstCaseMs ?? ATTACHMENT_SUBMIT_WORST_CASE_MS;
    const firstEnterRetryRungMs = this.enterRetryDelaysMs[0];
    if (firstEnterRetryRungMs !== undefined && attachmentWorstCaseMs >= firstEnterRetryRungMs) {
      throw new Error(
        `Attachment submit worst-case (${attachmentWorstCaseMs}ms) must stay below the ` +
          `first Enter-retry rung (${firstEnterRetryRungMs}ms) — retune one so the heal ladder ` +
          `never nudges while an attachment paste is still in flight.`,
      );
    }
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
    // The partial-delivery notice is NOT cleared here. The user's natural
    // reaction to "3 of 6 images attached" is to enqueue the rest — clearing at
    // enqueue destroyed the only evidence of what went wrong before the recovery
    // send even ran. The notice stays sticky until an attachment send lands
    // FULLY (completeDelivery), which is the actual recovery signal.

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
    this.clearEnterRetries();
  }

  /**
   * The CLI is (re)initializing its input stack. SessionStart fires on startup,
   * resume, AND `/clear` — all repaint the composer through the same class of
   * Enter-swallow window (spikes/first-prompt-enter-race). Re-arm the boot grace
   * from now so the NEXT delivery lands past the fresh window.
   *
   * This closes the `/clear` write-through gap: a `/clear` sent long after boot
   * (latch already open, grace long-elapsed) leaves its run open, so a following
   * prompt write-throughs into the native queue and completes immediately —
   * arming no receipt, hence no Enter-retry. Re-arming the grace here is that
   * send's protection. A no-op before the latch first opens (the latch flow
   * stamps `bootLatchedAt` itself). Wired for BOTH providers; deliberately also
   * re-covers the resume repaint.
   */
  noteSessionBoundary(): void {
    if (this.bootLatched) {
      this.bootLatchedAt = Date.now();
    }
  }

  /**
   * The CLI fired `UserPromptSubmit` — authoritative proof a prompt actually
   * SUBMITTED. Corroborate the oldest matching, unexpired, uncorroborated echo
   * backfill so the Enter-retry echo branch stops treating that item as
   * possibly-stuck.
   *
   * This is the FAST corroboration path: the UPS hook (~300-500ms) beats rung 0
   * (2.5s) reliably, where the slow transcript-adoption chain (JSONL create →
   * discovery poll → tailer → transcript:blocks) plausibly does not on a fresh
   * session. Without it, a genuinely-submitted first message whose transcript is
   * still adopting would take a wasteful no-op rung-0 Enter (H2) — and, worse, if
   * the model raced an `AskUserQuestion` option-prompt onto the screen after the
   * submit, that Enter would answer a question addressed to the human (H1, the
   * digit/enter-swallow class; `isApprovalActive`/`pendingApprovalKeys` do not
   * cover option-prompt forms). A genuinely STUCK send fires no UPS, so nothing
   * is corroborated and rung 0 still heals it.
   *
   * Suppresses BOTH nudge branches: it corroborates every matching echo backfill
   * AND a matching strict in-flight delivery (via `submissionCorroborated`). It
   * is NOT a receipt — completion/receipt handling is unchanged; a real
   * transcript block still earns the receipt.
   *
   * Marks ALL same-text matches, not one. Text attribution between identical
   * twins is fundamentally unreliable, so a same-text UPS suppresses EVERY
   * same-text ladder. The failure direction is deliberate: a wrongly-suppressed
   * heal (a stale twin's UPS suppressing a genuinely-stuck send) degrades to the
   * honest 45s "undelivered" report — while the reverse error (a nudge Entering
   * into a raced option-prompt, H1) is made impossible by construction.
   */
  notePromptSubmittedByCli(promptText: string): void {
    const normalized = normalizePromptForMatch(promptText);
    const now = Date.now();
    for (const backfill of this.ptyEchoBackfills) {
      if (
        !backfill.corroborated &&
        backfill.expiresAtMs > now &&
        normalizePromptForMatch(backfill.text) === normalized
      ) {
        backfill.corroborated = true;
      }
    }
    if (this.inFlight && !this.inFlight.submissionCorroborated) {
      const item = this.items.find((candidate) => candidate.id === this.inFlight?.itemId);
      if (item && normalizePromptForMatch(item.text) === normalized) {
        this.inFlight.submissionCorroborated = true;
      }
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
    if (event.type === "approval:detected") {
      this.pendingApprovalKeys.set(event.payload.approvalId ?? SCRAPE_APPROVAL_KEY, "asked");
    } else if (event.type === "approval:decision") {
      const approvalId = event.payload.approvalId ?? null;
      if (approvalId) {
        this.pendingApprovalKeys.delete(approvalId);
        // The scrape can false-positive on the broker-held preview bytes
        // 100ms before the broker file is even read (the S5 wedge class,
        // re-manifested at this layer: stop-continue, 2026-07-03) — that
        // phantom sentinel is the SAME ask and dies with its decision. A
        // genuinely-live panel resurfaces via the S4 settle re-check and
        // re-adds the sentinel: worst case a ≤1.2s visible delay, never a
        // held gate.
        this.pendingApprovalKeys.delete(SCRAPE_APPROVAL_KEY);
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
      // Why the queue is not moving when a Rewind panel owns the screen. Without
      // this the status line would read "Queued" (or "Ready" on an empty queue)
      // while nothing could ever go out — the invisible-hold failure S3 decision
      // A warns about. Claude-only by construction (see isRewindPanelOpen).
      rewindPanelOpen: this.terminalHost.isRewindPanelOpen(),
      // The honest "is the CLI still starting?" bit for display copy: false
      // only before the boot latch opens. The old idleComposer/acceptsInput
      // fields (continuous composer-ready scrapes) were retired in S6 —
      // idleComposer gated on the starved task-ready flag and read
      // permanently false in the full app.
      bootLatched: this.bootLatched,
      attachmentNotice: this.attachmentNotice,
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
      this.bootLatchedAt = Date.now();
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
      // Boot-init Enter-swallow grace: the CLI's TUI drops the submit Enter for
      // a window ending ≈SessionStart+300ms (probe first-prompt-enter-race).
      // Hold the first delivery until bootDeliveryGraceMs has elapsed from the
      // latch open so the bytes land past that window. A blocked item re-pumps
      // via the 500ms poll (schedulePumpRetry), so it delivers promptly once
      // the grace clears. Permanently true ~1s after boot → zero cost later.
      this.bootLatchedAt !== null &&
      Date.now() - this.bootLatchedAt >= this.bootDeliveryGraceMs &&
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
      this.pendingApprovalKeys.size === 0 &&
      // Rewind-panel guard (RED LINE, claude ≥2.1.216): an Esc pair at an idle
      // composer opens a restore picker over the composer, and its `Enter to
      // continue` RESTORES the conversation (and possibly the code) to the
      // highlighted row. A delivery here would paste text and press Enter into
      // it. This is the narrow exception to decision A above — the "visible and
      // recoverable" premise fails for a restore, and the hold is itself
      // surfaced (`rewindPanelOpen` → the composer status line) rather than
      // silent. Self-clearing: the dismissal repaints the composer, and the
      // blocked item re-pumps on the 500ms poll armed below. See
      // TerminalHost.isRewindPanelOpen.
      !this.terminalHost.isRewindPanelOpen() &&
      // Control-switch guard (RED LINE): a mid-session switch can PARK a consent
      // dialog (a codex Full Access confirm — `waiting-user`, no timeout by
      // design) or hold an interstitial. A delivery here would paste text + Enter
      // into that dialog, auto-answering its default row ("Yes, continue anyway")
      // — a silent full-access grant the program forbids. Unlike the approval
      // scrape this covers ANY phase of the switch, parked included. A blocked
      // item re-pumps the instant the switch clears: the resolution ALWAYS emits
      // a settled/needs-attention `control-switch:state` event (after
      // clearPendingControlSwitch), which reaches handleRuntimeEvent → pump()
      // with the pointer already null (mirrors the approval:decision re-pump);
      // the 500ms schedulePumpRetry poll — armed on the blocked-path branch in
      // pump() — is the backstop for any clear that fires no event.
      !this.terminalHost.hasPendingControlSwitch()
    );
  }

  private deliver(item: DeliveryQueueItem): void {
    // Every delivery touches the composer — invalidate any prior Enter-retry
    // ladder that has not yet fired (ownership; see attemptEnterRetry).
    this.deliverySeq += 1;
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
      const guard = isDeliveryGuardError(error);
      item.status = guard ? "queued" : "undelivered";
      item.deliveringAt = null;
      item.failureReason = guard
        ? null
        : error instanceof Error
          ? error.message
          : String(error);
      this.inFlight = null;
      if (guard) {
        // Re-queued into a transient screen owner (an approval/control switch
        // appeared in the TOCTOU gap after canDeliver passed). Arm the 500ms
        // poll exactly like the blocked path in pump(): do NOT trust an
        // event-driven wakeup — a switch/interstitial can clear with no
        // pump-triggering event, which would wedge this item until an unrelated
        // event happened to fire.
        this.schedulePumpRetry();
      }
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
      submissionCorroborated: false,
    };
    this.armReceiptTimer(item.id);
    this.armEnterRetries(item.id);
    // An attachment send returned at WRITE time, but its submit Enter fires up
    // to ATTACHMENT_SUBMIT_WORST_CASE_MS later. Re-stamp the in-flight epoch and
    // re-arm the receipt timeout + heal ladder from the real Enter when the
    // effect signal arrives, so none of them count from the lying write time.
    // The write-time arm above is the floor if the effect never resolves (host
    // torn down); the margin invariant guarantees the effect precedes rung 0, so
    // no stale write-time rung ever fires before this re-arm clears it.
    if (submission.effect) {
      void submission.effect.then((effectAt) => {
        if (this.inFlight?.itemId !== item.id) {
          return;
        }
        this.inFlight.submittedAtMs = Date.parse(effectAt);
        this.armReceiptTimer(item.id);
        this.armEnterRetries(item.id);
      });
    }
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
      corroborated: false,
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
    if (!item || item.status !== "delivering") {
      return;
    }
    const match = receiptMatch(item, block);
    if (!match) {
      return;
    }

    const receipt: DeliveryReceipt = {
      source: "provider-transcript",
      receivedAt: new Date().toISOString(),
      runId: block.runId ?? item.runId,
      sourceId: block.sourceId,
      blockId: block.id,
      backfilled: false,
      ...(match.expectedImages > 0
        ? {
            expectedImages: match.expectedImages,
            receivedImages: match.receivedImages,
          }
        : {}),
    };
    if (match.receivedImages < match.expectedImages) {
      this.completePartialDelivery(item, receipt, match.receivedImages, match.expectedImages);
    } else {
      this.completeDelivery(item, receipt);
    }
  }

  private backfillPtyReceipt(block: Extract<TranscriptBlock, { kind: "user-message" }>): void {
    // Prefer an uncorroborated entry: this transcript block is the REAL
    // submission proof that upgrades an echo receipt, and flipping `corroborated`
    // both stops a re-emit on a later block and disarms the Enter-retry echo
    // branch (a genuine submit is now on record).
    const backfill = this.ptyEchoBackfills.find(
      (candidate) =>
        !candidate.corroborated &&
        candidate.expiresAtMs > Date.now() &&
        matchesReceipt(candidate, block) &&
        Math.abs(Date.parse(block.ts) - candidate.submittedAtMs) <= BACKFILL_RECEIPT_WINDOW_MS,
    );
    if (!backfill) {
      return;
    }
    backfill.corroborated = true;

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

  /**
   * The user stopped the run. Two duties (probe S0, stop-after-send race):
   *
   *  - Disarm the Enter-retry ladder unconditionally (seq bump): a rung firing
   *    after the stop would press Enter onto whatever the Esc-interrupt
   *    restored into the CLI's composer — re-submitting the very prompt the
   *    user just stopped.
   *  - When the terminal host canceled this delivery's deferred text/Enter
   *    writes (`promptWriteCanceled`), the bytes never (fully) reached the
   *    CLI: report the in-flight item `undelivered` NOW instead of letting it
   *    wait out the 45s receipt timeout as a false pending send.
   */
  handleStopRequested(info: { promptWriteCanceled: boolean; promptReachedComposer?: boolean }): void {
    this.deliverySeq += 1;
    this.clearEnterRetries();
    if (!info.promptWriteCanceled || !this.inFlight) {
      return;
    }
    // UPS already proved this delivery genuinely submitted — the canceled
    // write belonged to something else. Marking it undelivered here would be
    // a false, unreconcilable verdict (clearing inFlight drops the lagging
    // transcript receipt on the floor) — leave the receipt watch running.
    if (this.inFlight.submissionCorroborated) {
      return;
    }
    const item = this.items.find((candidate) => candidate.id === this.inFlight?.itemId);
    this.inFlight = null;
    this.clearReceiptTimer();
    if (item && item.status === "delivering") {
      item.status = "undelivered";
      item.deliveringAt = null;
      // Honest about how far the aborted sequence got. An attachment send's
      // Enter can lag ~1.65s behind its paste, so when the text/paths already
      // reached the composer (Enter not yet sent) the old blanket "before it
      // reached the CLI" was a lie.
      item.failureReason = info.promptReachedComposer
        ? "Send canceled by Stop after the prompt reached the CLI composer, but before it was submitted."
        : "Send canceled by Stop before it reached the CLI.";
    }
    this.emitState();
    // Anything queued behind the canceled item must not stall until the next
    // unrelated event (review F6); the pre-submit flood covers the restore
    // race an instant delivery could otherwise hit.
    this.pump();
  }

  private completeDelivery(
    item: DeliveryQueueItem,
    receipt: DeliveryReceipt,
    result: { status?: "delivered" | "delivered-partial"; notice?: string | null } = {},
  ): void {
    this.clearReceiptTimer();
    // An echo completion does NOT disarm the heal net. `pty-composer-echo` fires
    // when the prompt paints into the composer — which happens whether the Enter
    // submitted OR was swallowed — so it cannot prove submission. Leave the
    // ladder armed so its first rung can still reconcile (attemptEnterRetry's
    // echo branch). Every other receipt source (provider-transcript, native-
    // queue, slash-write) IS a real submission signal → clear the ladder.
    if (receipt.source !== "pty-composer-echo") {
      this.clearEnterRetries();
    }
    item.status = result.status ?? "delivered";
    item.receipt = receipt;
    item.failureReason = result.notice ?? null;
    // Clear the sticky partial-delivery notice only when an attachment-bearing
    // send lands FULLY — the recovery actually succeeded. A partial completion
    // (delivered-partial) keeps its own just-set notice; an attachment-less send
    // never touches it (so the evidence survives a text-only follow-up).
    if (item.attachments.length > 0 && item.status !== "delivered-partial") {
      this.attachmentNotice = null;
    }
    this.emitReceipt(item.id, item, receipt);

    const index = this.items.findIndex((candidate) => candidate.id === item.id);
    if (index !== -1) {
      this.items.splice(index, 1);
    }
    this.inFlight = null;
    this.emitState();
    this.pump();
  }

  private completePartialDelivery(
    item: DeliveryQueueItem,
    receipt: DeliveryReceipt,
    receivedImages: number,
    expectedImages: number,
  ): void {
    const notice = `${receivedImages} of ${expectedImages} images attached`;
    this.attachmentNotice = notice;
    this.completeDelivery(item, receipt, { status: "delivered-partial", notice });
  }

  private armReceiptTimer(itemId: DeliveryItemId): void {
    this.clearReceiptTimer();
    this.receiptTimer = setTimeout(() => {
      const item = this.items.find((candidate) => candidate.id === itemId);
      if (!item || item.status !== "delivering") {
        return;
      }
      item.status = "undelivered";
      item.failureReason = `No delivery receipt was observed in the provider transcript (${
        this.enterRetriesAttempted
      } submit-Enter ${this.enterRetriesAttempted === 1 ? "retry" : "retries"} attempted).`;
      this.inFlight = null;
      this.clearReceiptTimer();
      this.clearEnterRetries();
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

  /** Arm the Enter re-send ladder for a freshly in-flight delivery. Armed and
   *  cleared in lockstep with the receipt timer (same in-flight lifecycle),
   *  EXCEPT an echo completion leaves it armed (see completeDelivery). Each rung
   *  captures the delivery seq at arm time so a superseded ladder never fires. */
  private armEnterRetries(itemId: DeliveryItemId): void {
    this.clearEnterRetries();
    this.enterRetriesAttempted = 0;
    const armedSeq = this.deliverySeq;
    this.enterRetryDelaysMs.forEach((delayMs, rungIndex) => {
      this.enterRetryTimers.push(
        setTimeout(() => {
          this.attemptEnterRetry(itemId, rungIndex, armedSeq);
        }, delayMs),
      );
    });
  }

  /**
   * A ladder timer fired: re-send the submit Enter if the delivery still needs
   * it. Two admissible cases, then the shared guards:
   *
   *  - Strict in-flight: this item is still the inFlight one and awaiting a
   *    receipt (the classic swallowed-Enter case).
   *  - Echo-reconciliation (FIRST rung only): the `pty-composer-echo` receipt
   *    already COMPLETED this item, but it fired on composer PAINT — no proof
   *    the Enter submitted. If an uncorroborated echo backfill still stands (the
   *    transcript has not yet recorded a real submission), an extra Enter
   *    reconciles reality to the already-reported delivery: a genuine submit ⇒
   *    empty composer ⇒ no-op; a swallowed one ⇒ the stuck text finally submits.
   *    First rung only — isHumanActivelyTyping's window (HUMAN_ACTIVE_WINDOW_MS,
   *    3.5s) blankets any keystroke in [0, first-rung], so rung 0 cannot fire
   *    over a human's composed text; a later rung has a typed-then-paused hole,
   *    so it never takes this branch. INVARIANT: this proof needs
   *    enterRetryDelaysMs[0] < HUMAN_ACTIVE_WINDOW_MS (see the constant). A
   *    genuine submit is corroborated by notePromptSubmittedByCli (UPS) before
   *    rung 0, so this branch only ever fires for an actually-stuck send.
   *
   * Ownership: any nudge requires the captured seq to still be current — a later
   * delivery has since owned the composer otherwise, and this Enter would land
   * on ITS prompt. Any guard failing SKIPS this attempt — never rescheduled; the
   * next rung (if any) still fires.
   */
  private attemptEnterRetry(itemId: DeliveryItemId, rungIndex: number, armedSeq: number): void {
    if (armedSeq !== this.deliverySeq) {
      return;
    }

    if (this.inFlight && this.inFlight.itemId === itemId) {
      // UPS already proved this genuinely submitted — never Enter now (it could
      // land on an option-prompt the model raced onto the screen). The lagging
      // transcript receipt still completes it; if it never arrives, the item
      // falls to the honest 45s undelivered report (H1 over a lost heal).
      if (this.inFlight.submissionCorroborated) {
        return;
      }
      const item = this.items.find((candidate) => candidate.id === itemId);
      if (!item || item.status !== "delivering") {
        return;
      }
    } else {
      if (rungIndex !== 0) {
        return;
      }
      const echo = this.ptyEchoBackfills.find(
        (candidate) =>
          candidate.itemId === itemId && candidate.expiresAtMs > Date.now() && !candidate.corroborated,
      );
      if (!echo) {
        return;
      }
    }

    // Never Enter into an approval — a stray submit would confirm the panel
    // (the digit/enter-swallow class). isApprovalActive is the rendered-panel
    // scrape; pendingApprovalKeys also covers the hook-broker hold, where no
    // panel renders (mirrors the canDeliver question-guard).
    if (this.terminalHost.isApprovalActive() || this.pendingApprovalKeys.size > 0) {
      return;
    }
    // Don't auto-submit text a co-present human may be editing directly in the
    // terminal composer (scope extension of isHumanActivelyTyping, pre-declared
    // in the plan's deviation ledger).
    if (this.terminalHost.isHumanActivelyTyping()) {
      return;
    }
    if (this.terminalHost.nudgePromptSubmit()) {
      this.enterRetriesAttempted += 1;
    }
  }

  private clearEnterRetries(): void {
    for (const timer of this.enterRetryTimers) {
      clearTimeout(timer);
    }
    this.enterRetryTimers = [];
  }

  private dropExpiredBackfills(): void {
    const now = Date.now();
    for (let index = this.ptyEchoBackfills.length - 1; index >= 0; index -= 1) {
      if ((this.ptyEchoBackfills[index]?.expiresAtMs ?? 0) <= now) {
        this.ptyEchoBackfills.splice(index, 1);
      }
    }
  }

  /**
   * Publishes the delivery state ONLY when it actually changed.
   *
   * pump() runs on every runtime event this controller is handed, and most of
   * them move nothing — a report refresh, a task metadata update, a transcript
   * relocation, a CLI-state tick all pumped an untouched queue and announced a
   * change that had not happened. The renderer correctly reads `delivery:state`
   * as a content change and full-renders on it, so those announcements were
   * full renders — each one destroying, among other things, the question
   * drawer's free-text field under the user's caret.
   *
   * MEASURED (2026-08-06, the recorded real-session fixtures under
   * tests/fixtures/runtime-events): 332 of 591 `delivery:state` events — 56% —
   * were byte-identical to the state already on the wire. The events that
   * preceded them are the whole runtime stream, led by pty:data (55),
   * report:updated (53), task:updated (40) and transcript:located (23), plus 89
   * that followed another delivery:state directly.
   *
   * The fix belongs at the emitter, not at the reducer: an emitted event
   * represents a real change, so a consumer never has to re-derive whether it
   * lied. The fingerprint is the serialized payload itself rather than a
   * hand-picked field list — every field of DeliveryTaskState is display truth,
   * and a hand-written digest silently swallows the next field added to it.
   * The payload is small (a few flags plus the queue, normally 0-1 items) and
   * built here anyway, so serializing it costs nothing at this cadence.
   *
   * Consumers that hold state off this event (the renderer's `view.deliveryState`,
   * `bootLatched`) are unaffected: the value is sticky once set, and every
   * transition still emits. The one behavior this changes is that a status line
   * written by another event (an action's error text) is no longer overwritten
   * within 300ms by a re-announcement of an unchanged delivery state — which is
   * what that channel was for.
   */
  private emitState(): void {
    const next = this.state();
    const fingerprint = JSON.stringify(next);
    if (fingerprint === this.lastEmittedState) {
      return;
    }
    this.lastEmittedState = fingerprint;
    this.emitEvent("delivery:state", next);
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
  // Only backfillPtyReceipt calls this, and PTY-echo backfills exist ONLY for
  // attachment-LESS items (allowPtyEchoReceipt gates on
  // item.attachments.length === 0). So expectedImages is always 0 and the old
  // `receivedImages >= expectedImages` check was permanently 0 >= 0 — vestigial.
  // Text match is the whole test.
  return receiptMatch(item, block) !== null;
}

function receiptMatch(
  item: { text: string; attachments: DeliveryAttachment[] },
  block: Extract<TranscriptBlock, { kind: "user-message" }>,
): { expectedImages: number; receivedImages: number } | null {
  const prompt = normalizePromptForMatch(item.text);
  const received = normalizePromptForMatch(block.text);
  const textMatches =
    prompt.length === 0 ||
    prompt === received ||
    (block.command !== null && prompt.startsWith(block.command));
  if (!textMatches) {
    return null;
  }

  const expectedImages = item.attachments.length;
  const receivedImages = (block.attachments ?? []).filter((attachment) => attachment.kind === "image").length;
  // Literal markers can outlive their image payloads after a raced submit.
  // Only normalized attachment payloads count toward the provider receipt.
  return { expectedImages, receivedImages };
}

function containsPromptEcho(rawText: string, text: string): boolean {
  const clean = normalizeText(cleanTerminal(rawText));
  return clean.includes(normalizeText(text));
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/**
 * Guard errors are states, not failures: the screen is temporarily owned by an
 * approval panel, an in-flight control switch (a parked consent dialog) or a
 * claude Rewind panel. The item stays queued and delivers when the state clears
 * — never silently into it. canDeliver already refuses all three; these throws
 * are the submitPrompt-level backstop, and re-queueing keeps their semantics
 * correct if one ever fires.
 */
function isDeliveryGuardError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("native approval screen") ||
    message.includes("control switch is pending") ||
    message.includes("rewind panel is open")
  );
}
