import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { _electron as electron } from "playwright-core";
import { chooseDraftProvider, sendFirstPrompt, waitForCompletedTurns } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-reading-navigation-workspace-"));
const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-reading-navigation-store-"));
const evidenceDir = process.env.SONATA_READING_NAV_EVIDENCE_DIR
  ? path.resolve(process.env.SONATA_READING_NAV_EVIDENCE_DIR)
  : null;
let electronApp = null;

try {
  if (evidenceDir) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  let page = await launchApp();
  await startFixtureTask(page);
  await injectReadingFixture(page);
  const navResult = await withLiveFixture(page, () => assertPromptNavigation(page));
  const stickyResult = await withLiveFixture(page, () => assertStickyPromptHeader(page));

  if (evidenceDir) {
    await captureScreenshots(page, evidenceDir);
    await electronApp.close();
    electronApp = null;
    await captureGestureRecording();
  }

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        navResult,
        stickyResult,
        evidenceDir,
        success: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(settingsRoot, { recursive: true, force: true });
}

async function launchApp(options = {}) {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot, SONATA_WORKSPACES_DIR: workspaceRoot,
      SONATA_SETTINGS_DIR: settingsRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(60000);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({
    state: "visible",
  });
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.readingFirstFrame));
  await page.waitForTimeout(150);
  return page;
}

async function injectReadingFixture(page, options = {}) {
  await page.evaluate((fixtureOptions) => {
    const runList = document.querySelector("#run-list");
    const input = document.querySelector("#prompt-input");
    if (!(runList instanceof HTMLElement) || !(input instanceof HTMLTextAreaElement)) {
      throw new Error("Reading fixture target was not found.");
    }

    const rail = runList.querySelector(".sticky-prompt-rail") ?? document.createElement("div");
    if (!rail.classList.contains("sticky-prompt-rail")) {
      rail.className = "sticky-prompt-rail";
      const sticky = document.createElement("button");
      sticky.id = "sticky-prompt-header";
      sticky.className = "sticky-prompt-header hidden";
      sticky.type = "button";
      sticky.setAttribute("aria-label", "Scroll to the prompt for this reply");
      rail.append(sticky);
    }
    runList.replaceChildren(rail);

    const turns = [
      {
        key: "fixture-turn-1",
        prompt: "First prompt: map the reading surface and explain the renderer state.",
        paragraphs: 22,
      },
      {
        key: "fixture-turn-2",
        prompt: "Second prompt: compare terminal navigation models against a textarea composer.",
        paragraphs: 14,
      },
      {
        key: "fixture-turn-3",
        prompt: "Third prompt: summarize the acceptance pass and keyboard gestures.",
        paragraphs: 10,
      },
    ];

    for (const turn of turns) {
      runList.append(renderFixtureTurn(turn));
    }

    input.disabled = false;
    input.value = "";
    input.placeholder = "Continue, correct, or redirect this Task";
    if (fixtureOptions.preserveTasklessComposerFocus && input.dataset.readingNavFocusGuard !== "true") {
      input.dataset.readingNavFocusGuard = "true";
      input.addEventListener(
        "focus",
        (event) => {
          event.stopImmediatePropagation();
        },
        true,
      );
    }
    runList.scrollTop = 0;
    input.focus({ preventScroll: true });

    function renderFixtureTurn(turn) {
      const card = document.createElement("article");
      card.className = "turn-card";
      card.dataset.turnKey = turn.key;

      const header = document.createElement("header");
      header.className = "turn-user";
      header.dataset.turnKey = turn.key;
      const prompt = document.createElement("div");
      prompt.className = "turn-user-text turn-prompt";
      prompt.tabIndex = -1;
      prompt.dataset.turnKey = turn.key;
      prompt.textContent = turn.prompt;
      prompt.setAttribute("aria-label", `Prompt: ${turn.prompt}`);
      header.append(prompt);

      const body = document.createElement("div");
      body.className = "turn-body turn-answer";
      const md = document.createElement("div");
      md.className = "md-body";
      for (let index = 0; index < turn.paragraphs; index += 1) {
        const paragraph = document.createElement("p");
        paragraph.textContent =
          `Fixture reply paragraph ${index + 1} for ${turn.key}. ` +
          "This long answer creates enough reading depth for sticky prompt handoff and scroll assertions.";
        md.append(paragraph);
      }
      body.append(md);
      card.append(header, body);
      return card;
    }
  }, options);
}

