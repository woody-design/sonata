// Slice 5 production fence: visibility follows the real Reading scroller,
// internal and sibling layout changes are observed, and activation respects
// motion preferences while preserving keyboard focus.
//
// REPAIRED 2026-08-06 (S3 review 1). It had been RED on `main` for some time,
// and not for anything it was testing: it installed its own DOM into #run-list
// with `replaceChildren` and assumed no Reading render would land between the
// install and the assertions. Any render at all takes the no-task path
// (setNonRailChildren → the entry panel) and re-adds `.run-column-new-chat`, so
// the fixture was wiped and the scroller collapsed to 20px — measured
// identically on the slice build and on a clean checkout of the commit before
// it: `{"scrollHeight":20,"clientHeight":20,"fixturePresent":false}`. It was the
// only fence in the reading-scroll family testing against a synthetic DOM
// instead of a real session, which is exactly why it was the one that broke.
//
// It now drives a REAL codex session (helpers/fake-codex-source.mjs writes a
// rollout + SessionStart handshake; this fence appends real `agent_message`
// records that Sonata tails and renders), the same harness shape as
// reading-scroll-during-render.mjs, reading-reply-anchor.mjs and
// reading-session-scroll-memory.mjs. Nothing a render does can take the
// transcript away, because the transcript is the product's own.
//
// EVERY assertion the old fence made is still made. Where the mechanism had to
// change, the old one is named beside the new one:
//   noOverflowHidden          — unchanged (the entry panel at boot, no fixture)
//   awayFromBottomVisible     — unchanged, now against a real transcript
//   control geometry/labels   — unchanged
//   composerFocusContrast     — unchanged (independent of the scroller)
//   pointerSmooth             — unchanged
//   keyboardReducedMotion     — unchanged
//   internalAsyncGrowth  ) growth probes now live INSIDE a keyed turn card,
//   detailsToggle        ) which the reconcile reuses rather than rebuilds, so
//   imageLoad            ) a render cannot take them away (the technique
//                        ) reading-scroll-during-render.mjs already uses)
//   composerGrowth / resumeChoiceGrowth / bannerGrowth / viewportResize
//                             — unchanged (all outside the scroller)
//   disappearingFocusRepaired ) content is collapsed by an injected CSS rule
//   composerFocusAvailability ) instead of `runList.replaceChildren`: it hides
//                             ) the same content from the same observers, and
//                             ) survives any render, being CSS and not DOM
//   rideOutranksAnchorHold    — NEW (S3 review 1): the ride against the new
//                               finalize precedence. A landed reply anchor
//                               establishes a reading hold that outranks both
//                               live-edge pins; the reader asking for the live
//                               edge must still win, and does, because the hold
//                               is a position and the ride moves the view off
//                               it. (Takeover/displacement mid-ride is
//                               reading-scroll-during-render.mjs's part 2 and is
//                               not duplicated here.)
//
// Fixture provenance:
//   · the rollout records: ADAPTED from tests/e2e/compaction-marker.mjs (same
//     fake rollout, same append); shapes pinned by codex-normalizer.ts.
//   · the reply bodies: COMPOSED — numbered lines, sized only to give the
//     scroller a known overflow. No provider output is being imitated.
//   · the growth probes (a late div, a <details>, a decoded image) and the
//     theme/contrast matrix: MEASURED originals, carried over verbatim from the
//     fence this replaces.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { FAKE_CODEX_SOURCE } from "./helpers/fake-codex-source.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-reading-scroll-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-reading-scroll-home-"));
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-reading-scroll-bin-"));
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-reading-scroll-folder-"));
const evidenceDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true });
}
fs.writeFileSync(path.join(fakeBinDir, "codex"), FAKE_CODEX_SOURCE, { mode: 0o755 });
fs.chmodSync(path.join(fakeBinDir, "codex"), 0o755);

