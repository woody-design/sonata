/**
 * Deterministic :hover engagement for e2e suites.
 *
 * Playwright's hover() resolves once the mouse-move is dispatched, but
 * Chromium applies :hover asynchronously (compositor hit-test + style
 * recalc), and a renderer rebuild that replaces the node under a
 * stationary cursor leaves the fresh node unhovered until the next real
 * pointer move. Under CI load both windows stretch — the documented cause
 * of the sidebar-chrome/-disclosure/-rename hover flakes (2026-07-14):
 * hover-style reads captured the resting state, and clicks on
 * hover-revealed row actions timed out on "element is not visible"
 * because Playwright's actionability retries wait without ever moving
 * the pointer again.
 *
 * hoverSettled makes ":hover is engaged" a checked precondition instead
 * of a race: hover, poll matches(":hover") through the locator (a fresh
 * DOM query each probe, so a node rebuilt under the cursor still
 * counts), re-dispatch the pointer move when it never lands, and — since
 * several hover styles transition (e.g. disclosure ink, color 0.12s) —
 * wait for the target's running CSS transitions to finish so a computed-
 * style read that follows sees the settled hover value, not an
 * interpolated frame.
 */
export async function hoverSettled(page, locator, options = {}) {
  const {
    target = locator,
    position,
    attempts = 5,
    engageMs = 500,
    settleTransitions = true,
  } = options;
  let lastHoverError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      // Nudge off-element so the re-hover below is a real pointer move,
      // forcing a fresh hit-test for a node rebuilt under the cursor.
      await page.mouse.move(0, 0);
    }
    try {
      await locator.hover(position ? { position } : {});
    } catch (error) {
      lastHoverError = error;
      continue;
    }
    const deadline = Date.now() + engageMs;
    while (Date.now() < deadline) {
      const engaged = await target
        .evaluate((element) => element.matches(":hover"))
        .catch(() => false);
      if (engaged) {
        if (settleTransitions) {
          await target
            .evaluate(async (element) => {
              // Force a style recalc so the :hover transitions exist, then
              // await exactly the running ones (finished rejects on cancel).
              void getComputedStyle(element).color;
              await Promise.all(
                element
                  .getAnimations()
                  .filter((animation) => animation instanceof CSSTransition)
                  .map((animation) => animation.finished.catch(() => {})),
              );
            })
            .catch(() => {});
        }
        return;
      }
      await page.waitForTimeout(25);
    }
  }
  throw new Error(
    `:hover never engaged on ${String(target)} after ${attempts} attempts` +
      (lastHoverError ? ` (last hover error: ${lastHoverError.message})` : ""),
  );
}

/**
 * Click a control that is only visible while its anchor is hovered
 * (visibility: hidden row/header actions). Playwright's own click
 * actionability loop cannot recover here: if a re-render swaps the
 * anchor between :hover engagement and the click, the control stays
 * hidden forever because the retries never move the pointer. So retry
 * the WHOLE cycle — re-engage :hover (a real pointer move re-reveals),
 * then attempt the click with a short timeout — a bounded number of
 * times.
 */
export async function clickHoverRevealed(page, anchor, action, options = {}) {
  const { attempts = 3, clickTimeoutMs = 2_000, hover } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await hoverSettled(page, anchor, hover);
    try {
      await action.click({ timeout: clickTimeoutMs });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `hover-revealed click on ${String(action)} never landed after ${attempts} ` +
      `hover+click cycles (last error: ${lastError?.message})`,
  );
}
