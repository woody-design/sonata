import { approveVisibleBanner } from "./approval.mjs";

/**
 * Sidebar-era session helpers.
 *
 * Sessions are born from the first composer message (deferred creation) —
 * there is no "create empty task" button anymore. Tests start their session
 * by sending their first real prompt; the DeliveryController queues it
 * through the provider cold start, and the workspace-trust approval (which
 * surfaces during that cold start) is answered here.
 */

/** Send the FIRST prompt of a window — creates the session.
 *
 * Returns how the trust moment resolved: `"pre-trusted"` (the prompt
 * dispatched with no trust banner — S4's pre-write world for Claude),
 * `"trust-answered"` (the banner appeared and was approved — Codex, and any
 * pre-write fallback), or `"timeout"`. Waiting is a RACE, not a fixed stall:
 * with trust pre-granted the banner never comes, and a fixed wait would add
 * its full timeout to every suite. */
export async function sendFirstPrompt(page, lines, options = {}) {
  const { approveTrust = true, trustTimeout = 60000 } = options;
  const cardsBefore = await page.locator(".turn-card").count();
  await page.locator("#prompt-input").fill(asText(lines));
  await page.locator("#send-prompt").click();
  if (!approveTrust) {
    return "pre-trusted";
  }
  const banner = page.locator("#approval-banner", { hasText: "Workspace trust requested" });
  const deadline = Date.now() + trustTimeout;
  while (Date.now() < deadline) {
    if (await banner.isVisible().catch(() => false)) {
      await approveVisibleBanner(page, banner);
      return "trust-answered";
    }
    // A turn card can only land once the prompt actually dispatched — which a
    // pending trust panel blocks — so it is proof no trust gate is coming.
    if ((await page.locator(".turn-card").count()) > cardsBefore) {
      return "pre-trusted";
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return "timeout";
}

/** Send a follow-up prompt into the active (already live) session. */
export async function sendPrompt(page, lines) {
  await page.locator("#prompt-input").fill(asText(lines));
  await page.locator("#send-prompt").click();
}

/** Wait until the session is visibly engaged: a run is active (the status
 *  strip is up) or an approval is asking. Replaces the retired
 *  workflow-strip headline wait ("<provider> is working | … approval
 *  needed") with the real S5 surfaces. Both elements always exist in the
 *  DOM with `.hidden` toggled, so "attached without .hidden" is exact. */
export async function waitForEngagement(page, timeout = 240000) {
  await page
    .locator("#status-strip:not(.hidden), #approval-banner:not(.hidden)")
    .first()
    .waitFor({ state: "attached", timeout });
}

/** Acquire a floating window by its URL instead of the next "window" event —
 *  queued events from earlier window activity (terminal toggles, a prior
 *  preview) make waitForEvent grab the wrong page. */
export async function waitForWindowByUrl(electronApp, urlPart, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = electronApp.windows().find((w) => w.url().includes(urlPart));
    if (found) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`No window matching "${urlPart}" appeared within ${timeout}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Wait until N turn cards report Completed. */
export async function waitForCompletedTurns(page, count, timeout = 240000) {
  await page
    .locator('.turn-card[data-run-status="completed"]')
    .nth(count - 1)
    .waitFor({ state: "visible", timeout });
}

/** The active session's task id, read from the sidebar selection. */
export async function activeSessionTaskId(page) {
  const row = page.locator(".sidebar-session.active").first();
  await row.waitFor({ state: "visible" });
  return row.getAttribute("data-task-id");
}

/** Click a session row in the sidebar by task id. */
export async function selectSidebarSession(page, taskId) {
  await page.locator(`.sidebar-session[data-task-id="${taskId}"] .sidebar-session-button`).click();
}

/** Open the New Chat surface via the sidebar button. */
export async function openNewChat(page) {
  await page.locator("#sidebar-new-chat").click();
}

/** Switch the New Chat draft provider before the first message (2026-07-04
 *  redesign: the provider is a composer chip whose menu portals above it). */
export async function chooseDraftProvider(page, provider) {
  await page.locator("#provider-chip").click();
  await page.locator(`#provider-option-${provider}`).click();
}

/** Pick the New Chat working folder through the project chip's menu. The
 *  "Use an existing folder" item opens the native dialog (DUET_TEST_PICK_FOLDER
 *  answers it in tests). */
export async function chooseDraftFolderViaDialog(page) {
  await page.locator("#project-chip").click();
  await page.locator("#entry-choose-folder").click();
}

function asText(lines) {
  return Array.isArray(lines) ? lines.join("\n") : String(lines);
}
