// Copy to Clipboard — deterministic Reading-window interaction fence.
//
// A fake Codex gives us a real provider transcript without model/network
// variance. We append exact rollout records, then drive all three surfaces:
// prompt (hover/focus row), Markdown <pre> (permanent control), and one whole
// assistant reply (settled/runless transcript fixture). The assertions witness
// the system clipboard itself through the preload read bridge — not a stub.
// DUET_COPY_EVIDENCE=1 appends an isolated, color-normalized light/dark visual
// matrix only after the full functional path has passed.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { FAKE_CODEX_SOURCE } from "./helpers/fake-codex-source.mjs";
import { selectSidebarSession } from "./helpers/session.mjs";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-copy-e2e-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "duet-copy-codex-home-"));
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-copy-bin-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-copy-workspace-"));
const fakeCodex = path.join(fakeBinDir, "codex");
const evidenceDir = resolveEvidenceDir();
fs.writeFileSync(fakeCodex, FAKE_CODEX_SOURCE, { mode: 0o755 });
fs.chmodSync(fakeCodex, 0o755);

const USER_TS = "2026-07-14T11:08:00.000Z";
const FIRST_REPLY_TS = "2026-07-14T11:09:00.000Z";
const FINAL_REPLY_TS = "2026-07-14T11:10:00.000Z";
const IMAGE_ONLY_TS = "2026-07-14T11:11:00.000Z";
const PROMPT_TEXT = "Copy this prompt exactly.";
const FIRST_REPLY = "Here is code:\n\n```ts\nconst first = 1;\n```";
const FINAL_REPLY = "Second paragraph.";

