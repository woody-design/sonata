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
  });

  const attachment = {
    id: "attachment-smoke-1",
    path: "/tmp/duet-attachment-smoke/red.png",
    originalName: "red.png",
    mediaType: "image/png",
    size: 68,
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
    isApprovalActive() {
      return this.approvalActive;
    },
    isHumanActivelyTyping() {
      return false;
    },
    isModalActive() {
      return false;
    },
    isIdleComposerReady() {
      return this.idleComposer;
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
