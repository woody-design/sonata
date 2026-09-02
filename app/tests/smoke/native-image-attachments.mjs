import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  DeliveryController,
  ProviderTranscript,
  TerminalHost,
  cleanTerminal,
  codexArgs,
} = require("../../dist/runtime");
const {
  CODEX_SMOKE_PROFILE,
  ensureSmokeTrustProfile,
  removeSmokeTrustProfile,
} = await import("./codex-smoke-trust.mjs");

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-native-image-smoke-"));
const results = [];

// PRECONDITION, before a single CLI is spawned: the fixture must be a PNG a real
// decoder accepts. Every case below feeds `redPngBytes()` to a live model, and
// for years none of them could tell that the model was receiving
// `"image content omitted because it could not be processed"` instead of an
// image — because they all assert on the DELIVERY channel (receipt, chip,
// attachment count), which a corrupt file travels through perfectly. See
// `redPngBytes()` for the full diagnosis (upstream sync SL-7).
//
// This is deliberately a STRUCTURAL check and not an end-to-end one. It cannot
// prove the model sees pixels — only a rollout assertion on the prepared
// `response_item` could, and that was measured once, live, at 0.152.1 (SL-7 q30)
// rather than wired in here. What it does is make the specific rot that happened
// impossible to reintroduce silently: it fails instantly, offline, on exactly the
// byte that was wrong, which is the property the old fixture lacked.
assertDecodablePng(redPngBytes());

