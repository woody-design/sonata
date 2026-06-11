// Visual-review screenshots of the sidebar architecture on REAL data.
// Read-only: selects sessions (dormant reads), opens menus and the New Chat
// surface. Sends nothing, archives nothing, deletes nothing.
//
//   node tests/e2e/sidebar-screenshots.mjs [outputDir]
import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const outputDir = path.resolve(
  process.argv[2] ?? "../product-thinking/sidebar-refactor-evidence",
);
fs.mkdirSync(outputDir, { recursive: true });

let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: { ...process.env },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(60000);

  // localStorage is shared with the real app's userData — start clean and
  // restore at the end so screenshot runs never pollute real view prefs.
  await page.evaluate(() => localStorage.removeItem("duet.sidebar.prefs"));

  // 1 — boot state: sidebar + New Chat surface.
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await page.waitForTimeout(1200); // session index + relative times settle
  await shoot(page, "01-new-chat-boot");

  // 2 — dormant session selected (pure read path).
  const firstSession = page.locator(".sidebar-session-button").first();
  if (await firstSession.isVisible().catch(() => false)) {
    await firstSession.click();
    await page.waitForTimeout(1500);
    await shoot(page, "02-dormant-session-reading");

    // 3 — session context menu.
    const row = page.locator(".sidebar-session").first();
    await row.hover();
    await row.locator(".sidebar-row-hover-action").click();
    await page.waitForTimeout(300);
    await shoot(page, "03-session-menu");
    await page.keyboard.press("Escape");
    await page.mouse.click(640, 400);
    await page.waitForTimeout(200);
  }

  // 4 — project header menu (if any project exists).
  const projectHeader = page.locator(".sidebar-project-header").first();
  if (await projectHeader.isVisible().catch(() => false)) {
    await projectHeader.hover();
    await projectHeader.locator(".sidebar-icon-button").first().click();
    await page.waitForTimeout(300);
    await shoot(page, "04-project-menu");
    await page.mouse.click(640, 400);
    await page.waitForTimeout(200);
  }

  // 10 — collapse a project via its header (chevron area).
  const projectLabel = page.locator(".sidebar-project-label").first();
  if (await projectLabel.isVisible().catch(() => false)) {
    await projectLabel.hover();
    await page.waitForTimeout(150);
    await shoot(page, "10a-project-chevron-hover");
    await projectLabel.click();
    await page.waitForTimeout(250);
    await shoot(page, "10b-project-collapsed");
    await projectLabel.click();
    await page.waitForTimeout(200);
  }

  // 5 — back to New Chat via sidebar button.
  await page.locator("#sidebar-new-chat").click();
  await page.waitForTimeout(400);
  await shoot(page, "05-new-chat-preselected");

  // 7 — filter menu with a submenu open.
  const filterButton = page.locator("#sidebar-filter");
  if (await filterButton.isVisible().catch(() => false)) {
    await filterButton.click();
    await page.waitForTimeout(250);
    await page.locator(".sidebar-filter-row", { hasText: "Status" }).click();
    await page.waitForTimeout(250);
    await shoot(page, "07-filter-menu-status");

    // 8 — group by date view (8a: non-default row highlighted in the
    // still-open menu; 8b: the resulting list).
    await page.locator(".sidebar-filter-row", { hasText: "Group by" }).click();
    await page.waitForTimeout(200);
    await page.locator(".sidebar-filter-option", { hasText: "Date" }).click();
    await page.waitForTimeout(300);
    await shoot(page, "08a-filter-menu-nondefault");
    await page.mouse.click(900, 600);
    await page.waitForTimeout(250);
    await shoot(page, "08-group-by-date");

    // 9 — archived filter view (Unarchive path visible).
    await filterButton.click();
    await page.waitForTimeout(200);
    await page.locator(".sidebar-filter-row", { hasText: "Status" }).click();
    await page.waitForTimeout(200);
    await page.locator(".sidebar-filter-option", { hasText: "Archived" }).click();
    await page.waitForTimeout(300);
    await page.mouse.click(900, 600);
    await page.waitForTimeout(250);
    await shoot(page, "09-filter-archived");
  }

  // 6 — collapsed sidebar.
  await page.locator("#sidebar-toggle").click();
  await page.waitForTimeout(300);
  await shoot(page, "06-sidebar-collapsed");
  await page.locator("#sidebar-toggle").click();

  console.log(JSON.stringify({ outputDir, success: true }, null, 2));
} finally {
  if (electronApp) {
    try {
      const page = await electronApp.firstWindow();
      await page.evaluate(() => localStorage.removeItem("duet.sidebar.prefs"));
    } catch {
      // Window already gone; nothing to clean.
    }
    await electronApp.close();
  }
}

async function shoot(page, name) {
  await page.screenshot({ path: path.join(outputDir, `${name}.png`) });
  console.log(`captured ${name}`);
}
