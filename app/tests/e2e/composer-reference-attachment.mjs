// Slice B: referencing a FILE and a FOLDER via the Add button (the native picker
// is stubbed by DUET_TEST_PICK_REFERENCES). References are NEVER copied (no blob),
// chip as kind icons (not thumbnails), and deliver as a path mention folded into
// the prompt text. The user's originals are never touched (Invariant 4).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";
import { waitForCompletedTurns } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-ref-attach-"));
const evidenceRoot = process.env.DUET_EVIDENCE_DIR ?? path.join(workspaceRoot, "evidence");
fs.mkdirSync(evidenceRoot, { recursive: true });

let electronApp = null;
const checks = {};

try {
  // The user's own file + folder, at a spacey path, OUTSIDE Duet's data dir.
  const userDir = path.join(workspaceRoot, "user docs");
  const refImage = path.join(userDir, "shot.png");
  const refFile = path.join(userDir, "report.pdf");
  const refFolder = path.join(userDir, "src folder");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(refImage, redPngBytes());
  fs.writeFileSync(refFile, "pretend pdf");
  fs.mkdirSync(refFolder, { recursive: true });
  const attachmentsDir = path.join(workspaceRoot, "data", "attachments");

  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: workspaceRoot,
      DUET_WORKSPACES_DIR: workspaceRoot,
      DUET_TEST_PICK_REFERENCES: `${refImage}\n${refFile}\n${refFolder}`,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  await page.locator("#prompt-input").waitFor({ state: "visible" });

  // NEW CHAT: Add button -> "Add files & folders" -> stubbed picker -> references.
  await page.locator("#add-attachment").click();
  await page.locator(".composer-menu-option", { hasText: "Add files & folders" }).click();
  await page.locator(".attachment-chip").nth(2).waitFor({ state: "visible" });

  checks.threeChips = (await page.locator(".attachment-chip").count()) === 3;
  // A referenced IMAGE is a square thumbnail (no text) that actually RENDERS; the
  // file + folder are cards.
  const imageChip = page.locator(".attachment-chip-image");
  checks.imageChipHasThumbnail =
    (await imageChip.locator("img").count()) === 1 &&
    (await imageChip
      .locator("img")
      .first()
      .evaluate((el) => el.complete && el.naturalWidth > 0)
      .catch(() => false));
  checks.fileFolderAreCards = (await page.locator(".attachment-chip-file").count()) === 2;
  checks.oneThumbnailTotal = (await page.locator(".attachment-chip img").count()) === 1;
  // File/folder cards show their name; the image chip shows none (just the thumbnail).
  checks.cardNamesShown =
    (await page.locator(".attachment-chip-file", { hasText: "report.pdf" }).count()) === 1 &&
    (await page.locator(".attachment-chip-file", { hasText: "src folder" }).count()) === 1;
  checks.imageChipHasNoText =
    (await imageChip.evaluate((el) => el.textContent?.trim() === "").catch(() => false));
  // References are not copied — nothing in the blob dir.
  checks.noBlobFromReference = blobCount(attachmentsDir) === 0;
  await page.screenshot({ path: path.join(evidenceRoot, "reference-chips.png"), fullPage: true });

  // Send -> session is created, references fold into the prompt text and deliver.
  await page.locator("#prompt-input").fill("Reply exactly DUET_REF_RECEIPT. Do not create or modify any files.");
  await page.locator("#send-prompt").click();
  await approveIfVisible(page, "Workspace trust requested", 60000);
  await waitForCompletedTurns(page, 1);

  const userText = (await page.locator(".turn-user-text").allTextContents()).join("\n");
  checks.filePathInText = userText.includes(refFile);
  checks.folderPathInText = userText.includes(refFolder);
  // The referenced image chips natively ([Image #N]); file + folder are path text.
  checks.imageDeliveredAsChip = userText.includes("[Image");
  // Still nothing copied; the user's originals survive untouched (Invariant 4).
  checks.stillNoBlob = blobCount(attachmentsDir) === 0;
  checks.originalsIntact = fs.existsSync(refImage) && fs.existsSync(refFile) && fs.existsSync(refFolder);
  await page.screenshot({ path: path.join(evidenceRoot, "reference-delivered.png"), fullPage: true });

  const success = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ success, checks, userTextSample: userText.slice(0, 400), evidenceRoot }, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

function redPngBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
}

function blobCount(attachmentsDir) {
  if (!fs.existsSync(attachmentsDir)) {
    return 0;
  }
  let count = 0;
  for (const taskDir of fs.readdirSync(attachmentsDir)) {
    try {
      count += fs.readdirSync(path.join(attachmentsDir, taskDir)).filter((n) => !n.startsWith(".")).length;
    } catch {
      // not a directory
    }
  }
  return count;
}
