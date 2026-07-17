import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  DeliveryController,
  ProviderTranscript,
  TerminalHost,
  cleanTerminal,
} = require("../../dist/runtime");

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-native-image-smoke-"));
const results = [];

try {
  for (const provider of ["codex", "claude"]) {
    results.push(await runProviderImageSmoke(provider));
  }

  const success = results.every((result) => result.verified);
  console.log(JSON.stringify({ workspaceRoot, success, results }, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

async function runProviderImageSmoke(provider) {
  const nonImage = await runNonImageCheck(provider);
  const delivery = await runImageDeliveryCheck(provider);
  const spacey = await runSpaceyImageDeliveryCheck(provider);
  const reference = await runReferenceTextCheck(provider);
  return {
    provider,
    verified: nonImage.verified && delivery.verified && spacey.verified && reference.verified,
    nonImage,
    delivery,
    spacey,
    reference,
  };
}

async function runNonImageCheck(provider) {
  const controller = await startHost(provider, `${provider}-non-image`);
  try {
    const markerBefore = imageMarkerCount(controller.cleanTail());
    const textPath = path.join(controller.workspace, "not_image.txt");
    fs.writeFileSync(textPath, "not an image");
    controller.host.writeRaw(`${BRACKETED_PASTE_START}${textPath}${BRACKETED_PASTE_END}`);
    await delay(1200);
    const tail = controller.cleanTail();
    return {
      name: `${provider} non-image path stays text`,
      verified: tail.includes(textPath) && imageMarkerCount(tail) === markerBefore,
      evidenceTail: redact(tail.slice(-1200)),
    };
  } finally {
    controller.dispose();
  }
}

async function runImageDeliveryCheck(provider) {
  const controller = await startHost(provider, `${provider}-image-delivery`);
  try {
    const imagePath = path.join(controller.workspace, "red.png");
    fs.writeFileSync(imagePath, redPngBytes());
    const prompt = `Reply exactly SONATA_${provider.toUpperCase()}_IMAGE_ATTACHMENT_RECEIPT.`;
    const attachment = {
      id: `attachment-${provider}-smoke`,
      path: imagePath,
      originalName: "red.png",
      mediaType: "image/png",
      size: fs.statSync(imagePath).size,
      provenance: "referenced",
      kind: "image",
    };
    const item = controller.delivery.enqueue(prompt, [attachment]);
    const receipt = await waitForReceipt(controller.deliveryEvents, item.id, 180000);
    const tail = controller.cleanTail();
    const userBlock = controller.transcript.blocks().find(
      (block) => block.kind === "user-message" && block.text.includes(prompt),
    );
    return {
      name: `${provider} no-space PNG becomes native image and receipts`,
      verified:
        Boolean(receipt) &&
        imageMarkerCount(tail) > 0 &&
        Boolean(userBlock) &&
        userBlock.attachments.length >= 1,
      receiptSource: receipt?.payload.receipt.source ?? null,
      transcriptAttachmentCount: userBlock?.attachments.length ?? 0,
      evidenceTail: redact(tail.slice(-1200)),
    };
  } finally {
    controller.dispose();
  }
}

// The gate: an image at a path with a SPACE (and an apostrophe) chips via the
// real delivery path, which now double-quotes the path before bracketed-paste.
// Proves the quoting works end-to-end on both CLIs (the probe proved the quoting
// itself; this proves it through DeliveryController + terminal-host timing).
async function runSpaceyImageDeliveryCheck(provider) {
  const controller = await startHost(provider, `${provider}-spacey-image`);
  try {
    const dir = path.join(controller.workspace, "with space");
    fs.mkdirSync(dir, { recursive: true });
    const imagePath = path.join(dir, "a'b.png");
    fs.writeFileSync(imagePath, redPngBytes());
    const prompt = `Reply exactly SONATA_${provider.toUpperCase()}_SPACEY_IMAGE_RECEIPT.`;
    const attachment = {
      id: `attachment-${provider}-spacey`,
      path: imagePath,
      originalName: "a'b.png",
      mediaType: "image/png",
      size: fs.statSync(imagePath).size,
      provenance: "referenced",
      kind: "image",
    };
    const item = controller.delivery.enqueue(prompt, [attachment]);
    const receipt = await waitForReceipt(controller.deliveryEvents, item.id, 180000);
    const tail = controller.cleanTail();
    const userBlock = controller.transcript.blocks().find(
      (block) => block.kind === "user-message" && block.text.includes(prompt),
    );
    return {
      name: `${provider} spacey+quote PNG path chips via double-quote delivery`,
      verified:
        Boolean(receipt) &&
        imageMarkerCount(tail) > 0 &&
        Boolean(userBlock) &&
        userBlock.attachments.length >= 1,
      receiptSource: receipt?.payload.receipt.source ?? null,
      transcriptAttachmentCount: userBlock?.attachments.length ?? 0,
      evidenceTail: redact(tail.slice(-1200)),
    };
  } finally {
    controller.dispose();
  }
}

// Slice B: a REFERENCED non-image file (kind:"file") is delivered as a path
// mention folded into the prompt TEXT — not chipped — and the agent receives it.
// (file and folder share the same delivery code; folder is exercised in the UI
// e2e.) The path has a space, so it also confirms quoting in the text channel.
async function runReferenceTextCheck(provider) {
  const controller = await startHost(provider, `${provider}-ref-file`);
  try {
    // Space + apostrophe — realistic folder-name special chars that must deliver
    // VERBATIM on both CLIs (the text channel must not shell-escape them). The
    // bug-#1-specific "no backslash-escaping of $/`/\\" is guarded deterministically
    // in delivery-receipts.mjs; shell-EXPANSION chars ($, `) in a referenced path
    // are mangled by Codex's own composer (carry-forward), so not asserted here.
    const dir = path.join(controller.workspace, "ref's space");
    fs.mkdirSync(dir, { recursive: true });
    const refPath = path.join(dir, "notes.txt");
    fs.writeFileSync(refPath, "reference target");
    const prompt = `Reply exactly SONATA_${provider.toUpperCase()}_REF_FILE_RECEIPT.`;
    const attachment = {
      id: `attachment-${provider}-ref-file`,
      path: refPath,
      originalName: "notes.txt",
      mediaType: "text/plain",
      size: fs.statSync(refPath).size,
      provenance: "referenced",
      kind: "file",
    };
    const item = controller.delivery.enqueue(prompt, [attachment]);
    const receipt = await waitForReceipt(controller.deliveryEvents, item.id, 180000);
    const userBlock = controller.transcript.blocks().find(
      (block) => block.kind === "user-message" && block.text.includes(prompt),
    );
    const pathInText = Boolean(userBlock) && userBlock.text.includes(refPath);
    const chippedAsImage = (userBlock?.attachments.length ?? 0) > 0;
    return {
      name: `${provider} referenced file delivers as path-in-text (no chip)`,
      verified: Boolean(receipt) && pathInText && !chippedAsImage,
      receiptSource: receipt?.payload.receipt.source ?? null,
      pathInText,
      chippedAsImage,
      evidenceTail: redact(controller.cleanTail().slice(-1200)),
    };
  } finally {
    controller.dispose();
  }
}

async function startHost(provider, name) {
  const workspace = path.join(workspaceRoot, name);
  fs.mkdirSync(workspace, { recursive: true });
  const taskId = `native-image-${name}`;

  let exited = false;
  let raw = "";
  const runtimeEvents = [];
  const deliveryEvents = [];
  let host = null;
  let delivery = null;
  let transcript = null;

  const runtimeEventSink = (event) => {
    runtimeEvents.push(event);
    if (event.type === "pty:data") {
      raw = `${raw}${event.payload.data}`.slice(-96_000);
    }
    if (event.type === "pty:exit") {
      exited = true;
    }
    if (event.type === "approval:detected" && event.payload.kind === "workspace-trust") {
      // Answer OUTSIDE this dispatch. A synchronous sendApprove() here made the
      // delivery controller (line below) see approval:decision BEFORE this very
      // approval:detected, wedging `approvalPending` true forever — a re-entrancy
      // that cannot happen in production, where answers arrive via async IPC
      // (s3-diags/image-smoke-gate-diag).
      setTimeout(() => host.sendApprove(), 0);
    }
    if (event.type === "run:started") {
      transcript.ensureDiscovery();
    }
    delivery?.handleRuntimeEvent(event);
  };

  host = new TerminalHost({
    taskId,
    provider,
    defaultWorkspace: workspace,
    eventSink: runtimeEventSink,
  });
  transcript = new ProviderTranscript({
    taskId,
    provider,
    providerCwd: workspace,
    eventSink: runtimeEventSink,
    resolveRunId: () => null,
    pollMs: 500,
  });
  delivery = new DeliveryController({
    taskId,
    provider,
    terminalHost: host,
    eventSink: (event) => deliveryEvents.push(event),
    hasLiveTranscriptSource: () => transcript.hasLiveSource(),
    receiptTimeoutMs: 120000,
    // Keep this real-spawn attachment test byte-for-byte in its pre-fix
    // behavior: no 500ms boot grace, no auto Enter re-sends into the live CLI.
    // The boot-race mechanisms are fenced against fake hosts + a live probe.
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [],
  });

  const startedAt = new Date().toISOString();
  host.startTask({
    cwd: workspace,
    rows: 42,
    cols: 140,
    ...(provider === "codex"
      ? { codexPermissionMode: "ask-for-approval" }
      : { permissionMode: "default", model: "opus", reasoningEffort: "xhigh" }),
  });
  transcript.startDiscovery(startedAt);
  // Boot readiness = the structural composer gate (task:ready no longer
  // fires at boot — the between-runs poller was retired in S6).
  await waitUntil(() => host.acceptsPromptInput() || exited, 180000, () => cleanTerminal(raw).slice(-3000));
  if (exited) {
    throw new Error(`${provider} exited before ready.\n\n${redact(cleanTerminal(raw).slice(-3000))}`);
  }

  return {
    workspace,
    host,
    delivery,
    transcript,
    deliveryEvents,
    cleanTail: () => cleanTerminal(raw),
    dispose: () => {
      delivery.dispose();
      transcript.dispose();
      host.dispose();
    },
  };
}

async function waitForReceipt(events, itemId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = events.find(
      (event) => event.type === "delivery:receipt" && event.payload.itemId === itemId,
    );
    if (receipt) {
      return receipt;
    }
    const undelivered = events.find(
      (event) =>
        event.type === "delivery:state" &&
        event.payload.queue.some((item) => item.id === itemId && item.status === "undelivered"),
    );
    if (undelivered) {
      return null;
    }
    await delay(500);
  }
  return null;
}

async function waitUntil(predicate, timeoutMs, context) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for native image smoke readiness.\n\n${redact(context())}`);
}

function imageMarkerCount(value) {
  return value.match(/\[Image\s+#\d+\]/gi)?.length ?? 0;
}

function redPngBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(value) {
  return value
    .replaceAll(os.homedir(), "~")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "[session id]",
    );
}
