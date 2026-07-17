// Slice 5 production fence: visibility follows the real Reading scroller,
// internal and sibling layout changes are observed, and activation respects
// motion preferences while preserving keyboard focus.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-reading-scroll-"));
const evidenceDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

let app;
try {
  app = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: path.join(root, "data"),
      SONATA_WORKSPACES_DIR: path.join(root, "workspaces"),
      SONATA_SETTINGS_DIR: path.join(root, "settings"),
      SONATA_NOTIFICATIONS: "0",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.readingFirstFrame));
  await setAppearance(page, "default", "light");

  const initial = await readControl(page);
  assert(initial.hidden && initial.ariaHidden === "true" && initial.tabIndex === -1, "no overflow hides control");
  assert(initial.iconHidden, "decorative arrow is hidden from accessibility tree");

  await installFixture(page);
  await scrollToBottom(page);
  await expectVisible(page, false);
  await scrollToTop(page);
  await expectVisible(page, true);

  const visual = await readControl(page);
  assert(near(visual.width, 40) && near(visual.height, 40), "control is a 40px circle");
  assert(visual.borderRadius === "999px", "control has a circular radius");
  assert(near(visual.centerX, visual.columnCenterX), "control is centered in Reading column");
  assert(visual.bottom < visual.composerTop, "control floats above Composer");
  assert(visual.ariaHidden === "false" && visual.tabIndex === 0, "visible control is keyboard reachable");
  assert(visual.label === "Scroll to bottom" && visual.title === "Scroll to bottom", "accessible name and tooltip");
  if (evidenceDir) {
    await page.locator("#run-column").screenshot({
      path: path.join(evidenceDir, "scroll-to-bottom-light.png"),
      animations: "disabled",
    });
    await setAppearance(page, "default", "dark");
    await page.locator("#run-column").screenshot({
      path: path.join(evidenceDir, "scroll-to-bottom-dark.png"),
      animations: "disabled",
    });
    await setAppearance(page, "default", "light");
  }

  // The disabled-textarea fallback moves focus to the Composer form itself.
  // Gate the actual outline against the surrounding reading surface in every
  // supported theme/mode pair, rather than merely checking :focus-visible.
  const composerFocusMatrix = await readComposerFocusContrastMatrix(page);
  assert(
    composerFocusMatrix.every(
      (entry) =>
        entry.focusVisible &&
        entry.outlineStyle !== "none" &&
        entry.outlineWidth === "2px" &&
        entry.focusContrast >= 3,
    ),
    `Composer fallback focus is perceptible in every theme/mode (${JSON.stringify(composerFocusMatrix)})`,
  );

  // Pointer activation: native smooth scroll, then focus lands in Composer so
  // the disappearing control cannot strand focus.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("#scroll-to-bottom").click();
  await expectScrollCall(page, "smooth");
  await expectComposerFocus(page);
  await expectVisible(page, false);
  assert((await distanceFromBottom(page)) <= 64, "pointer activation reaches near-bottom zone");

  // Keyboard activation under reduced motion is immediate and has the same
  // focus handoff.
  await scrollToTop(page);
  await expectVisible(page, true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#scroll-to-bottom").focus();
  await page.keyboard.press("Enter");
  await expectScrollCall(page, "auto");
  await expectComposerFocus(page);
  await expectVisible(page, false);
  assert((await distanceFromBottom(page)) <= 64, "reduced-motion activation reaches bottom");

  // A direct child's nested content grows while the viewport remains fixed.
  // The control must appear even though #run-list's border box did not resize.
  await scrollToBottom(page);
  const growth = await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    const content = document.querySelector("#reading-scroll-fixture");
    const before = {
      clientHeight: runList.clientHeight,
      scrollHeight: runList.scrollHeight,
    };
    const late = document.createElement("div");
    late.id = "reading-scroll-late-content";
    late.style.height = "180px";
    late.textContent = "Asynchronous content growth";
    content.append(late);
    return before;
  });
  await expectVisible(page, true);
  const afterGrowth = await scrollMetrics(page);
  assert(afterGrowth.clientHeight === growth.clientHeight, "async growth keeps viewport fixed");
  assert(afterGrowth.scrollHeight >= growth.scrollHeight + 175, "async content increases scroll height");

  // Details disclosure and decoded image growth are non-render mutations that
  // must update the control without a Reading state transition.
  await page.evaluate(() => {
    const details = document.createElement("details");
    details.id = "reading-scroll-details";
    const summary = document.createElement("summary");
    summary.textContent = "More detail";
    const body = document.createElement("div");
    body.style.height = "170px";
    body.textContent = "Late details content";
    details.append(summary, body);
    document.querySelector("#reading-scroll-fixture").append(details);
  });
  await scrollToBottom(page);
  await page.evaluate(() => {
    document.querySelector("#reading-scroll-details").open = true;
  });
  await expectVisible(page, true);

  await page.evaluate(() => {
    const image = document.createElement("img");
    image.id = "reading-scroll-image";
    image.alt = "";
    image.style.display = "block";
    image.style.width = "1px";
    image.style.height = "1px";
    document.querySelector("#reading-scroll-fixture").append(image);
  });
  await scrollToBottom(page);
  await page.evaluate(() => {
    const image = document.querySelector("#reading-scroll-image");
    image.style.height = "170px";
    image.dispatchEvent(new Event("load"));
  });
  await expectVisible(page, true);

  // Composer growth is outside the scroller: it shrinks the flex viewport and
  // must still re-evaluate the bottom relation.
  await scrollToBottom(page);
  const composerBefore = await scrollMetrics(page);
  await page.evaluate(() => {
    document.querySelector("#composer").style.minHeight = "320px";
  });
  await expectVisible(page, true);
  const composerAfter = await scrollMetrics(page);
  assert(composerAfter.clientHeight < composerBefore.clientHeight - 64, "Composer growth shrinks viewport");
  await page.evaluate(() => {
    document.querySelector("#composer").style.removeProperty("min-height");
  });

  // Resume choice and top attention banners are separate flex siblings too.
  await scrollToBottom(page);
  await page.evaluate(() => document.querySelector("#resume-choice").classList.remove("hidden"));
  await expectVisible(page, true);
  await page.evaluate(() => document.querySelector("#resume-choice").classList.add("hidden"));

  await scrollToBottom(page);
  await page.evaluate(() => {
    const banner = document.createElement("div");
    banner.id = "reading-scroll-layout-banner";
    banner.style.height = "90px";
    document.querySelector("#attention-banner-root").append(banner);
  });
  await expectVisible(page, true);
  await page.evaluate(() => document.querySelector("#reading-scroll-layout-banner")?.remove());

  // Native window/viewport resizing is a separate scheduling source.
  await scrollToBottom(page);
  await page.setViewportSize({ width: 1180, height: 680 });
  await expectVisible(page, true);
  await page.setViewportSize({ width: 1180, height: 820 });

  // If a layout/content update hides a focused control, focus is repaired to
  // Composer before display:none is applied.
  await scrollToTop(page);
  await expectVisible(page, true);
  await page.locator("#scroll-to-bottom").focus();
  await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    const small = document.createElement("div");
    small.style.height = "12px";
    small.textContent = "No overflow";
    runList.replaceChildren(small);
  });
  await expectVisible(page, false);
  await expectComposerFocus(page);

  // During a lifecycle transition the textarea can be disabled. The form is a
  // programmatic fallback, so hiding the focused button still preserves a
  // meaningful, visibly indicated Composer focus target.
  await installFixture(page);
  await scrollToTop(page);
  await expectVisible(page, true);
  await page.evaluate(() => {
    document.querySelector("#prompt-input").disabled = true;
  });
  await page.locator("#scroll-to-bottom").focus();
  await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    const small = document.createElement("div");
    small.style.height = "12px";
    runList.replaceChildren(small);
  });
  await expectVisible(page, false);
  await page.waitForTimeout(100);
  const fallbackFocus = await page.evaluate(() => ({
    activeId: document.activeElement?.id,
    composerTabIndex: document.querySelector("#composer").tabIndex,
    promptDisabled: document.querySelector("#prompt-input").disabled,
  }));
  const expectedFallbackId = fallbackFocus.promptDisabled ? "composer" : "prompt-input";
  assert(
    fallbackFocus.activeId === expectedFallbackId,
    `focus follows current Composer availability (${JSON.stringify(fallbackFocus)})`,
  );
  assert(
    await page.evaluate(() => document.activeElement?.matches(":focus-visible")),
    "repaired Composer target has visible focus",
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        evidenceDir,
        checks: {
          noOverflowHidden: true,
          awayFromBottomVisible: true,
          pointerSmooth: true,
          keyboardReducedMotion: true,
          internalAsyncGrowth: true,
          detailsToggle: true,
          imageLoad: true,
          composerGrowth: true,
          resumeChoiceGrowth: true,
          bannerGrowth: true,
          viewportResize: true,
          disappearingFocusRepaired: true,
          composerFocusAvailability: true,
          composerFocusContrast: true,
        },
        composerFocusMatrix,
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
}

