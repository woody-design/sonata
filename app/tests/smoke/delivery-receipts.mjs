import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DeliveryController } = require("../../dist/runtime");

const failures = [];

await check("provider transcript user message receipts complete delivery", async () => {
  const events = [];
  const host = fakeHost();
  const controller = new DeliveryController({
    taskId: "task-delivery-receipt-smoke",
    provider: "codex",
    terminalHost: host,
    eventSink: (event) => events.push(event),
    hasLiveTranscriptSource: () => true,
    receiptTimeoutMs: 500,
    // Receipt semantics under test, not the boot-init Enter-swallow grace or
    // the Enter-retry ladder (those are fenced in delivery-enter-retry.mjs):
    // deliver on enqueue, no auto Enter re-sends.
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [],
  });

  const item = controller.enqueue("Receipt smoke prompt");
  assert.equal(host.submissions.length, 1);
  assert.equal(controller.state().queue[0]?.status, "delivering");

  controller.handleRuntimeEvent({
    type: "transcript:blocks",
    payload: {
      taskId: "task-delivery-receipt-smoke",
      sourceId: "source-1",
      reset: false,
      upserts: [
        {
          kind: "user-message",
          id: "source-1:user-1",
          taskId: "task-delivery-receipt-smoke",
          sourceId: "source-1",
          provider: "codex",
          turnKey: "turn-1",
          runId: "run-1",
          ts: new Date().toISOString(),
          seq: 1,
          text: "Receipt smoke prompt",
          command: null,
          attachments: [],
        },
      ],
    },
    ts: new Date().toISOString(),
  });

  const receipt = events.find(
    (event) => event.type === "delivery:receipt" && event.payload.itemId === item.id,
  );
  assert.ok(receipt, "expected delivery receipt event");
  assert.equal(receipt.payload.receipt.source, "provider-transcript");
  assert.equal(receipt.payload.receipt.runId, "run-1");
  assert.equal(controller.state().queue.length, 0);
  controller.dispose();
});

await check("Claude first message can receipt from PTY echo and later backfill", async () => {
  const events = [];
  const host = fakeHost();
  const controller = new DeliveryController({
    taskId: "task-claude-first-receipt-smoke",
    provider: "claude",
    terminalHost: host,
    eventSink: (event) => events.push(event),
    hasLiveTranscriptSource: () => false,
    receiptTimeoutMs: 500,
    // Receipt semantics under test, not the boot-init Enter-swallow grace or
    // the Enter-retry ladder (those are fenced in delivery-enter-retry.mjs):
    // deliver on enqueue, no auto Enter re-sends.
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [],
  });

  const item = controller.enqueue("Claude first message");
  controller.handleRuntimeEvent({
    type: "pty:data",
    payload: {
      taskId: "task-claude-first-receipt-smoke",
      data: "\r\n> Claude first message",
    },
    ts: new Date().toISOString(),
  });

  const echoReceipt = events.find(
    (event) => event.type === "delivery:receipt" && event.payload.itemId === item.id,
  );
  assert.ok(echoReceipt, "expected PTY echo receipt");
  assert.equal(echoReceipt.payload.receipt.source, "pty-composer-echo");
  assert.equal(controller.state().queue.length, 0);

  controller.handleRuntimeEvent({
    type: "transcript:blocks",
    payload: {
      taskId: "task-claude-first-receipt-smoke",
      sourceId: "claude-source-1",
      reset: false,
      upserts: [
        {
          kind: "user-message",
          id: "claude-source-1:user-1",
          taskId: "task-claude-first-receipt-smoke",
          sourceId: "claude-source-1",
          provider: "claude",
          turnKey: "turn-1",
          runId: "run-claude-1",
          ts: new Date().toISOString(),
          seq: 1,
          text: "Claude first message",
          command: null,
          attachments: [],
        },
      ],
    },
    ts: new Date().toISOString(),
  });

  const backfillReceipt = events.find(
    (event) =>
      event.type === "delivery:receipt" &&
      event.payload.itemId === item.id &&
      event.payload.receipt.backfilled,
  );
  assert.ok(backfillReceipt, "expected provider transcript backfill receipt");
  assert.equal(backfillReceipt.payload.receipt.source, "provider-transcript");
  assert.equal(backfillReceipt.payload.receipt.runId, "run-claude-1");
  controller.dispose();
});