let app = null;
const results = {};
const screenshots = [];
try {
  app = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: dataRoot,
      DUET_WORKSPACES_DIR: dataRoot,
      DUET_SETTINGS_DIR: path.join(dataRoot, "config"),
      CODEX_HOME: codexHome,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      ...(evidenceDir ? { TZ: "UTC", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } : {}),
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(60000);

  const created = await page.evaluate(
    async (cwd) => window.duetRuntime.createTask({ provider: "codex", cwd }),
    workspace,
  );
  const taskId = created.task.id;
  await waitFor(() => readSources(taskId).length > 0, 30000, "fake Codex transcript handshake");
  await selectSidebarSession(page, taskId);

  const rolloutPath = readSources(taskId)[0]?.path;
  assert.ok(rolloutPath, "transcript source exposes its rollout path");
  appendRecords(rolloutPath, [
    record(USER_TS, "task_started", { turn_id: "copy-turn-1" }),
    record(USER_TS, "user_message", {
      message: `[Image #1] ${PROMPT_TEXT}`,
      local_images: ["/tmp/duet-copy-fixture.png"],
    }),
    record(FIRST_REPLY_TS, "agent_message", { message: FIRST_REPLY }),
  ]);

  const card = page.locator(".turn-card", { hasText: "const first = 1" }).first();
  await card.locator(".turn-answer").waitFor({ state: "visible" });

  // ── User prompt: reserved row, whole-area hover bridge, cleaned payload ──
  const promptHeader = card.locator(".turn-user");
  const promptMeta = promptHeader.locator(".turn-user-meta");
  const promptCopy = promptMeta.locator(".transcript-copy-button");
  const answerYBefore = (await card.locator(".turn-answer").boundingBox())?.y ?? null;
  const opacityBefore = await promptMeta.evaluate((node) => getComputedStyle(node).opacity);
  await promptHeader.hover();
  await page.waitForFunction(
    (node) => getComputedStyle(node).opacity === "1",
    await promptMeta.elementHandle(),
  );
  const opacityOnHeader = await promptMeta.evaluate((node) => getComputedStyle(node).opacity);
  const answerYOnHover = (await card.locator(".turn-answer").boundingBox())?.y ?? null;
  await promptCopy.hover();
  await page.waitForFunction(
    (node) => getComputedStyle(node).opacity === "1",
    await promptMeta.elementHandle(),
  );
  const opacityOnButton = await promptMeta.evaluate((node) => getComputedStyle(node).opacity);
  const promptOrder = await promptMeta.evaluate((node) =>
    Array.from(node.children).map((child) => child.tagName.toLowerCase()),
  );
  results.promptHoverBridge =
    opacityBefore === "0" && opacityOnHeader === "1" && opacityOnButton === "1";
  results.promptHasNoLayoutShift = answerYBefore !== null && answerYBefore === answerYOnHover;
  results.promptOrderAndTime =
    promptOrder.join(",") === "time,button" &&
    (await promptMeta.locator("time").getAttribute("datetime")) === USER_TS;

  await promptCopy.click();
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute("data-copy-state") === "copied",
    ".turn-user-meta .transcript-copy-button",
  );
  results.promptClipboard = (await readClipboard(page)) === PROMPT_TEXT;
  results.promptShowsCheck = (await promptCopy.getAttribute("data-copy-state")) === "copied";

  // ── Code block: permanent target, literal code, reserved content inset ───
  const codeCopy = card.locator(".code-block-copy").first();
  await codeCopy.waitFor({ state: "visible" });
  const idleCodeIcon = await codeCopy.innerHTML();
  const codeGeometry = await codeCopy.evaluate((button) => {
    const pre = button.parentElement?.querySelector("pre");
    if (!pre) return null;
    const preStyle = getComputedStyle(pre);
    const buttonStyle = getComputedStyle(button);
    return {
      paddingRight: Number.parseFloat(preStyle.paddingRight),
      reserved: button.getBoundingClientRect().width + Number.parseFloat(buttonStyle.right),
    };
  });
  results.codeDoesNotOverlap =
    codeGeometry !== null && codeGeometry.paddingRight >= codeGeometry.reserved;

  await codeCopy.click();
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute("data-copy-state") === "copied",
    ".code-block-copy",
  );
  results.codeClipboard = (await readClipboard(page)) === "const first = 1;\n";
  results.codeShowsCheck = (await codeCopy.innerHTML()) !== idleCodeIcon;

  // Add content to the SAME turn while Check is live. The turn card is rebuilt;
  // target-key feedback must outlive the discarded button DOM.
  await card.evaluate((node) => node.setAttribute("data-copy-before-stream", "true"));
  appendRecords(rolloutPath, [record(FINAL_REPLY_TS, "agent_message", { message: FINAL_REPLY })]);
  await page.locator(".turn-card", { hasText: FINAL_REPLY }).first().waitFor({ state: "visible" });
  const updatedCard = page.locator(".turn-card", { hasText: FINAL_REPLY }).first();
  const streamedCodeCopy = updatedCard.locator(".code-block-copy").first();
  results.cardActuallyReconciled =
    (await page.locator('[data-copy-before-stream="true"]').count()) === 0;
  results.checkSurvivesReconcile =
    (await streamedCodeCopy.getAttribute("data-copy-state")) === "copied";

  await page.waitForTimeout(3200);
  results.checkResetsAfterThreeSeconds =
    (await streamedCodeCopy.getAttribute("data-copy-state")) === "idle" &&
    (await streamedCodeCopy.innerHTML()) === idleCodeIcon;

  // ── Whole reply: one persistent footer, Markdown payload, final block time ─
  const replyMeta = updatedCard.locator(".turn-assistant-meta");
  const replyCopy = replyMeta.locator(".transcript-copy-button");
  const replyOrder = await replyMeta.evaluate((node) =>
    Array.from(node.children).map((child) => child.tagName.toLowerCase()),
  );
  const idleReplyIcon = await replyCopy.innerHTML();
  results.replyOrderAndTime =
    replyOrder.join(",") === "button,time" &&
    (await replyMeta.locator("time").getAttribute("datetime")) === FINAL_REPLY_TS;
  results.replyMetaOutsideAnswer =
    (await updatedCard.locator(".turn-answer .turn-assistant-meta").count()) === 0;

  await replyCopy.click();
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute("data-copy-state") === "copied",
    ".turn-assistant-meta .transcript-copy-button",
  );
  results.replyClipboard =
    (await readClipboard(page)) === `${FIRST_REPLY}\n\n${FINAL_REPLY}`;

  // A retry failure while the old Check is visible must immediately restore
  // Copy on the CURRENT mounted target — no stale success signal.
  const overrideInstalled = await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    try {
      const original = clipboard.writeText.bind(clipboard);
      Object.defineProperty(window, "__duetOriginalWriteText", { value: original, configurable: true });
      Object.defineProperty(clipboard, "writeText", {
        configurable: true,
        value: () => Promise.reject(new DOMException("blocked", "NotAllowedError")),
      });
      return true;
    } catch {
      return false;
    }
  });
  assert.ok(overrideInstalled, "clipboard failure override installed in renderer");
  await replyCopy.click();
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute("data-copy-state") === "error",
    ".turn-assistant-meta .transcript-copy-button",
  );
  results.failureRestoresCopy =
    (await replyCopy.innerHTML()) === idleReplyIcon &&
    (await replyCopy.getAttribute("aria-label")) === "Copy failed. Try again";

  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const original = window.__duetOriginalWriteText;
    if (typeof original === "function") {
      Object.defineProperty(clipboard, "writeText", { configurable: true, value: original });
    }
    delete window.__duetOriginalWriteText;
  });

  // ── Image-only prompt: time remains, text-copy action is absent ──────────
  appendRecords(rolloutPath, [
    record(IMAGE_ONLY_TS, "task_started", { turn_id: "copy-turn-2" }),
    record(IMAGE_ONLY_TS, "user_message", {
      message: "[Image #1]",
      local_images: ["/tmp/duet-copy-image-only.png"],
    }),
  ]);
  await page.locator(".turn-card").nth(1).waitFor({ state: "visible" });
  const imageOnlyCard = page.locator(".turn-card").last();
  await imageOnlyCard.locator(".turn-image-chip").waitFor({ state: "visible" });
  results.imageOnlyHasTimeNoCopy =
    (await imageOnlyCard.locator(".turn-user-meta time").getAttribute("datetime")) === IMAGE_ONLY_TS &&
    (await imageOnlyCard.locator(".turn-user-meta .transcript-copy-button").count()) === 0;

  const success = Object.values(results).every(Boolean);
  assert.ok(success, "all copy-to-clipboard interaction checks passed");
  if (evidenceDir) {
    await captureVisualEvidence(page, updatedCard);
  }
  console.log(
    JSON.stringify({ dataRoot, taskId, evidenceDir, screenshots, results, success }, null, 2),
  );
  console.log("copy-to-clipboard e2e: OK — three copy surfaces hold their contracts");
} catch (error) {
  console.error("copy-to-clipboard e2e FAILED:", error);
  console.log(JSON.stringify({ evidenceDir, screenshots, results }, null, 2));
  process.exitCode = 1;
} finally {
  await app?.close();
  for (const directory of [dataRoot, codexHome, fakeBinDir, workspace]) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function record(timestamp, type, payload) {
  return { timestamp, type: "event_msg", payload: { type, ...payload } };
}

function appendRecords(filePath, records) {
  fs.appendFileSync(filePath, records.map((value) => JSON.stringify(value)).join("\n") + "\n");
}

function readSources(taskId) {
  try {
    return (
      JSON.parse(
        fs.readFileSync(
          path.join(dataRoot, "data", "projects", taskId, "transcript-sources.json"),
          "utf8",
        ),
      ).sources ?? []
    );
  } catch {
    return [];
  }
}

async function readClipboard(page) {
  const response = await page.evaluate(() => window.duetRuntime.readClipboardText());
  return response.text;
}

function resolveEvidenceDir() {
  const configured = process.env.DUET_COPY_EVIDENCE_DIR?.trim();
  if (configured) {
    const directory = path.resolve(configured);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }
  if (process.env.DUET_COPY_EVIDENCE !== "1") {
    return null;
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), "duet-copy-evidence-"));
}