async function startFixtureTask(page) {
  // Sessions are born from the first composer message (deferred creation);
  // the fixture only needs the run list and composer in their task state, so
  // start the session with a no-op prompt and let the run settle before the
  // fixture replaces the run list contents.
  await chooseDraftProvider(page, "codex");
  await sendFirstPrompt(page, [
    "Reply exactly SONATA_READING_NAV_READY.",
    "Do not create or modify any files.",
  ]);
  await waitForCompletedTurns(page, 1);
  await page.locator("#send-prompt").waitFor({ state: "visible" });
}

async function assertPromptNavigation(page) {
  await setTheme(page, "default", "light");
  await focusComposer(page);
  await page.keyboard.press("Meta+ArrowUp");
  await assertActivePrompt(page, "Third prompt", "Cmd+Up enters on newest prompt");

  await page.keyboard.press("ArrowUp");
  await assertActivePrompt(page, "Second prompt", "ArrowUp moves older");
  await page.keyboard.press("ArrowUp");
  await assertActivePrompt(page, "First prompt", "ArrowUp reaches oldest");
  await page.keyboard.press("ArrowUp");
  await assertActivePrompt(page, "First prompt", "ArrowUp on oldest no-ops");

  await page.keyboard.press("ArrowDown");
  await assertActivePrompt(page, "Second prompt", "ArrowDown moves newer");
  await page.keyboard.press("ArrowDown");
  await assertActivePrompt(page, "Third prompt", "ArrowDown reaches newest");
  await page.keyboard.press("ArrowDown");
  await assertComposerFocused(page, "ArrowDown past newest exits to composer");

  await focusComposer(page);
  await page.keyboard.press("Meta+ArrowUp");
  await assertActivePrompt(page, "Third prompt", "re-enter before Cmd+C");
  await page.keyboard.press("Meta+C");
  await assertActivePrompt(page, "Third prompt", "Cmd+C does not exit prompt-nav");
  await page.keyboard.press("Escape");
  await assertComposerFocused(page, "Esc exits prompt-nav");

  await clearComposer(page);
  await focusComposer(page);
  await page.keyboard.press("Meta+ArrowUp");
  await assertActivePrompt(page, "Third prompt", "re-enter before printable typing");
  await page.keyboard.press("x");
  await assertComposerFocused(page, "printable typing exits to composer");
  const composerValue = await page.locator("#prompt-input").inputValue();
  assertEqual(composerValue, "x", "printable key landed in composer");

  return {
    composerValue,
    newestEntry: "Third prompt",
  };
}

// The fixture DOM lives inside #run-list, which the app rebuilds from real
// state whenever a late runtime event (statusline/usage tick from the idle
// fixture session) triggers a render. A wipe mid-assertion strands the test
// against a one-card, unscrollable list. Detect the wipe, re-inject, and
// retry — but only when the fixture actually vanished, so a genuine
// assertion failure against an intact fixture still fails the test.
async function withLiveFixture(page, run, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!(await fixtureAlive(page))) {
      console.error(`fixture wiped by app re-render; re-injecting (attempt ${attempt})`);
      await injectReadingFixture(page);
    }
    try {
      return await run();
    } catch (error) {
      if (await fixtureAlive(page)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

async function fixtureAlive(page) {
  return page.evaluate(() =>
    Boolean(document.querySelector('.turn-card[data-turn-key="fixture-turn-1"]')),
  );
}

async function assertStickyPromptHeader(page) {
  await clearComposer(page);
  await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    if (runList instanceof HTMLElement) {
      runList.scrollTop = 0;
    }
  });
  await page.locator(".sticky-prompt-header").waitFor({ state: "hidden" });
  const scrollTop = await scrollUntilSticky(page, "First prompt");
  await page.locator(".sticky-prompt-header", { hasText: "First prompt" }).waitFor({
    state: "visible",
  });
  // The pill floats over live scrolling content (its rail is height:0, z-index:4),
  // so its hover background must stay opaque. --surface-selected is a translucent
  // overlay token; the fix layers it over the opaque --surface-raised base rather
  // than replacing it. Prove the layered gradient survives in the resolved hover
  // style (a bare-token regression would compute background-image: none).
  await page.locator(".sticky-prompt-header").hover();
  const hoverBackgroundImage = await page.evaluate(() => {
    const header = document.querySelector(".sticky-prompt-header");
    return header instanceof HTMLElement ? getComputedStyle(header).backgroundImage : "";
  });
  if (!hoverBackgroundImage.includes("gradient")) {
    throw new Error(
      `sticky header hover must stay opaque (overlay layered over raised base): expected a gradient layer, got background-image ${hoverBackgroundImage}`,
    );
  }
  await page.locator(".sticky-prompt-header").click();
  await page.waitForFunction(() => {
    const header = document.querySelector(".sticky-prompt-header");
    const runList = document.querySelector("#run-list");
    return (
      header instanceof HTMLElement &&
      runList instanceof HTMLElement &&
      header.classList.contains("hidden") &&
      runList.scrollTop < 80
    );
  });

  return {
    visibleAfterScroll: true,
    scrollTop,
    hoverBackgroundImage,
    hiddenAfterClick: true,
  };
}