async function installFixture(page) {
  await page.evaluate(() => {
    document.querySelector("#run-column").classList.remove("run-column-new-chat");
    const runList = document.querySelector("#run-list");
    const content = document.createElement("div");
    content.id = "reading-scroll-fixture";
    for (let index = 0; index < 18; index += 1) {
      const row = document.createElement("article");
      row.className = "turn-card";
      row.style.minHeight = "120px";
      row.textContent = `Reading fixture turn ${index + 1}`;
      content.append(row);
    }
    runList.replaceChildren(content);
    const originalScrollTo = runList.scrollTo.bind(runList);
    window.__readingScrollCalls = [];
    runList.scrollTo = (optionsOrX, y) => {
      if (typeof optionsOrX === "object") {
        window.__readingScrollCalls.push({ ...optionsOrX });
        return originalScrollTo(optionsOrX);
      } else {
        window.__readingScrollCalls.push({ left: optionsOrX, top: y });
        return originalScrollTo(optionsOrX, y);
      }
    };
  });
}

async function setAppearance(page, theme, mode) {
  await page.evaluate(
    ({ nextTheme, nextMode }) => {
      const root = document.documentElement;
      root.dataset.theme = nextTheme;
      root.dataset.mode = nextMode;
      root.dataset.readingModeSetting = nextMode;
    },
    { nextTheme: theme, nextMode: mode },
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function readComposerFocusContrastMatrix(page) {
  const entries = [];
  for (const theme of ["default", "paper", "calm", "focus"]) {
    for (const mode of ["light", "dark"]) {
      await setAppearance(page, theme, mode);
      // Make keyboard modality explicit before programmatic focus so the
      // production :focus-visible rule, not a forced pseudo-state, wins.
      await page.keyboard.press("Tab");
      await page.locator("#composer").focus();
      const colors = await page.evaluate(() => {
        const composer = document.querySelector("#composer");
        const mainPane = document.querySelector(".main-pane");
        const composerStyle = getComputedStyle(composer);
        return {
          backgroundColor: getComputedStyle(mainPane).backgroundColor,
          outlineColor: composerStyle.outlineColor,
          outlineStyle: composerStyle.outlineStyle,
          outlineWidth: composerStyle.outlineWidth,
          focusVisible: composer.matches(":focus-visible"),
        };
      });
      entries.push({
        theme,
        mode,
        ...colors,
        focusContrast: contrastRatio(colors.outlineColor, colors.backgroundColor),
      });
    }
  }
  await setAppearance(page, "default", "light");
  return entries;
}

async function scrollToTop(page) {
  await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    runList.scrollTop = 0;
    runList.dispatchEvent(new Event("scroll"));
  });
}