await check("attachment markers and image evidence complete delivery", async () => {
  const events = [];
  const host = fakeHost();
  const controller = new DeliveryController({
    taskId: "task-attachment-receipt-smoke",
    provider: "codex",
    terminalHost: host,
    eventSink: (event) => events.push(event),
    hasLiveTranscriptSource: () => true,
    receiptTimeoutMs: 500,
    // Receipt semantics under test, not the boot-init Enter-swallow grace or
    // the Enter-retry ladder (those are fenced in delivery-enter-retry.mjs):
    // deliver on enqueue, no auto Enter re-sends.
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [],
  });

  const attachment = {
    id: "attachment-smoke-1",
    path: "/tmp/sonata-attachment-smoke/red.png",
    originalName: "red.png",
    mediaType: "image/png",
    size: 68,
    provenance: "referenced",
    kind: "image",
  };
  const item = controller.enqueue("Attachment receipt prompt", [attachment]);
  assert.deepEqual(host.submissions[0]?.attachments, [{ path: attachment.path }]);

  controller.handleRuntimeEvent({
    type: "transcript:blocks",
    payload: {
      taskId: "task-attachment-receipt-smoke",
      sourceId: "source-attachment-1",
      reset: false,
      upserts: [
        {
          kind: "user-message",
          id: "source-attachment-1:user-1",
          taskId: "task-attachment-receipt-smoke",
          sourceId: "source-attachment-1",
          provider: "codex",
          turnKey: "turn-1",
          runId: "run-attachment-1",
          ts: new Date().toISOString(),
          seq: 1,
          text: "[Image #1] Attachment receipt prompt",
          command: null,
          attachments: [
            {
              kind: "image",
              source: "local-path",
              path: attachment.path,
              mediaType: "image/png",
            },
          ],
        },
      ],
    },
    ts: new Date().toISOString(),
  });

  const receipt = events.find(
    (event) => event.type === "delivery:receipt" && event.payload.itemId === item.id,
  );
  assert.ok(receipt, "expected attachment delivery receipt event");
  assert.equal(receipt.payload.receipt.source, "provider-transcript");
  assert.equal(controller.state().queue.length, 0);
  controller.dispose();
});

await check("partial image transcript receipts as delivered-partial with an honest count", async () => {
  const events = [];
  const host = fakeHost();
  const controller = new DeliveryController({
    taskId: "task-partial-attachment-receipt-smoke",
    provider: "claude",
    terminalHost: host,
    eventSink: (event) => events.push(event),
    hasLiveTranscriptSource: () => true,
    receiptTimeoutMs: 50,
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [],
  });
  const attachments = Array.from({ length: 6 }, (_, index) => ({
    id: `partial-${index + 1}`,
    path: `/tmp/sonata-partial/image-${index + 1}.png`,
    originalName: `image-${index + 1}.png`,
    mediaType: "image/png",
    size: 68,
    provenance: "referenced",
    kind: "image",
  }));
  const item = controller.enqueue("Partial attachment prompt", attachments);

  controller.handleRuntimeEvent({
    type: "transcript:blocks",
    payload: {
      taskId: "task-partial-attachment-receipt-smoke",
      sourceId: "source-partial-1",
      reset: false,
      upserts: [
        {
          kind: "user-message",
          id: "source-partial-1:user-1",
          taskId: "task-partial-attachment-receipt-smoke",
          sourceId: "source-partial-1",
          provider: "claude",
          turnKey: "turn-partial-1",
          runId: "run-partial-1",
          ts: new Date().toISOString(),
          seq: 1,
          // Six marker strings but only three payloads: marker text cannot
          // promote a partial receipt to full delivery.
          text: "[Image #1] [Image #2] [Image #3] [Image #4] [Image #5] [Image #6] Partial attachment prompt",
          command: null,
          attachments: attachments.slice(0, 3).map((attachment) => ({
            kind: "image",
            source: "local-path",
            path: attachment.path,
            mediaType: attachment.mediaType,
          })),
        },
      ],
    },
    ts: new Date().toISOString(),
  });

  const receipt = events.find(
    (event) => event.type === "delivery:receipt" && event.payload.itemId === item.id,
  );
  assert.ok(receipt, "expected partial delivery receipt event");
  assert.equal(receipt.payload.item.status, "delivered-partial");
  assert.equal(receipt.payload.item.failureReason, "3 of 6 images attached");
  assert.equal(receipt.payload.receipt.expectedImages, 6);
  assert.equal(receipt.payload.receipt.receivedImages, 3);
  assert.equal(controller.state().attachmentNotice, "3 of 6 images attached");
  assert.equal(controller.state().queue.length, 0, "partial receipt completes the queue item");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(
    !events.some(
      (event) =>
        event.type === "delivery:state" &&
        event.payload.queue.some((candidate) => candidate.id === item.id && candidate.status === "undelivered"),
    ),
    "partial receipt never falls through to timeout",
  );
  controller.dispose();
});

