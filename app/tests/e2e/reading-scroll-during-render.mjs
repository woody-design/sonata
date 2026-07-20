// Regression fence for the scroll-to-bottom bug that the static-fixture fence
// (reading-scroll-to-bottom.mjs) is structurally blind to: it installs a fixed
// DOM and never renders during the smooth scroll, so it can never see a render
// abort the animation.
//
// The bug: a click starts a smooth `scrollTo(bottom)`, but the next transcript
// render's finalize unconditionally writes `runList.scrollTop`. Per CSSOM, ANY
// programmatic scroll write (even a same-value one) aborts an in-flight smooth
// scroll — so mid-animation, with `nearBottom` false, finalize pins the view
// back to where it was and the animation dies. In daily use the ~160 ms stream
// render cadence supplies that render; here we supply it deterministically by
// toggling the reading popover (a real `render()` that reconciles the live
// transcript in place and leaves the scroller's metrics untouched), so the
// reproduction does not depend on a provider's streaming length or timing.
//
// A real (settled) task is required: only a real task's keyed reconcile
// preserves the transcript across a render — the no-task path wipes the run
// list to the entry panel. RED before the fix (finalize's pin freezes the
// animation near the top), GREEN after (the bottom intent suppresses that write
// and the animation reaches the bottom). See the slice record for the stash run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt, sendPrompt, waitForCompletedTurns } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-scroll-during-render-workspace-"));
const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-scroll-during-render-store-"));

