// Slice 1 acceptance fence: Sidebar chrome is mode-aware but reading-theme
// and reading-size invariant, while the Main Pane preserves every property in
// its recorded Slice 0 baseline inventory. A fake provider and real runtime
// events exercise production status nodes; visual evidence is staged and
// published only after every assertion succeeds.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { FAKE_CODEX_SOURCE } from "./helpers/fake-codex-source.mjs";
import { createSidebarFixture } from "./helpers/sidebar-fixture.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const appRoot = path.join(repoRoot, "app");
const beforeManifest = JSON.parse(
  fs.readFileSync(
    path.join(
      repoRoot,
      "product-thinking",
      "sidebar-refactor-evidence",
      "slice-0-before",
      "manifest.json",
    ),
    "utf8",
  ),
);
const outputDir = path.resolve(
  process.argv[2] ??
    path.join(repoRoot, "product-thinking", "sidebar-refactor-evidence", "slice-1-visual"),
);
const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-sidebar-chrome-evidence-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "duet-sidebar-chrome-codex-home-"));
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-sidebar-chrome-bin-"));
const fakeCodex = path.join(fakeBinDir, "codex");
fs.writeFileSync(fakeCodex, FAKE_CODEX_SOURCE, { mode: 0o755 });
fs.chmodSync(fakeCodex, 0o755);
const themes = ["duet", "paper", "calm", "focus"];
const modes = ["light", "dark"];
const textSteps = [14, 20];
const viewport = { width: 1280, height: 800 };
const results = [];
const pageErrors = [];
let fixture = null;
let electronApp = null;

const expectedByMode = {
  light: {
    surface: "rgb(249, 248, 247)",
    ink: "rgb(52, 53, 54)",
    muted: "rgb(107, 109, 108)",
    selected: "rgb(241, 240, 239)",
    hover: "rgb(244, 243, 242)",
    border: "rgb(229, 227, 224)",
    input: "rgb(255, 255, 255)",
    menu: "rgb(255, 255, 255)",
    accent: "rgb(53, 95, 84)",
    focus: "rgb(79, 119, 109)",
    attention: "rgb(160, 75, 60)",
    done: "rgb(82, 118, 109)",
    danger: "rgb(141, 63, 50)",
    disabled: "rgb(137, 139, 138)",
    controlHover: "rgb(236, 235, 234)",
    menuHover: "rgb(244, 243, 242)",
  },
  dark: {
    surface: "rgb(32, 32, 32)",
    ink: "rgb(232, 232, 232)",
    muted: "rgb(164, 166, 165)",
    selected: "rgb(44, 44, 44)",
    hover: "rgb(40, 40, 40)",
    border: "rgb(56, 56, 56)",
    input: "rgb(24, 24, 24)",
    menu: "rgb(41, 41, 41)",
    accent: "rgb(154, 200, 188)",
    focus: "rgb(154, 200, 188)",
    attention: "rgb(224, 160, 142)",
    done: "rgb(168, 209, 198)",
    danger: "rgb(240, 160, 141)",
    disabled: "rgb(119, 121, 120)",
    controlHover: "rgb(53, 53, 53)",
    menuHover: "rgb(52, 52, 52)",
  },
};

