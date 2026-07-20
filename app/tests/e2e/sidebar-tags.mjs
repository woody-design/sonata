import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { clickHoverRevealed } from "./helpers/hover.mjs";
import { createSidebarFixture } from "./helpers/sidebar-fixture.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "../..");
const pageErrors = [];
let fixture = null;
let electronApp = null;

try {
  fixture = createSidebarFixture({
    projectSpecs: [{ slug: "tags", name: "Tags", count: 1 }],
    chatCount: 0,
    archivedChatCount: 0,
  });
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
  const task = fixture.projects[0].sessions[0];
  const row = page.locator(`.sidebar-session[data-task-id="${task.id}"]`);
  await row.waitFor({ state: "visible" });

  await clickHoverRevealed(page, row, row.locator(".sidebar-row-hover-action"));
  const root = page.locator('[data-sidebar-menu-panel-id="root"]');
  await root.waitFor({ state: "visible" });
  const rootLabels = await root.getByRole("menuitem").allTextContents();
  assertBefore(rootLabels, "Tags", "Archive", "Tags appears above Archive");

  await clickAndAssertSameTaskCascadePositioning(page, `#sidebar-tags-trigger-${task.id}`);
  const groups = page.locator("#sidebar-tags-groups");
  await groups.waitFor({ state: "visible" });
  assertEqual(await page.locator("[data-sidebar-menu-panel-id]").count(), 2, "root + groups panels");

  await clickAndAssertSameTaskCascadePositioning(
    page,
    '#sidebar-tags-groups [data-tag-group="type"]',
  );
  const options = page.locator("#sidebar-tag-options-type");
  await options.waitFor({ state: "visible" });
  const research = options.getByRole("menuitemcheckbox", { name: "Research", exact: true });
  await research.waitFor({ state: "visible" });
  assertEqual(await page.locator("[data-sidebar-menu-panel-id]").count(), 3, "two flyout levels open");

  await clickAndAssertSameTaskCascadePositioning(
    page,
    '#sidebar-tag-options-type [data-tag-id="type.research"]',
  );
  await options.waitFor({ state: "visible" });
  assertEqual(await research.getAttribute("aria-checked"), "true", "toggle checks Research");
  assertEqual(await page.locator("[data-sidebar-menu-panel-id]").count(), 3, "toggle keeps cascade open");

  await options.getByRole("menuitem", { name: "Add tag", exact: true }).click();
  let input = options.getByRole("textbox", { name: "New Type tag name" });
  await input.fill("Draft Session Tag");
  await input.evaluate((element) => element.setSelectionRange(2, 7, "forward"));

  // Production IPC emits sessions:updated, which schedules the same sidebar
  // rebuild as any background session activity. Exact caret state is asserted
  // after that rebuild, not after a test-only render hook.
  await page.evaluate(
    ({ taskId }) => window.sonataRuntime.setSessionTags({ taskId, tagIds: ["type.research"] }),
    { taskId: task.id },
  );
  await page.waitForTimeout(450);
  input = options.getByRole("textbox", { name: "New Type tag name" });
  const restored = await input.evaluate((element) => ({
    value: element.value,
    active: document.activeElement === element,
    start: element.selectionStart,
    end: element.selectionEnd,
    direction: element.selectionDirection,
  }));
  assertDeepEqual(
    restored,
    { value: "Draft Session Tag", active: true, start: 2, end: 7, direction: "forward" },
    "background sidebar rebuild preserves input value/focus/exact selection",
  );

  // Composition-confirming Enter is owned by the input method. Only the next
  // non-composing Enter creates and immediately applies the custom tag.
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  assertEqual(
    (await page.evaluate(() => window.sonataRuntime.listTags())).some(
      (definition) => definition.label === "Draft Session Tag",
    ),
    false,
    "IME Enter does not submit",
  );
  await input.dispatchEvent("compositionend");
  await input.press("Enter");
  const custom = options.getByRole("menuitemcheckbox", { name: "Draft Session Tag", exact: true });
  await custom.waitFor({ state: "visible" });
  assertEqual(await custom.getAttribute("aria-checked"), "true", "created tag is immediately applied");

  const removeCustom = options.getByRole("menuitem", { name: "Delete Draft Session Tag" });
  await removeCustom.focus();
  await removeCustom.click();
  await custom.waitFor({ state: "detached" });
  assertEqual(
    (await page.evaluate(() => window.sonataRuntime.listTags())).some(
      (definition) => definition.label === "Draft Session Tag",
    ),
    false,
    "custom delete removes the definition",
  );

  // Editor Escape only exits editing; option Escape closes its level; group
  // Escape closes that level; root Escape closes the cascade and restores the
  // originating session-menu trigger.
  await options.getByRole("menuitem", { name: "Add tag", exact: true }).click();
  input = options.getByRole("textbox", { name: "New Type tag name" });
  await input.fill("Discard me");
  await input.press("Escape");
  await options.waitFor({ state: "visible" });
  assertEqual(await options.getByRole("textbox").count(), 0, "editor Escape returns to options");

  await options.getByRole("menuitem", { name: "Add tag", exact: true }).focus();
  await page.keyboard.press("Escape");
  await options.waitFor({ state: "detached" });
  assertEqual(await groups.count(), 1, "option Escape keeps groups open");
  assertEqual(
    await page.evaluate(() => document.activeElement?.getAttribute("data-tag-group")),
    "type",
    "option Escape restores group-row focus",
  );
  await page.keyboard.press("Escape");
  await groups.waitFor({ state: "detached" });
  assertEqual(await root.count(), 1, "group Escape keeps root open");
  assertEqual(
    await page.evaluate(() => document.activeElement?.textContent?.trim()),
    "Tags›",
    "group Escape restores Tags-row focus",
  );
  await page.keyboard.press("Escape");
  await root.waitFor({ state: "detached" });
  assertEqual(
    await page.evaluate(() => document.activeElement?.getAttribute("data-sidebar-focus-key")),
    `session:${task.id}:menu`,
    "root Escape restores the session-menu trigger",
  );

  // Keyboard-only entry covers the rest of the APG matrix: Right enters,
  // typeahead changes group, Home/End traverse options, Space toggles without
  // closing, and Tab dismisses to an outside destination.
  await row.locator(".sidebar-row-hover-action").click();
  await root.getByRole("menuitem", { name: "Tags", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await groups.waitFor({ state: "visible" });
  assertEqual(
    await page.evaluate(() => document.activeElement?.getAttribute("data-tag-group")),
    "status",
    "Right enters the first group",
  );
  await page.keyboard.press("t");
  assertEqual(
    await page.evaluate(() => document.activeElement?.getAttribute("data-tag-group")),
    "type",
    "typeahead reaches Type",
  );
  await page.keyboard.press("ArrowRight");
  await options.waitFor({ state: "visible" });
  await page.keyboard.press("End");
  assertEqual(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    "Add tag",
    "End reaches Add tag",
  );
  await page.keyboard.press("Home");
  assertEqual(
    await page.evaluate(() => document.activeElement?.getAttribute("data-tag-id")),
    "type.research",
    "Home returns to the first option",
  );
  await page.keyboard.press("Space");
  await options.waitFor({ state: "visible" });
  assertEqual(await research.getAttribute("aria-checked"), "false", "Space toggles off in place");
  await page.keyboard.press("Space");
  assertEqual(await research.getAttribute("aria-checked"), "true", "Space toggles on in place");
  await page.keyboard.press("Tab");
  await root.waitFor({ state: "detached" });

  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath(task.id), "utf8"));
  assertDeepEqual(manifest.task.tags, ["type.research"], "custom delete strips the applied tag");
  assertDeepEqual(pageErrors, [], "renderer page errors");
  console.log(
    "sidebar-tags: same-task positioning + input survival/IME + delete + APG keyboard/Escape pass",
  );
} finally {
  try {
    await electronApp?.close();
  } finally {
    fixture?.cleanup();
  }
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

async function clickAndAssertSameTaskCascadePositioning(page, selector) {
  await page.evaluate((targetSelector) => {
    const trigger = document.querySelector(targetSelector);
    if (!(trigger instanceof HTMLElement)) {
      throw new Error(`same-task positioning trigger missing: ${targetSelector}`);
    }
    trigger.click();
    const panels = Array.from(
      document.querySelectorAll("#sidebar-menu-root [data-sidebar-cascade-panel]"),
    );
    if (panels.length === 0) {
      throw new Error(`same-task positioning produced no cascade panels: ${targetSelector}`);
    }
    for (const panel of panels) {
      if (!(panel instanceof HTMLElement)) continue;
      if (
        panel.style.left === "" ||
        panel.style.top === "" ||
        panel.style.maxHeight === "" ||
        !panel.dataset.cascadeSide
      ) {
        throw new Error(
          `cascade panel ${panel.id} was unpositioned when click returned: ` +
            JSON.stringify({
              left: panel.style.left,
              top: panel.style.top,
              maxHeight: panel.style.maxHeight,
              side: panel.dataset.cascadeSide ?? null,
            }),
        );
      }
    }
  }, selector);
}

function assertBefore(values, first, second, message) {
  const firstIndex = values.findIndex((value) => value.includes(first));
  const secondIndex = values.findIndex((value) => value.includes(second));
  if (firstIndex < 0 || secondIndex < 0 || firstIndex >= secondIndex) {
    throw new Error(`${message}: ${JSON.stringify(values)}`);
  }
}

function assertEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