async function captureVisualEvidence(page, card) {
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
  });
  await setMode(page, "light");
  await page.keyboard.press("Escape");

  // The functional path deliberately ends with a failed reply-copy retry.
  // Restore a real successful/idle state before recording the visual matrix.
  const replyCopy = card.locator(".turn-assistant-meta .transcript-copy-button");
  await replyCopy.click();
  await waitForCopyState(replyCopy, "copied");
  await page.waitForTimeout(3200);
  await waitForCopyState(replyCopy, "idle");

  await movePointerToNeutral(page, 300);
  await capture(page, card, "01-card-idle-light.png", "light");
  await capturePromptCopyHover(
    page,
    card,
    "02-prompt-copy-hover-light.png",
    "light",
  );

  const codeCopy = card.locator(".code-block-copy").first();
  await codeCopy.click();
  await waitForCopyState(codeCopy, "copied");
  await movePointerToNeutral(page, 150);
  await capture(page, card, "03-code-copied-light.png", "light");
  await page.waitForTimeout(3200);
  await waitForCopyState(codeCopy, "idle");

  await replyCopy.click();
  await waitForCopyState(replyCopy, "copied");
  await setMode(page, "dark");
  await capturePromptCopyHover(
    page,
    card,
    "04-prompt-copy-hover-reply-copied-dark.png",
    "dark",
  );

  assert.deepEqual(screenshots, [
    "01-card-idle-light.png",
    "02-prompt-copy-hover-light.png",
    "03-code-copied-light.png",
    "04-prompt-copy-hover-reply-copied-dark.png",
  ]);
}

