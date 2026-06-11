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

  // 5 — back to New Chat via sidebar button.
  await page.locator("#sidebar-new-chat").click();
  await page.waitForTimeout(400);
  await shoot(page, "05-new-chat-preselected");

  // 6 — collapsed sidebar.
  await page.locator("#sidebar-toggle").click();
  await page.waitForTimeout(300);
  await shoot(page, "06-sidebar-collapsed");
  await page.locator("#sidebar-toggle").click();

  console.log(JSON.stringify({ outputDir, success: true }, null, 2));
} finally {
  if (electronApp) {
    await electronApp.close();
  }
}

async function shoot(page, name) {
  await page.screenshot({ path: path.join(outputDir, `${name}.png`) });
  console.log(`captured ${name}`);
}