try {
  // CLAUDE FIRST, and every case isolated — upstream sync 2026-09-01, SL-3.
  //
  // This file drives two real CLIs through real model turns, so it is the
  // slowest smoke in the tree, and the aggregate runner SIGKILLs a test at
  // SONATA_SMOKE_TIMEOUT_MS (300s default). Until now the file printed NOTHING
  // until both providers had finished, and it ran codex first — so once codex
  // started failing slowly at 0.152.0 (SL-6/7/8) the kill landed before claude
  // ran at all, and the file reported an opaque `TIMED OUT` with an empty
  // output block. That opacity produced a wrong diagnosis: SL-1 recorded this
  // file as "never answers the new trust dialog", which q10 then MEASURED to be
  // false — the listener below answers it through the committed grid-verified
  // walk and reaches a composer in ~1.8s (the measurement and this whole
  // diagnosis: spikes/upstream-sync-2026-09/claude/findings.md, F9).
  //
  // So: order the providers so the one under repair reports first, isolate each
  // case so one failure cannot cancel the rest, and print each verdict AS IT
  // LANDS. A kill mid-run then still leaves standing evidence of what passed.
  // NOTHING is suppressed — codex's cases still run and still fail, and the
  // file still exits non-zero for them.
  for (const provider of ["claude", "codex"]) {
    const result = await runProviderImageSmoke(provider);
    results.push(result);
    console.log(`${result.verified ? "PASS" : "FAIL"} ${provider} image attachments`);
  }

  const success = results.every((result) => result.verified);
  console.log(JSON.stringify({ workspaceRoot, success, results }, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  removeSmokeTrustProfile();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

async function runProviderImageSmoke(provider) {
  const cases = {};
  for (const [name, run] of [
    ["nonImage", runNonImageCheck],
    ["delivery", runImageDeliveryCheck],
    ["multi", runMultiImageConsecutiveCheck],
    ["spacey", runSpaceyImageDeliveryCheck],
    ["reference", runReferenceTextCheck],
  ]) {
    // A case that THROWS (a startHost readiness timeout, a CLI that exited) is a
    // failed case, not a cancelled suite: the remaining cases still have
    // something to say, and on the provider under repair they are the evidence.
    try {
      cases[name] = await run(provider);
    } catch (error) {
      cases[name] = { name: `${provider} ${name}`, verified: false, threw: String(error?.message ?? error) };
    }
    console.log(`  ${cases[name].verified ? "ok  " : "FAIL"} ${cases[name].name}`);
  }
  return {
    provider,
    verified: Object.values(cases).every((entry) => entry.verified),
    ...cases,
  };
}

async function runMultiImageConsecutiveCheck(provider) {
  const controller = await startHost(provider, `${provider}-multi-image`);
  try {
    const attachments = Array.from({ length: 6 }, (_, index) => {
      const imagePath = path.join(controller.workspace, `multi-${index + 1}.png`);
      fs.writeFileSync(imagePath, redPngBytes());
      return {
        id: `attachment-${provider}-multi-${index + 1}`,
        path: imagePath,
        originalName: path.basename(imagePath),
        mediaType: "image/png",
        size: fs.statSync(imagePath).size,
        provenance: "referenced",
        kind: "image",
      };
    });
    const firstPrompt = `Reply exactly SONATA_${provider.toUpperCase()}_SIX_IMAGE_RECEIPT.`;
    const firstItem = controller.delivery.enqueue(firstPrompt, attachments);
    const firstReceipt = await waitForReceipt(controller.deliveryEvents, firstItem.id, 180000);
    const firstBlock = await waitForUserBlock(controller, firstPrompt, 180000);

    if (provider === "codex") {
      await waitUntil(
        () => !controller.host.hasActiveRun() && controller.host.acceptsPromptInput(),
        180000,
        () => controller.cleanTail().slice(-3000),
      );
    }

    const secondPrompt = `Reply exactly SONATA_${provider.toUpperCase()}_CLEAN_SECOND_SEND.`;
    const secondItem = controller.delivery.enqueue(secondPrompt);
    const secondReceipt = await waitForReceipt(controller.deliveryEvents, secondItem.id, 180000);
    const secondBlock = await waitForUserBlock(controller, secondPrompt, 180000);
    const secondHasFirstMarkerResidue = /\[Image\s+#\d+\]/i.test(secondBlock?.text ?? "");

    return {
      name: `${provider} six images attach; consecutive send has no marker residue`,
      verified:
        Boolean(firstReceipt) &&
        firstBlock?.attachments.length === 6 &&
        Boolean(secondReceipt) &&
        Boolean(secondBlock) &&
        secondBlock.attachments.length === 0 &&
        !secondHasFirstMarkerResidue,
      firstTranscriptAttachmentCount: firstBlock?.attachments.length ?? 0,
      secondTranscriptAttachmentCount: secondBlock?.attachments.length ?? 0,
      secondHasFirstMarkerResidue,
      evidenceTail: redact(controller.cleanTail().slice(-1600)),
    };
  } finally {
    controller.dispose();
  }
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
      // Reachable at all because `startTask` below passes no `approvalBroker`,
      // and the host's broker-ON gate requires an explicit `true` — so the
      // native trust scrape is live here and this event fires. On claude the
      // answer now goes through SL-1's grid-verified cursor walk (2.1.252 flipped
      // the default row to "No, exit", and both former encodings exited the CLI);
      // MEASURED reaching a composer in ~1.8s at 2.1.257 (findings.md F9).
      //
      // Answer OUTSIDE this dispatch. A synchronous sendApprove() here made the
      // delivery controller (line below) see approval:decision BEFORE this very
      // approval:detected, wedging `approvalPending` true forever — a re-entrancy
      // that cannot happen in production, where answers arrive via async IPC
      // (s3-diags/image-smoke-gate-diag).
      setTimeout(() => {
        void host.sendApprove().catch((error) => console.error("sendApprove failed:", error));
      }, 0);
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

  // Declared BEFORE the boot can throw. Every case's happy path already ran this
  // in its `finally`, but the two failure paths below (readiness timeout, a CLI
  // that exited) used to escape with the pty still live AND the transcript's
  // discovery `setInterval` still armed — it is not unref'd, so nothing else
  // clears it. Since the per-case isolation above turns those throws into failed
  // cases and keeps going, the leak became load-bearing: the file would print
  // its report and then hang forever instead of exiting (review round 1, minor
  // #2). Cleanup rather than a terminal `process.exit`, deliberately — an
  // explicit exit would also hide the NEXT leak of this class.
  const disposeAll = () => {
    delivery.dispose();
    transcript.dispose();
    host.dispose();
  };

  try {
    const startedAt = new Date().toISOString();
    // Codex: pre-trust the fresh temp dir via the throwaway smoke profile —
    // otherwise the directory-trust dialog renders, and (pre-guard) its `›`
    // option cursor satisfied the readiness scrape, so the first bracketed
    // paste went INTO the dialog: text discarded, Enter silently answered
    // "Yes, continue" (probed spikes/codex-boot-input-window, 2026-07-17).
    if (provider === "codex") {
      ensureSmokeTrustProfile(workspace);
    }
    host.startTask({
      cwd: workspace,
      rows: 42,
      cols: 140,
      ...(provider === "codex"
        ? {
            // Exact-version probes run while a newer package may exist; the
            // update picker owns the composer and is unrelated to attachment IO.
            args: codexArgs({
              cwd: workspace,
              permissionMode: "ask-for-approval",
              profile: CODEX_SMOKE_PROFILE,
            }).concat("-c", "check_for_update_on_startup=false"),
          }
        : { permissionMode: "default", model: "opus", reasoningEffort: "xhigh" }),
    });
    transcript.startDiscovery(startedAt);
    // Boot readiness = the structural composer gate (task:ready no longer
    // fires at boot — the between-runs poller was retired in S6).
    await waitUntil(() => host.acceptsPromptInput() || exited, 180000, () => cleanTerminal(raw).slice(-3000));
    if (exited) {
      throw new Error(`${provider} exited before ready.\n\n${redact(cleanTerminal(raw).slice(-3000))}`);
    }
  } catch (error) {
    disposeAll();
    throw error;
  }

  return {
    workspace,
    host,
    delivery,
    transcript,
    deliveryEvents,
    cleanTail: () => cleanTerminal(raw),
    dispose: disposeAll,
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

async function waitForUserBlock(controller, prompt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const block = controller.transcript
      .blocks()
      .find((candidate) => candidate.kind === "user-message" && candidate.text.includes(prompt));
    if (block) {
      return block;
    }
    await delay(250);
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
  return value.match(/\[Image\s*#\d+\]/gi)?.length ?? 0;
}

/**
 * Walk `bytes` as a PNG and throw unless every chunk's declared length and CRC
 * agree with the file, and the image data actually inflates.
 *
 * The three checks are not redundant — they are the three ways the old fixture
 * was broken, and each one alone would have caught it: the IDAT length was one
 * short, its CRC therefore read from shifted bytes, and the truncated deflate
 * stream lost its Adler-32 trailer. Chunk-walking also catches the downstream
 * damage (IEND landed at the wrong offset and declared a 4 GB length), which is
 * what makes the failure message point at the real byte instead of at "zlib said
 * no".
 */
function assertDecodablePng(bytes) {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("image fixture is not a PNG (bad signature)");
  }
  const idat = [];
  let offset = 8;
  let sawEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error(`image fixture: chunk header at ${offset} runs past the end of the file`);
    }
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) {
      throw new Error(
        `image fixture: ${type} declares ${length} bytes at offset ${offset}, which overruns the ${bytes.length}-byte file`,
      );
    }
    const stored = bytes.readUInt32BE(end);
    const computed = zlib.crc32(bytes.subarray(offset + 4, end));
    if (stored !== computed) {
      throw new Error(
        `image fixture: ${type} CRC mismatch (stored ${stored.toString(16)}, computed ${computed.toString(16)}) ` +
          `— its declared length of ${length} is almost certainly wrong`,
      );
    }
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, end));
    if (type === "IEND") sawEnd = true;
    offset = end + 4;
  }
  if (!sawEnd) {
    throw new Error("image fixture: no IEND chunk");
  }
  if (!idat.length) {
    throw new Error("image fixture: no IDAT chunk");
  }
  zlib.inflateSync(Buffer.concat(idat)); // throws on a truncated deflate stream
}

/**
 * A 1×1 red PNG — and, until upstream sync SL-7, a CORRUPT one.
 *
 * The previous literal ended `…AAAAC0lEQVR4…`. That `C0` is the base64 carrying
 * the IDAT chunk's declared length: `0x0b` = 11, for a zlib stream that is 12
 * bytes long. The consequences cascade — the deflate stream is truncated one byte
 * short of its Adler-32 trailer, the four bytes read as the IDAT CRC are shifted
 * (stored `00c9fe92` against a computed `fdd81955`), and IEND then parses with a
 * declared length of 4,009,754,624. Every real decoder rejects it. `file(1)` and
 * macOS `sips` do not, because they read IHDR and stop — which is exactly how a
 * hand-built fixture survives years of being eyeballed.
 *
 * WHAT IT COST, and what it did NOT. codex accepted these bytes as an ATTACHMENT
 * (the chip rendered, and the rollout recorded `{type:"local_image", path}` at
 * full fidelity), then failed to turn them into a model payload and substituted
 * `{"type":"input_text","text":"image content omitted because it could not be
 * processed"}` into every image slot — codex-rs/core/src/image_preparation.rs,
 * the catch-all placeholder for `ImagePreparationError::Processing(_)`. So the
 * model never saw a pixel, in EVERY run of this smoke, at 0.147.0 / 0.152.0 /
 * 0.152.1 alike. It was never a regression and never a codex defect; rejecting a
 * PNG with a truncated deflate stream is correct behaviour.
 *
 * And it is not what made this file red: the assertions here all read the
 * DELIVERY channel (receipt, chip, `userBlock.attachments.length`), which the
 * corrupt bytes travelled through perfectly. The codex cases were failing on the
 * boot/transcript problems SL-6 and SL-8 fixed. The two defects were adjacent and
 * unrelated, which is why the fixture could hide behind the other one.
 *
 * `AAAADElEQVR4` is the same 69-byte file with that one byte set to `0x0c`: IDAT
 * and IEND CRCs both verify and the stream inflates to `00ff0000` (filter byte 0,
 * one red pixel). The literal appears in five e2e files too; those exercise
 * attachment plumbing rather than model-side decoding, so they are unaffected and
 * are left to their own owner (registered, SL-7).
 */
function redPngBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
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