async function captureScreenshots(page, dir) {
  await injectReadingFixture(page);
  await setTheme(page, "default", "light");
  await focusComposer(page);
  await page.keyboard.press("Meta+ArrowUp");
  await page.screenshot({ path: path.join(dir, "01-nav-active-default-light.png"), fullPage: false });

  await page.keyboard.press("Escape");
  await setTheme(page, "calm", "dark");
  await scrollUntilSticky(page, "First prompt");
  await focusComposer(page);
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.screenshot({ path: path.join(dir, "02-nav-active-calm-dark.png"), fullPage: false });

  await page.keyboard.press("Escape");
  await setTheme(page, "default", "light");
  await scrollUntilSticky(page, "First prompt");
  await page.screenshot({ path: path.join(dir, "03-sticky-header-default-light.png"), fullPage: false });

  await setTheme(page, "focus", "dark");
  await scrollUntilSticky(page, "First prompt");
  await page.screenshot({ path: path.join(dir, "04-sticky-header-focus-dark.png"), fullPage: false });
}

async function captureGestureRecording() {
  if (!evidenceDir) {
    return;
  }
  const finalVideo = path.join(evidenceDir, "05-gesture-loop.mp4");
  const framesDir = path.join(evidenceDir, "gesture-loop-frames");
  fs.rmSync(finalVideo, { force: true });
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const page = await launchApp();
  await injectReadingFixture(page, { preserveTasklessComposerFocus: true });
  await setTheme(page, "default", "light");
  const fps = 2;
  let frameIndex = 0;
  const hold = async (seconds) => {
    const framePath = path.join(framesDir, `frame-${String(frameIndex).padStart(3, "0")}.png`);
    await page.screenshot({ path: framePath, fullPage: false });
    const repeat = Math.max(1, Math.round(seconds * fps));
    for (let index = 1; index < repeat; index += 1) {
      const nextFramePath = path.join(framesDir, `frame-${String(frameIndex + index).padStart(3, "0")}.png`);
      fs.copyFileSync(framePath, nextFramePath);
    }
    frameIndex += repeat;
  };

  await focusComposer(page);
  await hold(2);
  await page.keyboard.press("Meta+ArrowUp");
  await hold(1.5);
  await page.keyboard.press("ArrowUp");
  await hold(1.5);
  await page.keyboard.press("ArrowUp");
  await hold(1.5);
  await page.keyboard.press("ArrowDown");
  await hold(1.5);
  await page.keyboard.press("ArrowDown");
  await hold(1.5);
  await page.keyboard.press("ArrowDown");
  await hold(2);
  await scrollUntilSticky(page, "First prompt", { delayMs: 650 });
  await hold(2);
  await page.locator(".sticky-prompt-header").click();
  await hold(2);

  encodeGestureVideo(framesDir, finalVideo, fps);
  fs.rmSync(framesDir, { recursive: true, force: true });
  await electronApp.close();
  electronApp = null;
  if (!fs.existsSync(finalVideo)) {
    throw new Error("Gesture recording did not produce a video file.");
  }
}

