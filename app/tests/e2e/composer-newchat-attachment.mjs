// Slice A (reframed): a screenshot/bitmap pasted into a BRAND-NEW chat (no
// session yet) becomes an attachment chip, is held in the draft (NOTHING on
// disk), and is materialized + delivered when the first send creates the
// session. This is the real headline flow: screenshot -> open Sonata -> paste ->
// ask, which is a new chat by definition.
//
// NOTE: overwrites the machine clipboard (puts a PNG on it). macOS-only.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";
import { waitForCompletedTurns } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-newchat-attach-"));
const evidenceRoot = process.env.SONATA_EVIDENCE_DIR ?? path.join(workspaceRoot, "evidence");
fs.mkdirSync(evidenceRoot, { recursive: true });

let electronApp = null;
const checks = {};

try {
  const imagePath = path.join(workspaceRoot, "red.png");
  fs.writeFileSync(imagePath, redPngBytes());
  setClipboardImage(imagePath);

  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: { ...process.env, SONATA_DATA_DIR: workspaceRoot, SONATA_WORKSPACES_DIR: workspaceRoot },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);

  // BRAND-NEW chat: do not send anything first. Confirm there is no session yet.
  await page.locator("#prompt-input").waitFor({ state: "visible" });
  checks.startsWithNoTurns = (await page.locator(".turn-card").count()) === 0;

  // Paste the clipboard bitmap into the empty composer.
  await page.locator("#prompt-input").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");

  // Headline: a chip appears in the new chat, before any session exists, and its
  // thumbnail actually RENDERS (a blob: object URL — guards the CSP img-src that
  // must allow blob:, not just that the <img> element exists).
  const chip = page.locator(".attachment-chip").first();
  await chip.waitFor({ state: "visible", timeout: 15000 });
  checks.chipHasImageInNewChat = await thumbnailRenders(chip);
  checks.stillNoSessionAfterPaste = (await page.locator(".turn-card").count()) === 0;

  // C's promise: nothing on disk until send.
  const attachmentsDir = path.join(workspaceRoot, "data", "attachments");
  checks.noBlobBeforeSend = blobCount(attachmentsDir) === 0;
  await page.screenshot({ path: path.join(evidenceRoot, "newchat-chip-before-send.png"), fullPage: true });

  // First send creates the session and materializes + delivers the attachment.
  await page.locator("#prompt-input").fill("Reply exactly SONATA_NEWCHAT_IMAGE_RECEIPT. Do not create or modify any files.");
  await page.locator("#send-prompt").click();
  // S4 pre-trusts the auto workspace — the banner normally never comes; the
  // short wait is fallback tolerance, not the expected path.
  await approveIfVisible(page, "Workspace trust requested", 8000);

  const taskId = await waitForTaskDirectory(path.join(workspaceRoot, "data", "projects"), 60000);
  await waitForCompletedTurns(page, 1);

  // The image was delivered as a native chip in the new-chat flow. NOTE: the 1px
  // red PNG fixture is degenerate, so Claude's API removes it post-delivery
  // ("image could not be processed") — that is orthogonal to delivery; real
  // screenshots read fine. blob->[Image #N] on both CLIs is covered by
  // native-image-attachments.mjs; here we only prove the new-chat path delivers.
  // Reading intentionally lifts the provider's `[Image #N]` marker out of the
  // bubble text into the sent-prompt attachment affordance.
  checks.imageDeliveredAsChip = (await page.locator(".turn-image-chip").count()) > 0;

  // Post-send: the blob now exists under the per-task dir, chip cleared.
  const blobs = listBlobs(path.join(attachmentsDir, taskId));
  checks.blobMaterializedAfterSend = blobs.length >= 1;
  checks.chipClearedAfterSend = (await page.locator(".attachment-chip").count()) === 0;
  await page.screenshot({ path: path.join(evidenceRoot, "newchat-after-send.png"), fullPage: true });

  // Regression: the live (has-session) path still chips, and is now LAZY — the
  // bitmap is held, NOT copied to disk, until send (one blob remains from the
  // first send; the live paste adds no new blob).
  const blobsAfterFirstSend = listBlobs(path.join(attachmentsDir, taskId)).length;
  setClipboardImage(imagePath);
  await page.locator("#prompt-input").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await page.locator(".attachment-chip").first().waitFor({ state: "visible", timeout: 15000 });
  checks.liveChipAfterSession = (await page.locator(".attachment-chip").count()) >= 1;
  await page.waitForTimeout(1500);
  checks.liveLazyNoBlobUntilSend =
    listBlobs(path.join(attachmentsDir, taskId)).length === blobsAfterFirstSend;

  const success = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ success, taskId, blobs, checks, evidenceRoot }, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

function setClipboardImage(imagePath) {
  const scriptPath = path.join(workspaceRoot, "set-clipboard.applescript");
  fs.writeFileSync(scriptPath, `set the clipboard to (read (POSIX file ${JSON.stringify(imagePath)}) as «class PNGf»)\n`, "utf8");
  execFileSync("osascript", [scriptPath]);
}

function blobCount(attachmentsDir) {
  if (!fs.existsSync(attachmentsDir)) {
    return 0;
  }
  let count = 0;
  for (const taskDir of fs.readdirSync(attachmentsDir)) {
    count += listBlobs(path.join(attachmentsDir, taskDir)).length;
  }
  return count;
}

function listBlobs(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

/** True only if the chip's thumbnail image actually decoded/rendered (not just
 *  that the <img> element exists) — catches a CSP-blocked blob:/data: preview. */
async function thumbnailRenders(chip) {
  const img = chip.locator("img").first();
  if ((await img.count()) === 0) {
    return false;
  }
  await img.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  return img.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function waitForTaskDirectory(root, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const found = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("task-"))?.name ?? null;
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the task record directory.");
}

function redPngBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
}