await check("partial-delivery notice is sticky: survives a follow-up enqueue, clears on a full attachment send", async () => {
  const host = fakeHost();
  const controller = new DeliveryController({
    taskId: "task-sticky-notice-smoke",
    provider: "claude",
    terminalHost: host,
    eventSink: () => {},
    hasLiveTranscriptSource: () => true,
    receiptTimeoutMs: 500,
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [],
  });
  const makeAttachments = (n, tag) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${tag}-${i + 1}`,
      path: `/tmp/sonata-sticky/${tag}-${i + 1}.png`,
      originalName: `${tag}-${i + 1}.png`,
      mediaType: "image/png",
      size: 12,
      provenance: "referenced",
      kind: "image",
    }));
  const partialBlock = (id, source, run, markers, gotAttachments) => ({
    type: "transcript:blocks",
    payload: {
      taskId: "task-sticky-notice-smoke",
      sourceId: source,
      reset: false,
      upserts: [
        {
          kind: "user-message",
          id: `${source}:${id}`,
          taskId: "task-sticky-notice-smoke",
          sourceId: source,
          provider: "claude",
          turnKey: `turn-${id}`,
          runId: run,
          ts: new Date().toISOString(),
          seq: 1,
          text: `${markers} sticky prompt`,
          command: null,
          attachments: gotAttachments.map((a) => ({
            kind: "image",
            source: "local-path",
            path: a.path,
            mediaType: a.mediaType,
          })),
        },
      ],
    },
    ts: new Date().toISOString(),
  });

  // First send: 3 requested, 1 lands → a partial notice is set.
  const first = makeAttachments(3, "a");
  controller.enqueue("sticky prompt", first);
  controller.handleRuntimeEvent(
    partialBlock("u1", "src-a", "run-a", "[Image #1] [Image #2] [Image #3]", first.slice(0, 1)),
  );
  assert.equal(controller.state().attachmentNotice, "1 of 3 images attached", "partial sets the notice");

  // The user's natural reaction — enqueue the rest — must NOT wipe the evidence.
  const second = makeAttachments(2, "b");
  controller.enqueue("sticky prompt", second);
  assert.equal(
    controller.state().attachmentNotice,
    "1 of 3 images attached",
    "the notice survives the recovery enqueue (was previously cleared here)",
  );

  // The recovery send lands FULLY → the notice clears.
  controller.handleRuntimeEvent(partialBlock("u2", "src-b", "run-b", "[Image #1] [Image #2]", second));
  assert.equal(controller.state().attachmentNotice, null, "a full attachment delivery clears the sticky notice");
  controller.dispose();
});

await check("file reference folds into prompt text VERBATIM (no shell-escaping)", async () => {
  const host = fakeHost();
  const controller = new DeliveryController({
    taskId: "task-ref-fold-smoke",
    provider: "codex",
    terminalHost: host,
    eventSink: () => {},
    hasLiveTranscriptSource: () => true,
    receiptTimeoutMs: 500,
    // Receipt semantics under test, not the boot-init Enter-swallow grace or
    // the Enter-retry ladder (those are fenced in delivery-enter-retry.mjs):
    // deliver on enqueue, no auto Enter re-sends.
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [],
  });
  // $ and ` are exactly what shellQuotePath would backslash-escape — wrong for
  // the prompt-text channel, where nothing un-escapes (guards bug: text quoter).
  const refPath = "/Users/a/proj$1/`notes`/report.pdf";
  const fileRef = {
    id: "ref-fold-1",
    path: refPath,
    originalName: "report.pdf",
    mediaType: "application/pdf",
    size: 20,
    provenance: "referenced",
    kind: "file",
  };
  controller.enqueue("Look at this", [fileRef]);
  const submitted = host.submissions[0]?.text ?? "";
  assert.ok(submitted.includes(refPath), `expected the raw path in delivered text, got: ${submitted}`);
  assert.ok(!submitted.includes("\\$") && !submitted.includes("\\`"), "text-channel path must not be shell-escaped");
  assert.deepEqual(host.submissions[0]?.attachments, [], "a file reference is text, not a chip");
  controller.dispose();
});