async function capture(page, locator, fileName, expectedMode, prepare = null) {
  await locator.scrollIntoViewIfNeeded();
  assert.ok(await locator.boundingBox(), `visual target is measurable: ${fileName}`);
  assert.equal(
    await page.locator("html").getAttribute("data-mode"),
    expectedMode,
    `visual mode for ${fileName}`,
  );

  const filePath = path.join(evidenceDir, fileName);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (prepare) await prepare();
    const rawPng = await page.screenshot({ fullPage: false });
    const normalized = await normalizeScreenshot(page, rawPng);
    fs.writeFileSync(filePath, normalized.png);
    const nearBlackRatio = normalized.nearBlackRatio;
    if (nearBlackRatio < 0.15) {
      screenshots.push(fileName);
      return;
    }
    await movePointerToNeutral(page, 300);
  }
  throw new Error(`Corrupt visual evidence retained at ${filePath}: repeated black frames`);
}

async function capturePromptCopyHover(page, card, fileName, expectedMode) {
  const header = card.locator(".turn-user");
  const meta = header.locator(".turn-user-meta");
  const copy = meta.locator(".transcript-copy-button");
  await capture(page, card, fileName, expectedMode, async () => {
    await header.hover();
    await page.waitForFunction(
      (node) => getComputedStyle(node).opacity === "1",
      await meta.elementHandle(),
    );
    await copy.hover();
  });
}

async function normalizeScreenshot(page, png) {
  const normalized = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const output = document.createElement("canvas");
    output.width = image.naturalWidth;
    output.height = image.naturalHeight;
    const outputContext = output.getContext("2d");
    if (!outputContext) return null;
    outputContext.drawImage(image, 0, 0);

    const sample = document.createElement("canvas");
    sample.width = 180;
    sample.height = Math.max(1, Math.round((image.naturalHeight / image.naturalWidth) * 180));
    const sampleContext = sample.getContext("2d", { willReadFrequently: true });
    if (!sampleContext) return null;
    sampleContext.drawImage(output, 0, 0, sample.width, sample.height);
    const pixels = sampleContext.getImageData(0, 0, sample.width, sample.height).data;
    let nearBlack = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 8 && pixels[index + 1] < 8 && pixels[index + 2] < 8) {
        nearBlack += 1;
      }
    }
    return {
      nearBlackRatio: nearBlack / (pixels.length / 4),
      pngBase64: output.toDataURL("image/png").split(",")[1],
    };
  }, png.toString("base64"));
  assert.ok(normalized, "browser can normalize visual evidence");
  return {
    nearBlackRatio: normalized.nearBlackRatio,
    png: Buffer.from(normalized.pngBase64, "base64"),
  };
}

async function waitForCopyState(locator, state) {
  await locator.page().waitForFunction(
    ([element, expected]) => element?.getAttribute("data-copy-state") === expected,
    [await locator.elementHandle(), state],
  );
}

async function movePointerToNeutral(page, settleMs) {
  const point = await page.evaluate(() => ({ x: innerWidth / 2, y: innerHeight - 2 }));
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(settleMs);
}

async function setMode(page, mode) {
  const label = mode === "dark" ? "Dark" : "Light";
  await page.locator("#reading-settings").click();
  await page.locator(".reading-segment", { hasText: label }).click();
  await page.keyboard.press("Escape");
  await page.locator(`html[data-mode="${mode}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(150);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