async function scrollToBottom(page) {
  await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    runList.scrollTop = runList.scrollHeight;
    runList.dispatchEvent(new Event("scroll"));
  });
  await expectVisible(page, false);
}

async function expectVisible(page, visible) {
  await page.waitForFunction(
    (expected) => {
      const button = document.querySelector("#scroll-to-bottom");
      return (
        button instanceof HTMLButtonElement &&
        !button.classList.contains("hidden") === expected &&
        button.getAttribute("aria-hidden") === String(!expected) &&
        button.tabIndex === (expected ? 0 : -1)
      );
    },
    visible,
  );
}

async function expectScrollCall(page, behavior) {
  await page.waitForFunction(
    (expected) => window.__readingScrollCalls?.at(-1)?.behavior === expected,
    behavior,
  );
}

async function expectComposerFocus(page) {
  await page.waitForFunction(() => document.activeElement?.id === "prompt-input");
}

async function distanceFromBottom(page) {
  const metrics = await scrollMetrics(page);
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

async function scrollMetrics(page) {
  return page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    return {
      scrollTop: runList.scrollTop,
      scrollHeight: runList.scrollHeight,
      clientHeight: runList.clientHeight,
    };
  });
}

async function readControl(page) {
  return page.locator("#scroll-to-bottom").evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const columnRect = document.querySelector("#run-column").getBoundingClientRect();
    const composerRect = document.querySelector("#composer").getBoundingClientRect();
    const icon = button.querySelector("svg");
    return {
      hidden: button.classList.contains("hidden"),
      ariaHidden: button.getAttribute("aria-hidden"),
      tabIndex: button.tabIndex,
      label: button.getAttribute("aria-label"),
      title: button.title,
      iconHidden: icon?.getAttribute("aria-hidden") === "true",
      width: rect.width,
      height: rect.height,
      bottom: rect.bottom,
      centerX: rect.left + rect.width / 2,
      columnCenterX: columnRect.left + columnRect.width / 2,
      composerTop: composerRect.top,
      borderRadius: getComputedStyle(button).borderRadius,
    };
  });
}

function near(actual, expected, tolerance = 1) {
  return Math.abs(actual - expected) <= tolerance;
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(parseCssColor(foreground));
  const backgroundLuminance = relativeLuminance(parseCssColor(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseCssColor(value) {
  const rgb = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    return rgb[1]
      .split(/[\s,\/]+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((component) => Number(component) / 255);
  }
  const srgb = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (srgb) {
    return srgb.slice(1, 4).map(Number);
  }
  throw new Error(`Unsupported computed color: ${value}`);
}

function relativeLuminance(rgb) {
  return rgb
    .map((component) =>
      component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4,
    )
    .reduce((sum, component, index) => sum + component * [0.2126, 0.7152, 0.0722][index], 0);
}

function assert(value, label) {
  if (!value) {
    throw new Error(`Reading scroll assertion failed: ${label}`);
  }
}