try {
  fixture = createSidebarFixture();
  electronApp = await electron.launch({
    args: [
      path.join(appRoot, "dist", "main", "main.js"),
      `--user-data-dir=${fixture.userDataDir}`,
    ],
    env: isolatedElectronEnv({
      ...fixture.env,
      CODEX_HOME: codexHome,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    }),
  });
  const page = await electronApp.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  page.setDefaultTimeout(60_000);
  await page.setViewportSize(viewport);
  await installFixedClock(page, fixture.fixedNowMs);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await page.locator(".sidebar-session").first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Sidebar work must not perturb any Main Pane reading-theme style captured
  // before Slice 1. This pass runs before selecting a session so the same
  // `.task-entry-panel` baseline element is present.
  for (const theme of themes) {
    for (const mode of modes) {
      await setReadingSettingsViaUi(page, { theme, mode, textStep: 16 });
      const actualMain = await computedProperties(page, ".task-entry-panel", [
        "backgroundColor",
        "color",
        "fontFamily",
      ]);
      const before = beforeManifest.visualBaselines.find(
        (entry) => entry.theme === theme && entry.mode === mode,
      );
      assertDeepEqual(actualMain, before?.styles?.mainPane, `${theme}/${mode} Main Pane baseline`);
    }
  }

  // Start a harmless fake Codex through the real main-process controller. The
  // resulting Sidebar row, spinner SVG, role, title, and aria-label all come
  // from production code; the test never manufactures a status node.
  const liveTask = await page.evaluate(
    async (cwd) => window.duetRuntime.createTask({ provider: "codex", cwd }),
    fixture.projects[0].path,
  );
  const liveTaskId = liveTask.task.id;
  const liveRow = page.locator(`.sidebar-session[data-task-id="${liveTaskId}"]`);
  await revealSessionInProject(page, fixture.projects[0].name, liveRow);
  await liveRow.locator(".sidebar-session-button").click();
  await liveRow.locator(".sidebar-session-spinner").waitFor({ state: "attached" });
  await sendCliState(electronApp, liveTaskId, "busy");
  await liveRow.locator(".sidebar-session-spinner").waitFor({ state: "attached" });

  for (const theme of themes) {
    for (const mode of modes) {
      for (const textStep of textSteps) {
        const label = `${theme}/${mode}/${textStep}`;
        await setReadingSettingsViaUi(page, { theme, mode, textStep });
        await scrollSessionRowIntoView(page, liveTaskId);
        const snapshot = await collectChromeSnapshot(page, liveTaskId);
        assertChromeSnapshot(snapshot, expectedByMode[mode], label);
        const liveness = await assertProductionSpinnerLiveness(
          page,
          electronApp,
          liveTaskId,
          expectedByMode[mode],
          label,
        );
        results.push({ theme, mode, textStep, snapshot, liveness });
        await scrollSessionRowIntoView(page, liveTaskId);
        await settleFrames(page);
        await page.locator(".sidebar").screenshot({
          path: path.join(stagingDir, `${theme}-${mode}-${textStep}-sidebar.png`),
          animations: "disabled",
        });
      }
    }
  }
  assertThemeInvariantScreenshots();

  const attentionEvidence = await assertProductionAttentionMatrix(
    page,
    electronApp,
    liveTaskId,
  );

  await setReadingSettingsViaUi(page, { theme: "duet", mode: "dark", textStep: 14 });
  await sendCliState(electronApp, liveTaskId, "busy");
  await liveRow.locator(".sidebar-session-spinner").waitFor({ state: "attached" });

  await page.emulateMedia({ reducedMotion: "reduce" });
  assertEqual(
    await liveRow.locator(".sidebar-session-spinner svg").evaluate(
      (element) => getComputedStyle(element).animationName,
    ),
    "none",
    "reduced-motion spinner animation",
  );
  assertEqual(
    await page.locator(".sidebar-project-chevron").first().evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    ),
    "0s",
    "reduced-motion chevron transition",
  );
  assertEqual(
    await liveRow.locator(".sidebar-session-spinner").getAttribute("aria-label"),
    "Working",
    "reduced-motion working cue remains accessible",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  assertEqual(
    await liveRow.locator(".sidebar-session-spinner svg").evaluate(
      (element) => getComputedStyle(element).animationName,
    ),
    "sidebar-spin",
    "default spinner animation",
  );

  const doneEvidence = await assertProductionDoneMatrix(
    page,
    fixture,
    liveTaskId,
  );

  assertDeepEqual(pageErrors, [], "renderer page errors");
  const manifest = publishEvidence({
    metadata: {
      schemaVersion: 1,
      slice: "1-visual-chrome",
      command: "npm run e2e:sidebar-chrome",
      generatorCommand: "node tests/e2e/sidebar-chrome.mjs",
      sourceRevision: readGitHead(repoRoot),
      sourceFiles: fingerprintSourceFiles(repoRoot, [
        "app/src/renderer/styles.css",
        "app/src/renderer/view/sidebar.ts",
        "app/tests/e2e/helpers/fake-codex-source.mjs",
        "app/tests/e2e/sidebar-chrome.mjs",
      ]),
      fixtureClock: fixture.fixedNowIso,
      viewport,
      results,
      statusEvidence: {
        attention: attentionEvidence,
        done: doneEvidence,
        reducedMotion: true,
      },
      relatedVerification: ["npm run e2e:terminal-theme-independence"],
    },
  });
  console.log(
    JSON.stringify(
      {
        outputDir,
        combinations: results.length,
        evidenceFiles: manifest.files.length,
        success: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    if (electronApp) {
      await electronApp.close();
    }
  } catch (error) {
    console.error("Failed to close Sidebar chrome Electron app:", error);
    process.exitCode = 1;
  } finally {
    fixture?.cleanup();
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
}

async function collectChromeSnapshot(page, liveTaskId) {
  const liveRow = page.locator(`.sidebar-session[data-task-id="${liveTaskId}"]`);
  const inactiveRow = page.locator(".sidebar-session:not(.active)").first();
  await inactiveRow.hover();
  const rowHover = await inactiveRow.evaluate((element) => getComputedStyle(element).backgroundColor);

  await openFirstSessionMenu(page);
  const menu = await computedProperties(page, "#sidebar-menu-root .sidebar-menu", [
    "backgroundColor",
    "borderColor",
    "color",
    "fontFamily",
  ]);
  const danger = await page.locator(".sidebar-menu-item.danger").evaluate(
    (element) => getComputedStyle(element).color,
  );
  const firstMenuItem = page.locator(".sidebar-menu-item").first();
  await firstMenuItem.hover();
  const menuItemHover = await firstMenuItem.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await firstMenuItem.focus();
  await page.keyboard.press("Tab");
  const keyboardFocusedMenuItem = page.locator("#sidebar-menu-root .sidebar-menu-item:focus");
  const menuFocus = await keyboardFocusedMenuItem.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth };
  });
  await firstMenuItem.click();
  const input = page.locator(".sidebar-rename-input").first();
  await input.waitFor({ state: "visible" });
  await input.focus();
  const renameInput = await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
    };
  });
  await page.keyboard.press("Escape");
  await input.waitFor({ state: "detached" });

  const filterButton = page.locator("#sidebar-filter");
  await focusViaKeyboard(page, filterButton);
  const filterFocus = await focusRing(filterButton);
  await filterButton.hover();
  const filterHover = await filterButton.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await filterButton.click();
  await page.locator(".sidebar-filter-row", { hasText: "Group by" }).click();
  const filterCheck = await page.locator(".sidebar-filter-check").evaluate(
    (element) => getComputedStyle(element).color,
  );
  const disabledMenuItem = page.locator(".sidebar-menu-item:disabled");
  const disabled = await disabledMenuItem.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, opacity: style.opacity };
  });
  await closeSidebarMenu(page);

  const newChat = page.locator("#sidebar-new-chat");
  await newChat.hover();
  const newChatHover = await newChat.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await focusViaKeyboard(page, newChat);
  const newChatFocus = await focusRing(newChat);

  const selectedButton = liveRow.locator(".sidebar-session-button");
  await focusViaKeyboard(page, selectedButton);
  const selectedFocus = await focusRing(selectedButton);
  await page.keyboard.press("Tab");
  const sessionAction = liveRow.locator(".sidebar-row-hover-action");
  const sessionActionVisibility = await page
    .locator(`.sidebar-session[data-task-id="${liveTaskId}"] .sidebar-row-hover-action`)
    .evaluate((element) => getComputedStyle(element).visibility);
  const sessionActionTabTarget = await sessionAction.evaluate(
    (element) => document.activeElement === element,
  );
  const projectLabel = page.locator(".sidebar-project-label").first();
  await focusViaKeyboard(page, projectLabel);
  await page.keyboard.press("Tab");
  const projectAction = page.locator(".sidebar-project-header .sidebar-icon-button").first();
  const projectActionVisibility = await page
    .locator(".sidebar-project-header .sidebar-row-actions")
    .first()
    .evaluate((element) => getComputedStyle(element).visibility);
  const projectActionTabTarget = await projectAction.evaluate(
    (element) => document.activeElement === element,
  );

  const collapseButton = page.locator("#sidebar-collapse");
  await collapseButton.hover();
  const collapseHover = await collapseButton.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await focusViaKeyboard(page, collapseButton);
  const collapseFocus = await focusRing(collapseButton);
  await collapseButton.click();
  await page.locator("body.sidebar-collapsed").waitFor({ state: "attached" });
  const toggleButton = page.locator("#sidebar-toggle");
  await page.mouse.move(1100, 700);
  const toggleColor = await toggleButton.evaluate((element) => getComputedStyle(element).color);
  await toggleButton.hover();
  const toggleHover = await toggleButton.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await focusViaKeyboard(page, toggleButton);
  const toggleFocus = await focusRing(toggleButton);
  await toggleButton.click();
  await page.locator("body:not(.sidebar-collapsed)").waitFor({ state: "attached" });
  await liveRow.waitFor({ state: "attached" });

  await page.locator("#sidebar-resizer").hover({ position: { x: 4, y: 200 } });
  const resizerBackground = await page.locator("#sidebar-resizer").evaluate(
    (element) => getComputedStyle(element).backgroundImage,
  );

  const snapshot = await page.evaluate((taskId) => {
    const style = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Missing Sidebar chrome element: ${selector}`);
      }
      return getComputedStyle(element);
    };
    const sidebar = style(".sidebar");
    const rowSelector = `.sidebar-session[data-task-id="${CSS.escape(taskId)}"]`;
    const selected = style(rowSelector);
    const selectedButtonStyle = style(`${rowSelector} .sidebar-session-button`);
    const selectedTitle = style(`${rowSelector} .sidebar-session-title`);
    const sectionLabel = style(".sidebar-section-label");
    const collapse = style("#sidebar-collapse");
    const spinner = style(`${rowSelector} .sidebar-session-spinner`);
    return {
      sidebar: {
        backgroundColor: sidebar.backgroundColor,
        borderRightColor: sidebar.borderRightColor,
        color: sidebar.color,
        fontFamily: sidebar.fontFamily,
        fontSize: sidebar.fontSize,
      },
      selected: {
        backgroundColor: selected.backgroundColor,
        buttonColor: selectedButtonStyle.color,
        titleWeight: selectedTitle.fontWeight,
        ariaCurrent: document
          .querySelector(`${rowSelector} .sidebar-session-button`)
          ?.getAttribute("aria-current"),
      },
      sectionLabelColor: sectionLabel.color,
      collapseColor: collapse.color,
      spinnerColor: spinner.color,
      spinnerRole: document
        .querySelector(`${rowSelector} .sidebar-session-spinner`)
        ?.getAttribute("role"),
      spinnerLabel: document
        .querySelector(`${rowSelector} .sidebar-session-spinner`)
        ?.getAttribute("aria-label"),
    };
  }, liveTaskId);

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.mouse.move(1100, 700);
  return {
    ...snapshot,
    rowHover,
    menu,
    danger,
    menuItemHover,
    menuFocus,
    renameInput,
    filterFocus,
    filterHover,
    filterCheck,
    disabled,
    newChatHover,
    newChatFocus,
    selectedFocus,
    sessionActionVisibility,
    sessionActionTabTarget,
    projectActionVisibility,
    projectActionTabTarget,
    collapseHover,
    collapseFocus,
    toggleColor,
    toggleHover,
    toggleFocus,
    resizerBackground,
  };
}

function assertChromeSnapshot(actual, expected, label) {
  assertEqual(actual.sidebar.backgroundColor, expected.surface, `${label} surface`);
  assertEqual(actual.sidebar.borderRightColor, expected.border, `${label} border`);
  assertEqual(actual.sidebar.color, expected.ink, `${label} base ink`);
  assertEqual(actual.sidebar.fontSize, "13px", `${label} fixed Sidebar font size`);
  if (
    !actual.sidebar.fontFamily.includes("SF Pro Text") ||
    !actual.sidebar.fontFamily.includes("PingFang SC")
  ) {
    throw new Error(`${label} does not use the stable Sidebar UI font stack`);
  }
  assertEqual(actual.selected.backgroundColor, expected.selected, `${label} selected surface`);
  assertEqual(actual.selected.buttonColor, expected.ink, `${label} selected ink`);
  assertEqual(actual.selected.titleWeight, "600", `${label} selected weight`);
  assertEqual(actual.selected.ariaCurrent, "page", `${label} selected aria-current`);
  assertEqual(actual.rowHover, expected.hover, `${label} row hover`);
  assertEqual(actual.sectionLabelColor, expected.muted, `${label} muted label`);
  assertEqual(actual.collapseColor, expected.muted, `${label} collapse icon`);
  assertEqual(actual.spinnerColor, expected.ink, `${label} spinner currentColor`);
  assertEqual(actual.spinnerColor, actual.selected.buttonColor, `${label} spinner/text parity`);
  assertEqual(actual.spinnerRole, "img", `${label} spinner accessible role`);
  assertEqual(actual.spinnerLabel, "Working", `${label} spinner accessible name`);
  assertEqual(actual.menu.backgroundColor, expected.menu, `${label} menu surface`);
  assertEqual(actual.menu.borderColor, expected.border, `${label} menu border`);
  assertEqual(actual.menu.color, expected.ink, `${label} menu ink`);
  assertEqual(actual.menu.fontFamily, actual.sidebar.fontFamily, `${label} menu font`);
  assertEqual(actual.danger, expected.danger, `${label} menu danger`);
  assertEqual(actual.menuItemHover, expected.menuHover, `${label} menu hover`);
  assertDeepEqual(
    actual.menuFocus,
    { color: expected.focus, style: "solid", width: "2px" },
    `${label} menu focus ring`,
  );
  assertEqual(actual.renameInput.backgroundColor, expected.input, `${label} rename input surface`);
  assertEqual(actual.renameInput.borderColor, expected.focus, `${label} rename input focus border`);
  assertEqual(actual.renameInput.color, expected.ink, `${label} rename input ink`);
  assertEqual(actual.renameInput.fontFamily, actual.sidebar.fontFamily, `${label} rename input font`);
  assertEqual(actual.renameInput.fontSize, "13px", `${label} rename input fixed size`);
  assertDeepEqual(
    actual.filterFocus,
    { color: expected.focus, style: "solid", width: "2px" },
    `${label} filter focus ring`,
  );
  assertEqual(actual.filterHover, expected.controlHover, `${label} filter hover`);
  assertEqual(actual.filterCheck, expected.accent, `${label} filter check`);
  assertEqual(actual.disabled.color, expected.disabled, `${label} disabled resolved ink`);
  assertEqual(actual.disabled.opacity, "0.55", `${label} disabled opacity`);
  assertEqual(actual.newChatHover, expected.hover, `${label} new-chat hover`);
  assertDeepEqual(
    actual.newChatFocus,
    { color: expected.focus, style: "solid", width: "2px" },
    `${label} new-chat focus ring`,
  );
  assertDeepEqual(
    actual.selectedFocus,
    { color: expected.focus, style: "solid", width: "2px" },
    `${label} selected row focus ring`,
  );
  assertEqual(actual.sessionActionVisibility, "visible", `${label} session focus-within action`);
  assertEqual(actual.sessionActionTabTarget, true, `${label} session action forward-Tab target`);
  assertEqual(actual.projectActionVisibility, "visible", `${label} project focus-within actions`);
  assertEqual(actual.projectActionTabTarget, true, `${label} project action forward-Tab target`);
  assertEqual(actual.collapseHover, expected.controlHover, `${label} collapse hover`);
  assertDeepEqual(
    actual.collapseFocus,
    { color: expected.focus, style: "solid", width: "2px" },
    `${label} collapse focus ring`,
  );
  assertEqual(actual.toggleColor, expected.muted, `${label} collapsed toggle ink`);
  assertEqual(actual.toggleHover, expected.controlHover, `${label} collapsed toggle hover`);
  assertDeepEqual(
    actual.toggleFocus,
    { color: expected.focus, style: "solid", width: "2px" },
    `${label} collapsed toggle focus ring`,
  );
  if (!actual.resizerBackground.includes(expected.focus)) {
    throw new Error(`${label} resizer does not use the Sidebar focus role`);
  }
}

async function openFirstSessionMenu(page) {
  const row = page.locator(".sidebar-session").first();
  await row.hover();
  await row.locator(".sidebar-row-hover-action").click();
  await page.locator("#sidebar-menu-root .sidebar-menu").waitFor({ state: "visible" });
  await page.mouse.move(1100, 700);
}

async function revealSessionInProject(page, projectName, sessionRow) {
  const project = page.locator(".sidebar-project").filter({
    has: page.locator(".sidebar-project-name", { hasText: projectName }),
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await sessionRow.count()) > 0) {
      return;
    }
    const showMore = project.locator(".sidebar-disclosure-local");
    if ((await showMore.count()) > 0) {
      await showMore.click();
    } else {
      // task:created schedules the authoritative session-index refresh after
      // 150 ms. The existing fixture corpus may be fully disclosed before the
      // new live row arrives; retain the stored depth and wait for that refresh.
      await page.waitForTimeout(100);
    }
  }
  throw new Error(`Session was not disclosed in ${projectName}`);
}

async function closeSidebarMenu(page) {
  await page.mouse.click(1100, 700);
  await page.locator("#sidebar-menu-root .sidebar-menu").waitFor({ state: "detached" });
}

async function computedProperties(page, selector, properties) {
  return page.locator(selector).evaluate(
    (element, names) => {
      const style = getComputedStyle(element);
      return Object.fromEntries(names.map((name) => [name, style[name]]));
    },
    properties,
  );
}

async function setReadingSettingsViaUi(page, settings) {
  const trigger = page.locator("#reading-settings");
  if ((await page.locator(".reading-settings-popover").count()) === 0) {
    await trigger.click();
  }
  const popover = page.locator(".reading-settings-popover");
  await popover.waitFor({ state: "visible" });

  const themeButton = popover.locator(`.reading-theme-card[data-theme="${settings.theme}"]`);
  await themeButton.click();
  await waitForReadingSetting(page, "theme", settings.theme);

  const modeLabel = settings.mode === "dark" ? "Dark" : "Light";
  const modeButton = popover.getByRole("radio", { name: modeLabel, exact: true });
  await modeButton.click();
  await waitForReadingSetting(page, "mode", settings.mode);

  const sizeValue = popover.locator(".reading-size-value");
  for (;;) {
    const current = Number(await sizeValue.textContent());
    if (current === settings.textStep) {
      break;
    }
    const direction = current < settings.textStep ? "Increase text size" : "Decrease text size";
    await popover.getByRole("button", { name: direction, exact: true }).click();
    await waitForReadingSetting(
      page,
      "textStep",
      current < settings.textStep
        ? ({ 14: 15, 15: 16, 16: 18, 18: 20 })[current]
        : ({ 20: 18, 18: 16, 16: 15, 15: 14 })[current],
    );
  }

  assertEqual(await themeButton.getAttribute("aria-pressed"), "true", "theme UI selection");
  assertEqual(await modeButton.getAttribute("aria-checked"), "true", "mode UI selection");
  assertEqual(await sizeValue.textContent(), String(settings.textStep), "text-size UI selection");
  await trigger.click();
  await popover.waitFor({ state: "detached" });
  await settleFrames(page);
}

async function waitForReadingSetting(page, key, value) {
  await page.waitForFunction(
    async ({ field, expected }) => {
      const root = document.documentElement;
      const rootValue =
        field === "textStep"
          ? root.dataset.textStep
          : field === "mode"
            ? root.dataset.readingModeSetting
            : root.dataset.theme;
      if (rootValue !== String(expected)) {
        return false;
      }
      const persisted = await window.duetRuntime.readReadingSettings();
      return String(persisted[field]) === String(expected);
    },
    { field: key, expected: value },
  );
}

async function focusRing(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth };
  });
}

async function focusViaKeyboard(page, locator) {
  await locator.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assertEqual(
    await locator.evaluate((element) => document.activeElement === element),
    true,
    "keyboard focus target",
  );
}

async function assertProductionSpinnerLiveness(
  page,
  electronApp,
  taskId,
  expected,
  label,
) {
  const row = page.locator(`.sidebar-session[data-task-id="${taskId}"]`);
  const spinner = row.locator(".sidebar-session-spinner");
  await spinner.waitFor({ state: "attached" });
  await spinner.evaluate((element) => {
    element.dataset.slice1Identity = "production-spinner";
  });

  const cases = [
    { liveness: "fresh", title: "Working", className: null, opacity: "1", playState: "running" },
    {
      liveness: "quiet",
      title: "No recent activity",
      className: "quiet",
      opacity: "0.55",
      playState: "paused",
    },
    {
      liveness: "silent",
      title: "No sign of activity — check the terminal",
      className: "silent",
      opacity: "0.4",
      playState: "paused",
    },
    { liveness: "fresh", title: "Working", className: null, opacity: "1", playState: "running" },
  ];
  const evidence = [];
  for (const item of cases) {
    await sendRuntimeEvent(electronApp, {
      type: "working-status:updated",
      payload: {
        taskId,
        native: null,
        liveness: item.liveness,
        silentSince: item.liveness === "silent" ? "2030-01-15T16:58:00.000Z" : null,
        capturedAt: "2030-01-15T17:00:00.000Z",
      },
      ts: "2030-01-15T17:00:00.000Z",
    });
    await page.waitForFunction(
      ({ id, liveness, title }) => {
        const node = document.querySelector(
          `.sidebar-session[data-task-id="${CSS.escape(id)}"] .sidebar-session-spinner`,
        );
        return (
          node instanceof HTMLElement &&
          node.title === title &&
          node.classList.contains("quiet") === (liveness === "quiet") &&
          node.classList.contains("silent") === (liveness === "silent")
        );
      },
      { id: taskId, liveness: item.liveness, title: item.title },
    );
    const actual = await spinner.evaluate((element) => {
      const svg = element.querySelector("svg");
      const button = element
        .closest(".sidebar-session")
        ?.querySelector(".sidebar-session-button");
      if (!(svg instanceof SVGElement) || !(button instanceof HTMLElement)) {
        throw new Error("Production spinner lost its SVG or row button");
      }
      const wrapperStyle = getComputedStyle(element);
      const svgStyle = getComputedStyle(svg);
      return {
        sameNode: element.dataset.slice1Identity === "production-spinner",
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        title: element.title,
        wrapperColor: wrapperStyle.color,
        svgColor: svgStyle.color,
        buttonColor: getComputedStyle(button).color,
        stroke: svg.getAttribute("stroke"),
        opacity: svgStyle.opacity,
        animationName: svgStyle.animationName,
        animationPlayState: svgStyle.animationPlayState,
      };
    });
    assertEqual(actual.sameNode, true, `${label}/${item.liveness} preserves spinner node`);
    assertEqual(actual.role, "img", `${label}/${item.liveness} spinner role`);
    assertEqual(actual.ariaLabel, item.title, `${label}/${item.liveness} aria-label`);
    assertEqual(actual.title, item.title, `${label}/${item.liveness} title`);
    assertEqual(actual.wrapperColor, expected.ink, `${label}/${item.liveness} wrapper ink`);
    assertEqual(actual.svgColor, expected.ink, `${label}/${item.liveness} SVG ink`);
    assertEqual(actual.buttonColor, expected.ink, `${label}/${item.liveness} row ink`);
    assertEqual(actual.wrapperColor, actual.buttonColor, `${label}/${item.liveness} text parity`);
    assertEqual(actual.stroke, "currentColor", `${label}/${item.liveness} SVG currentColor`);
    assertEqual(actual.opacity, item.opacity, `${label}/${item.liveness} opacity`);
    assertEqual(actual.animationName, "sidebar-spin", `${label}/${item.liveness} animation name`);
    assertEqual(
      actual.animationPlayState,
      item.playState,
      `${label}/${item.liveness} animation play state`,
    );
    evidence.push({ liveness: item.liveness, ...actual });
  }
  return evidence;
}

async function assertProductionAttentionMatrix(page, electronApp, taskId) {
  const evidence = [];
  const row = page.locator(`.sidebar-session[data-task-id="${taskId}"]`);
  for (const theme of themes) {
    for (const mode of modes) {
      await setReadingSettingsViaUi(page, { theme, mode, textStep: 14 });
      await sendCliState(electronApp, taskId, "waiting-approval", "Bash");
      const attention = row.locator(".sidebar-session-attention");
      await attention.waitFor({ state: "attached" });
      const actual = await attention.evaluate((element) => ({
        backgroundColor: getComputedStyle(element).backgroundColor,
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        title: element.title,
      }));
      const expectedTitle = "Waiting for approval — Bash";
      assertEqual(actual.backgroundColor, expectedByMode[mode].attention, `${theme}/${mode} attention`);
      assertEqual(actual.role, "img", `${theme}/${mode} attention role`);
      assertEqual(actual.ariaLabel, expectedTitle, `${theme}/${mode} attention aria-label`);
      assertEqual(actual.title, expectedTitle, `${theme}/${mode} attention title`);
      evidence.push({ theme, mode, ...actual });
      await sendCliState(electronApp, taskId, "busy");
      await row.locator(".sidebar-session-spinner").waitFor({ state: "attached" });
    }
  }
  return evidence;
}

async function assertProductionDoneMatrix(page, fixture, taskId) {
  const turnId = "slice-1-visual-turn";
  const promptHook = emitCodexHook(fixture, taskId, "UserPromptSubmit", {
    turn_id: turnId,
    prompt: "Exercise the production completion indicator",
  });
  await waitForRemoved(promptHook, "UserPromptSubmit hook consumption");

  const otherRow = page.locator(`.sidebar-session:not([data-task-id="${taskId}"])`).first();
  await otherRow.locator(".sidebar-session-button").click();
  await otherRow.locator('.sidebar-session-button[aria-current="page"]').waitFor({ state: "attached" });

  const stopHook = emitCodexHook(fixture, taskId, "Stop", {
    turn_id: turnId,
    stop_hook_active: false,
    last_assistant_message: "done",
  });
  await waitForRemoved(stopHook, "Stop hook consumption");
  await waitForIndexedStatus(page, taskId, "completed");

  const row = page.locator(`.sidebar-session[data-task-id="${taskId}"]`);
  const done = row.locator(".sidebar-session-done");
  await done.waitFor({ state: "attached" });
  const evidence = [];
  for (const theme of themes) {
    for (const mode of modes) {
      await setReadingSettingsViaUi(page, { theme, mode, textStep: 20 });
      const actual = await done.evaluate((element) => ({
        backgroundColor: getComputedStyle(element).backgroundColor,
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        title: element.title,
      }));
      const expectedTitle = "Finished while you were away";
      assertEqual(actual.backgroundColor, expectedByMode[mode].done, `${theme}/${mode} done`);
      assertEqual(actual.role, "img", `${theme}/${mode} done role`);
      assertEqual(actual.ariaLabel, expectedTitle, `${theme}/${mode} done aria-label`);
      assertEqual(actual.title, expectedTitle, `${theme}/${mode} done title`);
      evidence.push({ theme, mode, ...actual });
    }
  }
  return evidence;
}

async function sendCliState(electronApp, taskId, activity, tool = null) {
  await sendRuntimeEvent(electronApp, {
    type: "cli-state:changed",
    payload: {
      taskId,
      activity,
      tool,
      approvalKind: activity === "waiting-approval" ? "command" : null,
      source: "sidebar-chrome-e2e",
      changedAt: "2030-01-15T17:00:00.000Z",
    },
    ts: "2030-01-15T17:00:00.000Z",
  });
}

async function sendRuntimeEvent(electronApp, event) {
  await electronApp.evaluate(({ BrowserWindow }, nextEvent) => {
    const target = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL()),
    );
    if (!target) {
      throw new Error("Reading window not found for production runtime event");
    }
    target.webContents.send("runtime:event", nextEvent);
  }, event);
}

function emitCodexHook(fixture, taskId, hookEventName, fields = {}) {
  const taskRuntimeDir = path.join(fixture.dataRoot, "data", "runtime", taskId);
  const hooksDir = path.join(taskRuntimeDir, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const sessionId = `codexsess-${taskId}`;
  const payload = {
    hook_event_name: hookEventName,
    session_id: sessionId,
    transcript_path: path.join(taskRuntimeDir, `rollout-${sessionId}.jsonl`),
    cwd: fixture.projects[0].path,
    model: "gpt-5.5",
    permission_mode: "default",
    ...fields,
  };
  const sequence = `${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}-slice1`;
  const filePath = path.join(hooksDir, `hook-${sequence}.json`);
  fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(payload), "utf8");
  fs.renameSync(`${filePath}.tmp`, filePath);
  return filePath;
}

async function waitForRemoved(filePath, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForIndexedStatus(page, taskId, status) {
  await page.waitForFunction(
    async ({ id, expectedStatus }) => {
      const index = await window.duetRuntime.readSessionIndex({ includeArchived: true });
      const sessions = [
        ...index.projects.flatMap((project) => project.sessions),
        ...index.chats,
      ];
      return sessions.some(
        (session) => session.task.id === id && session.live && session.liveStatus === expectedStatus,
      );
    },
    { id: taskId, expectedStatus: status },
  );
}

async function installFixedClock(page, nowMs) {
  await page.addInitScript((fixedNowMs) => {
    const NativeDate = globalThis.Date;
    function FixedDate(...args) {
      if (new.target) {
        return Reflect.construct(
          NativeDate,
          args.length === 0 ? [fixedNowMs] : args,
          new.target,
        );
      }
      return new NativeDate(fixedNowMs).toString();
    }
    Object.setPrototypeOf(FixedDate, NativeDate);
    FixedDate.prototype = NativeDate.prototype;
    FixedDate.now = () => fixedNowMs;
    globalThis.Date = FixedDate;
  }, nowMs);
}

function isolatedElectronEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DUET_")) {
      delete env[key];
    }
  }
  return { ...env, ...overrides, DUET_LOCAL_API: "0", DUET_NOTIFICATIONS: "0" };
}

async function settleFrames(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function scrollSessionRowIntoView(page, taskId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // Settings and runtime events can legitimately reconcile the Sidebar
      // between locator resolution and the browser's scroll action. Resolve by
      // semantic identity on every attempt; never reuse an ElementHandle.
      await page
        .locator(`.sidebar-session[data-task-id="${taskId}"]`)
        .scrollIntoViewIfNeeded();
      return;
    } catch (error) {
      const detached =
        error instanceof Error && /not attached|detached from the DOM/i.test(error.message);
      if (!detached || attempt === 2) {
        throw error;
      }
      await settleFrames(page);
    }
  }
}

function publishEvidence({ metadata }) {
  const files = fs
    .readdirSync(stagingDir)
    .filter((name) => name.endsWith(".png"))
    .sort();
  fs.mkdirSync(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, "manifest.json");
  fs.rmSync(manifestPath, { force: true });
  const published = [];
  for (const name of files) {
    const source = path.join(stagingDir, name);
    const target = path.join(outputDir, name);
    const temp = `${target}.tmp-${process.pid}`;
    fs.copyFileSync(source, temp);
    fs.renameSync(temp, target);
    published.push({
      name,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
    });
  }
  const current = new Set(files);
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".png") && !current.has(entry.name)) {
      fs.rmSync(path.join(outputDir, entry.name));
    }
  }
  const manifest = { ...metadata, files: published };
  const tempManifest = `${manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(tempManifest, manifestPath);
  return manifest;
}

function assertThemeInvariantScreenshots() {
  for (const mode of modes) {
    const hashes = themes.flatMap((theme) =>
      textSteps.map((textStep) =>
        crypto
          .createHash("sha256")
          .update(
            fs.readFileSync(path.join(stagingDir, `${theme}-${mode}-${textStep}-sidebar.png`)),
          )
          .digest("hex"),
      ),
    );
    if (new Set(hashes).size !== 1) {
      throw new Error(
        `${mode} Sidebar screenshots differ across reading themes/text sizes: ${hashes}`,
      );
    }
  }
}

function readGitHead(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function fingerprintSourceFiles(root, relativePaths) {
  return relativePaths.map((relativePath) => ({
    path: relativePath,
    sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(root, relativePath)))
      .digest("hex"),
  }));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}