let app;
try {
  app = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot,
      SONATA_WORKSPACES_DIR: workspaceRoot,
      SONATA_SETTINGS_DIR: settingsRoot,
      SONATA_NOTIFICATIONS: "0",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 1180, height: 720 });
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.readingFirstFrame));

  // A settled transcript tall enough that a view frozen near the top is
  // unambiguously far from the bottom. Grow it with follow-ups if one reply
  // is short, so the fence does not hinge on any single reply's length.
  await sendFirstPrompt(page, [
    "Output a numbered list from 1 to 60, each number on its own line.",
    "Plain text only. No commentary, no code fences, no tools. Do not modify files.",
  ]);
  let completed = 1;
  await waitForCompletedTurns(page, completed);
  for (let attempt = 0; attempt < 3 && (await overflow(page)) < 320; attempt += 1) {
    await sendPrompt(page, [
      `Output a numbered list from ${61 + attempt * 60} to ${120 + attempt * 60}, one per line.`,
      "Plain text only. No commentary, no tools. Do not modify files.",
    ]);
    completed += 1;
    await waitForCompletedTurns(page, completed);
  }
  assert((await overflow(page)) > 320, `settled transcript overflows (overflow ${await overflow(page)})`);

  await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    const original = runList.scrollTo.bind(runList);
    window.__scrollDuringRenderCalls = [];
    runList.scrollTo = (optionsOrX, y) => {
      if (typeof optionsOrX === "object") {
        window.__scrollDuringRenderCalls.push({ ...optionsOrX });
        return original(optionsOrX);
      }
      window.__scrollDuringRenderCalls.push({ left: optionsOrX, top: y });
      return original(optionsOrX, y);
    };
  });

  // Break tail-follow: park at the very top so the animation must cross the
  // whole transcript and a finalize pin freezes it far from the bottom.
  await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    runList.scrollTop = 0;
    runList.dispatchEvent(new Event("scroll"));
  });
  const control = page.locator("#scroll-to-bottom");
  await control.waitFor({ state: "visible" });
  const metricsBefore = await scrollMetrics(page);
  const beforeClick = distance(metricsBefore);
  assert(beforeClick > 320, `must start far from the bottom (distance ${beforeClick})`);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await control.click();
  await page.waitForFunction(
    () => window.__scrollDuringRenderCalls?.some((call) => call.behavior === "smooth"),
    undefined,
    { timeout: 5_000 },
  );

  // Fire real renders WHILE the smooth scroll is mid-flight. Each popover toggle
  // is a full render() → renderRuns() → finalize. Pre-fix, the first one pins
  // scrollTop back near the top and kills the animation; the rest keep it
  // pinned. Post-fix, finalize leaves scrollTop alone and the animation lives.
  const readingSettings = page.locator("#reading-settings");
  for (let toggle = 0; toggle < 4; toggle += 1) {
    await readingSettings.click();
  }
  // Confirm the toggles did not reflow the scroller (overlay popover, not a
  // sibling that shrinks the viewport) — otherwise the distance below is moot.
  const metricsAfterRenders = await scrollMetrics(page);
  assert(
    metricsAfterRenders.clientHeight === metricsBefore.clientHeight &&
      metricsAfterRenders.scrollHeight === metricsBefore.scrollHeight,
    `render trigger left the scroller's metrics unchanged (${JSON.stringify({ metricsBefore, metricsAfterRenders })})`,
  );

  // Post-fix the animation reaches the bottom and tail-follow holds it there.
  // Pre-fix it is frozen near the top, so this never resolves and the fence
  // fails (RED).
  await page.waitForFunction(
    () => {
      const runList = document.querySelector("#run-list");
      return runList.scrollHeight - runList.scrollTop - runList.clientHeight <= 64;
    },
    undefined,
    { timeout: 8_000 },
  );

  const finalDistance = distance(await scrollMetrics(page));
  assert(finalDistance <= 64, `scroll-to-bottom survives renders and reaches the bottom (distance ${finalDistance})`);

  // ——— Part 2 — reader takeover clears the ride; growth must not yank them back
  // The complement of Part 1: while the ride is live, a scroll the reader drives
  // that emits no wheel/touch event (keyboard prompt-nav's scrollIntoView, a
  // scrollbar-thumb drag) still aborts the animation. The intent must retire on
  // that retreat — otherwise the next content growth re-aims a smooth
  // scrollTo(bottom) and drags the reader off what they scrolled to. This fires
  // the exact wiring F1 identified. Growth is applied by inflating an existing
  // keyed turn card in place (survives reconcile), so it needs no live stream.
  await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    runList.scrollTop = 220; // a scrolled-up reading position — control visible
    runList.dispatchEvent(new Event("scroll"));
  });
  await control.waitFor({ state: "visible" });
  await control.click(); // ride starts; ridePeak seeded at 220
  await page.waitForFunction(
    () => window.__scrollDuringRenderCalls?.some((call) => call.behavior === "smooth"),
    undefined,
    { timeout: 5_000 },
  );

  // The reader jumps UP the scroller without a wheel/touch event (the net effect
  // of prompt-nav's scrollIntoView / a scrollbar drag): retreat far past the
  // ride peak. syncReadingNavigation must read this as takeover and clear.
  await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    runList.scrollTop = 0;
    runList.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

  // Now grow the transcript at the bottom. A lingering intent (pre-fix) re-aims
  // a smooth scroll to the new bottom; a cleared intent (post-fix) does nothing.
  await page.evaluate(() => {
    const cards = document.querySelectorAll("#run-list .turn-card");
    const last = cards[cards.length - 1];
    last.style.minHeight = `${last.getBoundingClientRect().height + 2400}px`;
    document.querySelector("#run-list").dispatchEvent(new Event("scroll"));
  });

  // Give any (pre-fix) re-aim animation time to run, then assert the reader was
  // NOT dragged to the bottom. Post-fix: intent cleared on the retreat, view
  // stays up (distance ~ the full grown overflow). Pre-fix: re-aimed to the
  // bottom (distance ≤64) → this assertion fails (RED).
  await page.waitForTimeout(700);
  const afterGrowth = await scrollMetrics(page);
  const takeoverDistance = distance(afterGrowth);
  assert(
    takeoverDistance > 500,
    `reader takeover retires the ride; growth does not yank them to the bottom (distance ${takeoverDistance}, scrollTop ${afterGrowth.scrollTop})`,
  );

  console.log(
    JSON.stringify({ success: true, beforeClick, finalDistance, takeoverDistance }, null, 2),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(settingsRoot, { recursive: true, force: true });
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

async function overflow(page) {
  const m = await scrollMetrics(page);
  return m.scrollHeight - m.clientHeight;
}

function distance(m) {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

function assert(value, label) {
  if (!value) {
    throw new Error(`Scroll-during-render assertion failed: ${label}`);
  }
}