await check("mixed image + file reference: file folds to text, image chips, item receipts", async () => {
  const events = [];
  const host = fakeHost();
  const controller = new DeliveryController({
    taskId: "task-mixed-receipt-smoke",
    provider: "codex",
    terminalHost: host,
    eventSink: (event) => events.push(event),
    hasLiveTranscriptSource: () => true,
    receiptTimeoutMs: 500,
    // Receipt semantics under test, not the boot-init Enter-swallow grace or
    // the Enter-retry ladder (those are fenced in delivery-enter-retry.mjs):
    // deliver on enqueue, no auto Enter re-sends.
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [],
  });
  const imageRef = {
    id: "mixed-img-1",
    path: "/tmp/sonata-mixed/shot.png",
    originalName: "shot.png",
    mediaType: "image/png",
    size: 10,
    provenance: "referenced",
    kind: "image",
  };
  const fileRef = {
    id: "mixed-file-1",
    path: "/tmp/sonata-mixed/report.pdf",
    originalName: "report.pdf",
    mediaType: "application/pdf",
    size: 20,
    provenance: "referenced",
    kind: "file",
  };
  const item = controller.enqueue("Review these", [imageRef, fileRef]);
  // image stays a chip attachment; file folds into the prompt text.
  assert.deepEqual(host.submissions[0]?.attachments, [{ path: imageRef.path }]);
  assert.ok(host.submissions[0]?.text.includes(fileRef.path), "file path folded into prompt text");

  // The agent records [Image #N] + the prompt + the folded path. The item MUST
  // reach "delivered" (the e2e only proves the agent replied, not the receipt).
  controller.handleRuntimeEvent({
    type: "transcript:blocks",
    payload: {
      taskId: "task-mixed-receipt-smoke",
      sourceId: "source-mixed-1",
      reset: false,
      upserts: [
        {
          kind: "user-message",
          id: "source-mixed-1:user-1",
          taskId: "task-mixed-receipt-smoke",
          sourceId: "source-mixed-1",
          provider: "codex",
          turnKey: "turn-1",
          runId: "run-mixed-1",
          ts: new Date().toISOString(),
          seq: 1,
          text: `[Image #1] Review these\n"${fileRef.path}"`,
          command: null,
          attachments: [{ kind: "image", source: "local-path", path: imageRef.path, mediaType: "image/png" }],
        },
      ],
    },
    ts: new Date().toISOString(),
  });

  const receipt = events.find(
    (event) => event.type === "delivery:receipt" && event.payload.itemId === item.id,
  );
  assert.ok(receipt, "expected mixed-submission delivery receipt");
  assert.equal(controller.state().queue.length, 0, "item left the queue (delivered)");
  controller.dispose();
});

await check("slash delivery receipts immediately and never blocks the queue", async () => {
  // A verbatim slash on an idle composer opens a kind:"slash" run whose
  // transcript receipt is structurally unreachable (local commands write no
  // user-block; echo is off once the transcript is live). Pre-fix, the 45s
  // timeout marked it undelivered and the undelivered HEAD blocked
  // nextQueuedItem() forever — every later send silently died (the S4
  // /config wedge, s4-diags/skill-dispatch evidence). Lock: sent-is-sent.
  const events = [];
  const host = fakeHost();
  const controller = new DeliveryController({
    taskId: "task-slash-receipt-smoke",
    provider: "claude",
    terminalHost: host,
    eventSink: (event) => events.push(event),
    hasLiveTranscriptSource: () => true,
    receiptTimeoutMs: 500,
    // Receipt semantics under test, not the boot-init Enter-swallow grace or
    // the Enter-retry ladder (those are fenced in delivery-enter-retry.mjs):
    // deliver on enqueue, no auto Enter re-sends.
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [],
  });

  const slashItem = controller.enqueue("/config");
  const receipt = events.find(
    (event) => event.type === "delivery:receipt" && event.payload.itemId === slashItem.id,
  );
  assert.ok(receipt, "slash item receipts at write time");
  assert.equal(receipt.payload.receipt.source, "slash-write");
  assert.equal(controller.state().queue.length, 0, "slash item left the queue immediately");

  // The queue keeps moving: a follow-up prompt delivers (write-through), it
  // does not sit queued behind a phantom undelivered slash.
  controller.enqueue("follow-up prompt");
  assert.equal(host.submissions.length, 2, "follow-up prompt reached the PTY");
  controller.dispose();
});

if (failures.length > 0) {
  process.exitCode = 1;
}

function fakeHost() {
  return {
    submissions: [],
    activeRun: false,
    approvalActive: false,
    idleComposer: true,
    hasActiveRun() {
      return this.activeRun;
    },
    activeRunId() {
      return this.activeRun ? "run-stub" : null;
    },
    isApprovalActive() {
      return this.approvalActive;
    },
    hasPendingControlSwitch() {
      return false;
    },
    isRewindPanelOpen() {
      return false;
    },
    acceptsPromptInput() {
      return this.idleComposer;
    },
    submitPrompt(text, options = {}) {
      const runId = `run-${this.submissions.length + 1}`;
      this.submissions.push({ text, runId, attachments: options.attachments ?? [] });
      this.activeRun = true;
      return {
        taskId: "task",
        runId,
        kind: text.trim().startsWith("/") ? "slash" : "prompt",
        submittedAt: new Date().toISOString(),
      };
    },
  };
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}