let app;
try {
  app = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      // Records land under $SONATA_DATA_DIR/data/projects/<taskId> — recordDir
      // below reads from exactly there.
      SONATA_DATA_DIR: root,
      SONATA_WORKSPACES_DIR: root,
      SONATA_SETTINGS_DIR: path.join(root, "settings"),
      CODEX_HOME: codexHome,
      SONATA_NOTIFICATIONS: "0",
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.readingFirstFrame));
  await setAppearance(page, "default", "light");

  // Boot state, before any session exists: nothing to scroll, so the control is
  // hidden and out of the accessibility tree.
  const initial = await readControl(page);
  assert(initial.hidden && initial.ariaHidden === "true" && initial.tabIndex === -1, "no overflow hides control");
  assert(initial.iconHidden, "decorative arrow is hidden from accessibility tree");

  // A real session with a transcript tall enough to scroll. Grown BEFORE it is
  // displayed, so opening it is a plain first open with nothing to anchor.
  page.setDefaultTimeout(60_000);
  const created = await page.evaluate(
    async (cwd) => window.sonataRuntime.createTask({ provider: "codex", cwd }),
    folder,
  );
  const taskId = created.task.id;
  const row = page.locator(`.sidebar-session[data-task-id="${taskId}"]`);
  await row.waitFor({ state: "visible" });
  let rolloutPath = null;
  await waitFor(() => {
    rolloutPath = readSources(taskId)[0]?.path ?? null;
    return Boolean(rolloutPath) && fs.existsSync(rolloutPath);
  }, "codex handshake (transcript source + rollout on disk)");
  appendReply(rolloutPath, 1, 60);
  appendReply(rolloutPath, 2, 60);
  await row.click();
  await page.waitForFunction(
    () => document.querySelectorAll("#run-list .turn-answer > [data-block-key]").length >= 2,
  );
  page.setDefaultTimeout(20_000);
  await instrumentScrollCalls(page);
  assert((await overflow(page)) > 800, `the transcript overflows its viewport (${await overflow(page)})`);

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
  await scrollToTop(page);
  await expectVisible(page, true);
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
  // The probe lives inside a keyed turn card, which the reconcile REUSES — a
  // render can no longer take it away.
  await scrollToBottom(page);
  const growth = await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    const before = {
      clientHeight: runList.clientHeight,
      scrollHeight: runList.scrollHeight,
    };
    const late = document.createElement("div");
    late.id = "reading-scroll-late-content";
    late.style.height = "180px";
    late.textContent = "Asynchronous content growth";
    document.querySelector("#run-list .turn-card:last-of-type").append(late);
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
    document.querySelector("#run-list .turn-card:last-of-type").append(details);
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
    document.querySelector("#run-list .turn-card:last-of-type").append(image);
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
  // Composer before display:none is applied. The content is collapsed with a
  // CSS rule rather than by emptying #run-list: it hides the same content from
  // the same observers, and being CSS it cannot be undone by a render.
  await scrollToTop(page);
  await expectVisible(page, true);
  await page.locator("#scroll-to-bottom").focus();
  await collapseTranscript(page, true);
  await expectVisible(page, false);
  await expectComposerFocus(page);
  await collapseTranscript(page, false);

  // During a lifecycle transition the textarea can be disabled. The form is a
  // programmatic fallback, so hiding the focused button still preserves a
  // meaningful, visibly indicated Composer focus target.
  await scrollToTop(page);
  await expectVisible(page, true);
  await page.evaluate(() => {
    document.querySelector("#prompt-input").disabled = true;
  });
  await page.locator("#scroll-to-bottom").focus();
  await collapseTranscript(page, true);
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
  await collapseTranscript(page, false);
  await page.evaluate(() => {
    document.querySelector("#prompt-input").disabled = false;
  });

  // ——— The ride against the new finalize precedence (S3 review 1).
  // A new reply segment anchors its top edge at the reading line and that
  // LANDED position becomes a hold which outranks both live-edge pins. The
  // reader asking for the live edge must still win: the hold is a position, not
  // a latch, so the ride moving the view off it retires it.
  await scrollToBottom(page);
  page.setDefaultTimeout(60_000);
  appendReply(rolloutPath, 3, 60);
  await page.waitForFunction(
    () => document.querySelectorAll("#run-list .turn-answer > [data-block-key]").length >= 3,
  );
  await page.waitForTimeout(400);
  page.setDefaultTimeout(20_000);
  const anchored = await page.evaluate(() => {
    const list = document.querySelector("#run-list");
    const segments = list.querySelectorAll(".turn-answer > [data-block-key]");
    const node = segments[segments.length - 1];
    return {
      topInViewport: node.getBoundingClientRect().top - list.getBoundingClientRect().top,
      distanceFromBottom: Math.max(0, list.scrollHeight - list.scrollTop - list.clientHeight),
    };
  });
  assert(
    Math.abs(anchored.topInViewport - 40) <= 2 && anchored.distanceFromBottom > 64,
    `a landed anchor holds the view off the live edge (${JSON.stringify(anchored)})`,
  );
  await expectVisible(page, true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("#scroll-to-bottom").click();
  await expectScrollCall(page, "smooth");
  await page.waitForFunction(() => {
    const list = document.querySelector("#run-list");
    return list.scrollHeight - list.scrollTop - list.clientHeight <= 64;
  }, undefined, { timeout: 8_000 });
  await expectComposerFocus(page);
  await expectVisible(page, false);
  const afterRide = await distanceFromBottom(page);
  assert(afterRide <= 64, `the reader's ride outranks the anchor hold (distance ${afterRide})`);

  console.log(
    JSON.stringify(
      {
        success: true,
        evidenceDir,
        taskId,
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
          rideOutranksAnchorHold: true,
        },
        anchored,
        afterRide,
        composerFocusMatrix,
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close();
  for (const dir of [root, codexHome, fakeBinDir, folder]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function appendReply(rolloutPath, index, lines) {
  const body = [`## Reply ${index}`];
  for (let line = 1; line <= lines; line += 1) {
    body.push(`reply ${index} line ${line}`);
  }
  fs.appendFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "agent_message", message: body.join("\n\n"), phase: "final_answer" },
    })}\n`,
  );
}

function recordDir(taskId) {
  return path.join(root, "data", "projects", taskId);
}

function readSources(taskId) {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(recordDir(taskId), "transcript-sources.json"), "utf8"))
        ?.sources ?? []
    );
  } catch {
    return [];
  }
}

async function waitFor(predicate, label, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/** Record every programmatic scrollTo on the reading scroller, so activation's
 *  motion behavior is read from the call the surface actually made. */
async function instrumentScrollCalls(page) {
  await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    const originalScrollTo = runList.scrollTo.bind(runList);
    window.__readingScrollCalls = [];
    runList.scrollTo = (optionsOrX, y) => {
      if (typeof optionsOrX === "object") {
        window.__readingScrollCalls.push({ ...optionsOrX });
        return originalScrollTo(optionsOrX);
      }
      window.__readingScrollCalls.push({ left: optionsOrX, top: y });
      return originalScrollTo(optionsOrX, y);
    };
  });
}

/** Hide/show the whole transcript with a stylesheet rule — the same content
 *  change the old fence made by emptying #run-list, except that a Reading
 *  render cannot undo it. */
async function collapseTranscript(page, collapsed) {
  await page.evaluate((hide) => {
    const id = "reading-scroll-collapse";
    document.getElementById(id)?.remove();
    if (hide) {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = "#run-list .turn-card { display: none; }";
      document.head.append(style);
    }
  }, collapsed);
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

async function overflow(page) {
  const metrics = await scrollMetrics(page);
  return metrics.scrollHeight - metrics.clientHeight;
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
