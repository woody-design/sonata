import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { createSidebarFixture } from "./helpers/sidebar-fixture.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "../..");
const pageErrors = [];
let fixture = null;
let electronApp = null;

try {
  fixture = createSidebarFixture({
    projectSpecs: [{ slug: "tag-filter", name: "Tag Filter", count: 3 }],
    chatCount: 0,
    archivedChatCount: 0,
  });
  const [todoResearch, doneResearch, todoCoding] = fixture.projects[0].sessions;
  setManifestTags(fixture.manifestPath(todoResearch.id), ["status.todo", "type.research"]);
  setManifestTags(fixture.manifestPath(doneResearch.id), ["status.done", "type.research"]);
  setManifestTags(fixture.manifestPath(todoCoding.id), ["status.todo", "type.coding"]);

  electronApp = await electron.launch({
    args: [
      path.join(appRoot, "dist", "main", "main.js"),
      `--user-data-dir=${fixture.userDataDir}`,
    ],
    env: isolatedElectronEnv(fixture.env),
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.setViewportSize({ width: 1100, height: 760 });
  await expectVisibleSessionCount(page, 3);
  await page.evaluate(() =>
    window.sonataRuntime.createTag({ label: "Custom filter", group: "type" }),
  );

  const menu = await openTagsFilter(page);
  await menu.getByRole("menuitemcheckbox", { name: "Custom filter", exact: true }).waitFor({
    state: "visible",
  });
  assertEqual(
    await menu.locator('[data-sidebar-focus-key="menu:filter:status"] .sidebar-filter-label').textContent(),
    "Show",
    "lifecycle section display label is Show",
  );
  assertDeepEqual(
    await menu.locator(".sidebar-tag-filter-heading").allTextContents(),
    ["Status", "Type", "Priority"],
    "Tags is one section with three non-interactive subgroup headers",
  );
  assertEqual(
    await menu.getByRole("menuitemcheckbox").count(),
    17,
    "full builtin and custom tag dictionary is listed",
  );

  await tagFilterOption(menu, "status.todo", "Todo").click();
  await expectVisibleSessionCount(page, 2);
  assertEqual(await menu.count(), 1, "tag toggle keeps the filter menu open");
  assertEqual(
    await tagFilterOption(menu, "status.todo", "Todo").getAttribute("aria-checked"),
    "true",
    "Todo filter is checked",
  );

  await tagFilterOption(menu, "type.research", "Research").click();
  await expectVisibleSessionTitles(page, [todoResearch.title]);
  assertEqual(await menu.count(), 1, "cross-group toggle keeps the filter menu open");
  assertEqual(
    await page.locator("#sidebar-filter").evaluate((element) => element.classList.contains("active")),
    true,
    "tag filters activate the filter button's non-default indicator",
  );
  assertEqual(
    await page.locator("#sidebar-filter").evaluate((element) => element.classList.contains("filtering")),
    true,
    "tag filters activate the filter button's accent hiding-sessions indicator",
  );
  assertDeepEqual(
    await storedTagPrefs(page),
    ["status.todo", "type.research"],
    "selected tag filters persist to the existing sidebar prefs key",
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await expectVisibleSessionTitles(page, [todoResearch.title]);
  assertDeepEqual(
    await storedTagPrefs(page),
    ["status.todo", "type.research"],
    "tag filter prefs survive renderer reload",
  );

  const reloadedMenu = await openTagsFilter(page);
  assertEqual(
    await tagFilterOption(reloadedMenu, "status.todo", "Todo").getAttribute("aria-checked"),
    "true",
    "Todo remains checked after reload",
  );
  assertEqual(
    await tagFilterOption(reloadedMenu, "type.research", "Research").getAttribute("aria-checked"),
    "true",
    "Research remains checked after reload",
  );

  const clear = reloadedMenu.getByRole("menuitem", { name: "Clear filters", exact: true });
  await clear.click();
  await expectVisibleSessionCount(page, 3);
  assertDeepEqual(await storedTagPrefs(page), [], "Clear filters resets persisted tag selections");
  assertEqual(
    await page.locator("#sidebar-filter").evaluate((element) => element.classList.contains("active")),
    false,
    "Clear filters removes the filter button's non-default indicator",
  );
  assertEqual(
    await page.locator("#sidebar-filter").evaluate((element) => element.classList.contains("filtering")),
    false,
    "Clear filters removes the filter button's accent hiding-sessions indicator",
  );
  await reloadedMenu.waitFor({ state: "detached" });
  assertDeepEqual(pageErrors, [], "renderer page errors");

  console.log("sidebar-tag-filter: select -> filter -> reload -> clear round-trip passes");
} finally {
  try {
    await electronApp?.close();
  } finally {
    fixture?.cleanup();
  }
}

async function openTagsFilter(page) {
  const menu = page.locator("#sidebar-menu-root .sidebar-filter-menu");
  if ((await menu.count()) === 0) {
    await page.locator("#sidebar-filter").click();
  }
  await menu.waitFor({ state: "visible" });
  const tagsRow = menu.locator('[data-sidebar-focus-key="menu:filter:tags"]');
  if (!(await tagsRow.evaluate((element) => element.classList.contains("open")))) {
    await tagsRow.click();
  }
  await menu.locator(".sidebar-tag-filter-heading").first().waitFor({ state: "visible" });
  return menu;
}

function tagFilterOption(menu, id, label) {
  return menu.getByRole("menuitemcheckbox", { name: label, exact: true }).and(
    menu.locator(`[data-tag-id="${id}"]`),
  );
}

async function expectVisibleSessionCount(page, count) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".sidebar-session").length === expected,
    count,
  );
}

async function expectVisibleSessionTitles(page, expected) {
  await page.waitForFunction(
    (titles) => {
      const visible = Array.from(document.querySelectorAll(".sidebar-session-title"), (element) =>
        element.textContent?.trim(),
      );
      return JSON.stringify(visible) === JSON.stringify(titles);
    },
    expected,
  );
}

async function storedTagPrefs(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("sonata.sidebar.prefs");
    return raw ? JSON.parse(raw).tags : null;
  });
}

function setManifestTags(manifestPath, tags) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.task.tags = tags;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function isolatedElectronEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SONATA_")) delete env[key];
  }
  return {
    ...env,
    ...overrides,
    SONATA_DISABLE_TERMINAL_WINDOW: "1",
    SONATA_DISABLE_AUTO_UPDATE: "1",
    SONATA_DISABLE_NOTIFICATIONS: "1",
  };
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