function encodeGestureVideo(framesDir, outputPath, fps) {
  const script = `
import glob
import os
import sys
import cv2

frames_dir, output_path, fps_value = sys.argv[1], sys.argv[2], float(sys.argv[3])
frames = sorted(glob.glob(os.path.join(frames_dir, "frame-*.png")))
if not frames:
    raise SystemExit("no frames found")
first = cv2.imread(frames[0])
if first is None:
    raise SystemExit("could not read first frame")
height, width = first.shape[:2]
writer = cv2.VideoWriter(output_path, cv2.VideoWriter_fourcc(*"mp4v"), fps_value, (width, height))
for frame in frames:
    image = cv2.imread(frame)
    if image is None:
        raise SystemExit(f"could not read frame {frame}")
    if image.shape[:2] != (height, width):
        image = cv2.resize(image, (width, height))
    writer.write(image)
writer.release()
if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
    raise SystemExit("video writer did not produce output")
`;
  const result = spawnSync("python3", ["-c", script, framesDir, outputPath, String(fps)], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Could not encode gesture video: ${result.stderr || result.stdout}`);
  }
}

async function setTheme(page, theme, mode) {
  await page.evaluate(
    ({ theme: nextTheme, mode: nextMode }) => {
      const root = document.documentElement;
      root.dataset.theme = nextTheme;
      root.dataset.mode = nextMode;
      root.dataset.readingModeSetting = nextMode;
    },
    { theme, mode },
  );
}

async function focusComposer(page) {
  await page.evaluate(() => {
    const input = document.querySelector("#prompt-input");
    if (input instanceof HTMLTextAreaElement) {
      input.disabled = false;
      input.focus({ preventScroll: true });
    }
  });
}

async function clearComposer(page) {
  await page.evaluate(() => {
    const input = document.querySelector("#prompt-input");
    if (input instanceof HTMLTextAreaElement) {
      input.value = "";
      input.setSelectionRange(0, 0);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}

async function assertActivePrompt(page, expectedText, label) {
  await page.waitForFunction(
    (expected) => {
      const active = document.activeElement;
      return (
        active instanceof HTMLElement &&
        active.classList.contains("turn-prompt") &&
        active.classList.contains("prompt-nav-selected") &&
        active.textContent?.includes(expected)
      );
    },
    expectedText,
  );
  const text = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  if (!text.includes(expectedText)) {
    throw new Error(`${label}: expected active prompt containing ${expectedText}, got ${text}`);
  }
}

async function assertComposerFocused(page, label) {
  await page.waitForFunction(() => document.activeElement?.id === "prompt-input");
  const activeId = await page.evaluate(() => document.activeElement?.id ?? "");
  assertEqual(activeId, "prompt-input", label);
}

async function scrollUntilSticky(page, expectedText, options = {}) {
  const holdMs = options.delayMs ?? 0;
  for (const scrollTop of [120, 180, 240, 320, 420, 560, 720, 900]) {
    await page.evaluate((nextScrollTop) => {
      const runList = document.querySelector("#run-list");
      if (runList instanceof HTMLElement) {
        runList.scrollTop = nextScrollTop;
      }
    }, scrollTop);
    await settleStickyPromptSync(page);
    if (holdMs > 0) {
      await page.waitForTimeout(holdMs);
    }
    const visible = await page.evaluate((expected) => {
      const header = document.querySelector(".sticky-prompt-header");
      return (
        header instanceof HTMLElement &&
        !header.classList.contains("hidden") &&
        header.textContent?.includes(expected)
      );
    }, expectedText);
    if (visible) {
      return scrollTop;
    }
  }
  const state = await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    const header = document.querySelector(".sticky-prompt-header");
    const listRect = runList?.getBoundingClientRect();
    return {
      scrollTop: runList?.scrollTop,
      scrollHeight: runList?.scrollHeight,
      listRect: listRect ? { top: listRect.top, height: listRect.height } : null,
      eyeY: listRect ? listRect.top + Math.min(96, listRect.height * 0.28) : null,
      header: header
        ? { hidden: header.classList.contains("hidden"), text: header.textContent }
        : null,
      cards: Array.from(document.querySelectorAll(".turn-card")).map((card) => {
        const rect = card.getBoundingClientRect();
        const prompt = card.querySelector(".turn-prompt");
        const promptRect = prompt?.getBoundingClientRect();
        return {
          key: card.dataset.turnKey,
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          promptBottom: promptRect ? Math.round(promptRect.bottom) : null,
        };
      }),
    };
  });
  throw new Error(
    `Sticky prompt header did not appear for ${expectedText}. State: ${JSON.stringify(state)}`,
  );
}

// The app coalesces sticky-header updates into a requestAnimationFrame
// (scheduleStickyPromptSync), so a fixed sleep races that frame and loses
// whenever Electron throttles rendering. Wait for two real frames instead:
// the scroll event's scheduled sync runs within the first, and the second
// covers this probe being queued ahead of it in the same frame.
async function settleStickyPromptSync(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve(undefined));
        });
      }),
  );
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}
