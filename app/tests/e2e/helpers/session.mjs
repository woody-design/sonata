import { approveIfVisible } from "./approval.mjs";

/**
 * Sidebar-era session helpers.
 *
 * Sessions are born from the first composer message (deferred creation) —
 * there is no "create empty task" button anymore. Tests start their session
 * by sending their first real prompt; the DeliveryController queues it
 * through the provider cold start, and the workspace-trust approval (which
 * surfaces during that cold start) is answered here.
 */

/** Send the FIRST prompt of a window — creates the session. */
export async function sendFirstPrompt(page, lines, options = {}) {
  const { approveTrust = true, trustTimeout = 60000 } = options;
  await page.locator("#prompt-input").fill(asText(lines));
  await page.locator("#send-prompt").click();
  if (approveTrust) {
    await approveIfVisible(page, "Workspace trust requested", trustTimeout);
  }
}

/** Send a follow-up prompt into the active (already live) session. */
export async function sendPrompt(page, lines) {
  await page.locator("#prompt-input").fill(asText(lines));
  await page.locator("#send-prompt").click();
}

/** Wait until N turn cards report Completed. */
export async function waitForCompletedTurns(page, count, timeout = 240000) {
  await page
    .locator(".turn-card .turn-outcome", { hasText: "Completed" })
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

/** Switch the New Chat draft provider before the first message. */
export async function chooseDraftProvider(page, provider) {
  const label = provider === "claude" ? "Claude" : "Codex";
  await page.locator(".task-provider-segment button", { hasText: label }).click();
}

function asText(lines) {
  return Array.isArray(lines) ? lines.join("\n") : String(lines);
}
