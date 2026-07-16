// Slice 4 production chrome fence: native anchors, 48px shared centerline,
// truly centered/truncated breadcrumb, continuous terminal background, stable
// CLI toggle semantics, and metadata-only binding updates that preserve xterm.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId } from "./helpers/session.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "duet-cli-surface-"));
const dataRoot = path.join(root, "data-root");
const settingsDir = path.join(root, "settings");
const fakeBin = path.join(root, "bin");
const project = path.join(root, "project-with-a-longish-name");
const outputDir = path.resolve(
  process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "duet-cli-surface-evidence-")),
);
for (const dir of [settingsDir, fakeBin, project, outputDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(
  path.join(settingsDir, "claude-settings.json"),
  `${JSON.stringify({ defaultPermissionMode: "default", defaultRemoteControl: false }, null, 2)}\n`,
);
installFakeClaude();

let app;
try {
  app = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: dataRoot,
      DUET_WORKSPACES_DIR: path.join(root, "workspaces"),
      DUET_SETTINGS_DIR: settingsDir,
      DUET_TEST_PICK_FOLDER: project,
      DUET_NOTIFICATIONS: "0",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const main = await app.firstWindow();
  let cli = await waitForWindow(app, (page) => page.url().endsWith("/terminal.html"));
  main.setDefaultTimeout(20_000);
  cli.setDefaultTimeout(20_000);
  await main.setViewportSize({ width: 1280, height: 860 });
  await cli.setViewportSize({ width: 900, height: 760 });
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  await cli.locator(".terminal-window-shell").waitFor({ state: "visible" });
  await waitForTerminalAppearance(cli);
  await Promise.all([main.evaluate(() => document.fonts.ready), cli.evaluate(() => document.fonts.ready)]);

  const nativePositions = readConfiguredTrafficLightPositions();
  const mainChrome = await readMainChrome(main);
  const freshCliChrome = await readCliChrome(cli);
  const freshBreadcrumb = await readBreadcrumb(cli);
  const freshLabels = {
    newTaskText: (await main.locator("#sidebar-new-chat").textContent())?.trim(),
    newTaskTitle: await main.locator("#sidebar-new-chat").getAttribute("title"),
    project: await cli.locator("#terminal-project-name").textContent(),
    session: await cli.locator("#terminal-session-title").textContent(),
    action: await cli.locator("#terminal-empty-action").textContent(),
  };
  const emptyActionVisual = await cli.locator("#terminal-empty-action").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      height: rect.height,
      borderRadius: style.borderRadius,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
    };
  });
  await cli.locator("#terminal-empty-action:not(:disabled)").waitFor({ state: "visible" });
  const contrastMatrix = await readContrastMatrix(cli);
  await cli.screenshot({ path: path.join(outputDir, "fresh-cli.png"), animations: "disabled" });
  await main.locator(".task-chrome").screenshot({
    path: path.join(outputDir, "main-chrome.png"),
    animations: "disabled",
  });

  // Stable-label toggle: close and reopen the actual satellite. Only pressed
  // state, selected treatment, and tooltip change; the visible copy stays CLI.
  const toggleOn = await readToggle(main);
  await main.locator("#toggle-terminal-window").click();
  await main.locator('#toggle-terminal-window[aria-pressed="false"]').waitFor({ state: "visible" });
  await waitFor(
    () => app.windows().every((page) => !page.url().endsWith("/terminal.html")),
    "CLI window close",
  );
  const toggleOff = await readToggle(main);
  await main.locator("#toggle-terminal-window").click();
  await main.locator('#toggle-terminal-window[aria-pressed="true"]').waitFor({ state: "visible" });
  cli = await waitForWindow(app, (page) => page.url().endsWith("/terminal.html"));
  cli.setDefaultTimeout(20_000);
  await cli.setViewportSize({ width: 900, height: 760 });
  await cli.locator(".terminal-window-shell").waitFor({ state: "visible" });
  await waitForTerminalAppearance(cli);
  const toggleOnAgain = await readToggle(main);

  // Start from the real fresh empty state, then inspect the live xterm layers.
  await main.locator("#project-chip").click();
  await main.locator("#entry-choose-folder").click();
  await cli.locator("#terminal-empty-action:not(:disabled)", { hasText: "Start CLI" }).click();
  await waitForActiveTask(main);
  await cli.locator(".task-terminal:not(.hidden) .xterm").waitFor({ state: "visible" });
  const liveCliChrome = await readCliChrome(cli);
  const liveBackgrounds = await readLiveBackgrounds(cli);
  const liveBreadcrumb = await readBreadcrumb(cli);
  const liveLabels = {
    project: await cli.locator("#terminal-project-name").textContent(),
    session: await cli.locator("#terminal-session-title").textContent(),
  };
  await cli.locator(".terminal-window-topbar").screenshot({
    path: path.join(outputDir, "live-cli-header.png"),
    animations: "disabled",
  });

  // Exercise the real session/project rename path. Both operations update the
  // Reading state/index, re-project through cliProjectName(), and push a
  // metadata-only binding. The actual xterm node must survive that refresh.
  await cli.locator(".task-terminal:not(.hidden) .xterm").evaluate((element) => {
    element.dataset.slice4Identity = "preserve";
  });
  const longProject = "A project display name that is intentionally much longer than the CLI header";
  const longSession = "A session title that must truncate without moving the geometric center";
  await renameActiveSession(main, longSession);
  await cli.locator("#terminal-session-title", { hasText: longSession }).waitFor({ state: "visible" });
  await renameProject(main, liveLabels.project, longProject);
  await cli.locator("#terminal-project-name", { hasText: longProject }).waitFor({ state: "visible" });
  const longBreadcrumb = await readBreadcrumb(cli);
  const renamedLabels = {
    project: await cli.locator("#terminal-project-name").textContent(),
    session: await cli.locator("#terminal-session-title").textContent(),
  };
  const metadataPreservedXterm =
    (await cli.locator('.task-terminal:not(.hidden) .xterm[data-slice4-identity="preserve"]').count()) === 1 &&
    (await cli.locator(".task-terminal").count()) === 1;

  const checks = {
    nativeTrafficLightsAnchored:
      nativePositions.main?.x === 18 &&
      nativePositions.main?.y === 18 &&
      nativePositions.cli?.x === 18 &&
      nativePositions.cli?.y === 18,
    sharedMainCenterline:
      near(mainChrome.header.height, 48) &&
      near(mainChrome.rail.height, 48) &&
      centered(mainChrome.header, mainChrome.toggle) &&
      centered(mainChrome.header, mainChrome.reading) &&
      centered(mainChrome.rail, mainChrome.sidebarControl),
    sharedCliCenterline:
      near(freshCliChrome.header.height, 48) &&
      centered(freshCliChrome.header, freshCliChrome.label) &&
      centered(freshCliChrome.header, freshCliChrome.theme) &&
      centered(freshCliChrome.header, freshCliChrome.breadcrumb),
    breadcrumbGeometricallyCentered:
      near(freshBreadcrumb.center, freshBreadcrumb.viewportCenter) &&
      near(liveBreadcrumb.center, liveBreadcrumb.viewportCenter) &&
      near(longBreadcrumb.center, longBreadcrumb.viewportCenter),
    breadcrumbTruncates:
      (longBreadcrumb.projectOverflow || longBreadcrumb.sessionOverflow) &&
      longBreadcrumb.projectTextOverflow === "ellipsis" &&
      longBreadcrumb.sessionTextOverflow === "ellipsis",
    continuousBackground:
      new Set(Object.values(freshCliChrome.backgrounds)).size === 1 &&
      new Set(Object.values(liveBackgrounds)).size === 1 &&
      freshCliChrome.borderBottomWidth === "0px" &&
      liveCliChrome.borderBottomWidth === "0px",
    stableToggleSemantics:
      toggleOn.hasIcon &&
      toggleOff.hasIcon &&
      toggleOnAgain.hasIcon &&
      toggleOn.pressed === "true" &&
      toggleOff.pressed === "false" &&
      toggleOnAgain.pressed === "true" &&
      toggleOn.tooltip === "Toggle CLI" &&
      toggleOff.tooltip === "Toggle CLI" &&
      toggleOnAgain.tooltip === "Toggle CLI" &&
      toggleOn.backgroundColor !== toggleOff.backgroundColor,
    freshVocabulary:
      freshLabels.newTaskText === "New task" &&
      freshLabels.newTaskTitle === "New task" &&
      freshLabels.project === "Tasks" &&
      freshLabels.session === "New task" &&
      freshLabels.action === "Start CLI",
    emptyActionIsLocalNeutral:
      near(emptyActionVisual.height, 36) && emptyActionVisual.borderRadius === "8px",
    themeContrastAccessible: contrastMatrix.every(
      (entry) =>
        entry.projectContrast >= 4.5 &&
        entry.supportContrast >= 4.5 &&
        entry.borderContrast >= 3 &&
        entry.focusContrast >= 3 &&
        entry.focusVisible &&
        entry.outlineStyle !== "none" &&
        entry.outlineWidth === "2px",
    ),
    liveBreadcrumbProjection:
      liveLabels.project === path.basename(project) && liveLabels.session === "New task",
    realRenameProjection:
      renamedLabels.project === longProject && renamedLabels.session === longSession,
    metadataUpdatePreservedXterm: metadataPreservedXterm,
  };
  const success = Object.values(checks).every(Boolean);
  console.log(
    JSON.stringify(
      {
        success,
        checks,
        outputDir,
        nativePositions,
        mainChrome,
        freshCliChrome,
        freshBreadcrumb,
        liveBreadcrumb,
        longBreadcrumb,
        liveBackgrounds,
        emptyActionVisual,
        contrastMatrix,
      },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
} finally {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function installFakeClaude() {
  const filePath = path.join(fakeBin, "claude");
  fs.writeFileSync(
    filePath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const runtimeDir = process.env.DUET_RUNTIME_DIR;
fs.mkdirSync(runtimeDir, { recursive: true });
if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }
process.stdin.resume();
process.stdout.write("Fake Claude ready\\n❯ opus xhigh ~\\n");
setInterval(() => {}, 1 << 30);
`,
    { mode: 0o755 },
  );
  fs.chmodSync(filePath, 0o755);
}

function readConfiguredTrafficLightPositions() {
  // Electron exposes setTrafficLightPosition but no corresponding getter in
  // this version. Fence the BrowserWindow construction source, while the live
  // DOM measurements below prove the app surfaces align to that configuration.
  const body = fs.readFileSync(path.join(import.meta.dirname, "../../src/main/main.ts"), "utf8");
  const positionIn = (functionName) => {
    const start = body.indexOf(`function ${functionName}`);
    const end = body.indexOf("\nfunction ", start + 1);
    const match = body.slice(start, end < 0 ? undefined : end).match(
      /trafficLightPosition:\s*\{\s*x:\s*(\d+),\s*y:\s*(\d+)\s*\}/,
    );
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
  };
  return {
    main: positionIn("createMainWindow"),
    cli: positionIn("createTerminalWindow"),
  };
}

async function readMainChrome(page) {
  return page.evaluate(() => {
    const metric = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { top: rect.top, height: rect.height, center: rect.top + rect.height / 2 };
    };
    return {
      header: metric(".task-chrome"),
      rail: metric(".sidebar-rail"),
      toggle: metric("#toggle-terminal-window"),
      reading: metric("#reading-settings"),
      sidebarControl: metric("#sidebar-collapse"),
    };
  });
}

async function readCliChrome(page) {
  return page.evaluate(() => {
    const metric = (selector) => {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      return { top: rect.top, height: rect.height, center: rect.top + rect.height / 2 };
    };
    const background = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
    return {
      header: metric(".terminal-window-topbar"),
      label: metric(".terminal-window-label"),
      breadcrumb: metric(".terminal-window-breadcrumb"),
      theme: metric("#terminal-theme-trigger"),
      backgrounds: {
        shell: background(".terminal-window-shell"),
        header: background(".terminal-window-topbar"),
        content: background(".terminal-window-content"),
        term: background(".terminal-window-term"),
      },
      borderBottomWidth: getComputedStyle(document.querySelector(".terminal-window-topbar"))
        .borderBottomWidth,
    };
  });
}

async function readLiveBackgrounds(page) {
  return page.evaluate(() => {
    const background = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
    return {
      shell: background(".terminal-window-shell"),
      header: background(".terminal-window-topbar"),
      content: background(".terminal-window-content"),
      term: background(".terminal-window-term"),
      task: background(".task-terminal:not(.hidden)"),
      xterm: background(".task-terminal:not(.hidden) .xterm"),
      viewport: background(".task-terminal:not(.hidden) .xterm-viewport"),
    };
  });
}

async function readBreadcrumb(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".terminal-window-breadcrumb");
    const projectNode = document.querySelector("#terminal-project-name");
    const sessionNode = document.querySelector("#terminal-session-title");
    const rect = root.getBoundingClientRect();
    return {
      center: rect.left + rect.width / 2,
      viewportCenter: window.innerWidth / 2,
      width: rect.width,
      projectOverflow: projectNode.scrollWidth > projectNode.clientWidth,
      sessionOverflow: sessionNode.scrollWidth > sessionNode.clientWidth,
      projectTextOverflow: getComputedStyle(projectNode).textOverflow,
      sessionTextOverflow: getComputedStyle(sessionNode).textOverflow,
    };
  });
}

async function readToggle(page) {
  return page.locator("#toggle-terminal-window").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      hasIcon: element.querySelector("svg") !== null,
      pressed: element.getAttribute("aria-pressed"),
      tooltip: element.dataset.tooltip,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      color: style.color,
    };
  });
}

async function readContrastMatrix(page) {
  const entries = [];
  await page.locator("#terminal-theme-trigger").click();
  for (const theme of ["duet", "paper", "calm", "focus"]) {
    for (const mode of ["light", "dark"]) {
      await page.locator(`[data-theme-choice="${theme}"]`).click();
      await page.locator(`[data-mode-choice="${mode}"]`).click();
      await page.locator(`html[data-theme="${theme}"][data-mode="${mode}"]`).waitFor({
        state: "attached",
      });
      // Make keyboard modality explicit before programmatic focus so the
      // production :focus-visible rule, not a forced test pseudo-state, wins.
      await page.keyboard.press("Tab");
      await page.locator("#terminal-empty-action").focus();
      const colors = await page.evaluate(() => {
        const project = document.querySelector("#terminal-project-name");
        const support = document.querySelector("#terminal-empty-detail");
        const action = document.querySelector("#terminal-empty-action");
        const background = document.querySelector(".terminal-window-content");
        const projectStyle = getComputedStyle(project);
        const supportStyle = getComputedStyle(support);
        const actionStyle = getComputedStyle(action);
        const backgroundColor = getComputedStyle(background).backgroundColor;
        return {
          backgroundColor,
          projectColor: projectStyle.color,
          supportColor: supportStyle.color,
          borderColor: actionStyle.borderTopColor,
          outlineColor: actionStyle.outlineColor,
          outlineStyle: actionStyle.outlineStyle,
          outlineWidth: actionStyle.outlineWidth,
          focusVisible: action.matches(":focus-visible"),
        };
      });
      entries.push({
        theme,
        mode,
        ...colors,
        projectContrast: contrastRatio(colors.projectColor, colors.backgroundColor),
        supportContrast: contrastRatio(colors.supportColor, colors.backgroundColor),
        borderContrast: contrastRatio(colors.borderColor, colors.backgroundColor),
        focusContrast: contrastRatio(colors.outlineColor, colors.backgroundColor),
      });
    }
  }
  await page.locator('[data-theme-choice="duet"]').click();
  await page.locator('[data-mode-choice="auto"]').click();
  await page.locator("#terminal-theme-trigger").click();
  return entries;
}

async function renameActiveSession(page, title) {
  await page.locator("#session-menu-trigger").click();
  await page
    .locator("#sidebar-menu-root")
    .getByRole("menuitem", { name: "Rename", exact: true })
    .click();
  const input = page.locator(".rename-editor-header input");
  await input.waitFor({ state: "visible" });
  await input.fill(title);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
}

async function renameProject(page, currentName, nextName) {
  const project = page.locator(".sidebar-project").filter({
    has: page.locator(".sidebar-project-name", { hasText: currentName }),
  });
  const header = project.locator(".sidebar-project-header");
  await header.hover();
  await header.locator(".sidebar-row-actions button").first().click();
  await page
    .locator("#sidebar-menu-root")
    .getByRole("menuitem", { name: "Rename project", exact: true })
    .click();
  const input = page.locator(".rename-editor-sidebar input");
  await input.waitFor({ state: "visible" });
  await input.fill(nextName);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
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

function centered(parent, child) {
  return near(parent.center, child.center);
}

function near(actual, expected, tolerance = 1) {
  return Math.abs(actual - expected) <= tolerance;
}

async function waitForActiveTask(page) {
  await waitFor(() => activeSessionTaskId(page).then(Boolean).catch(() => false), "active task");
  return activeSessionTaskId(page);
}

async function waitForTerminalAppearance(page) {
  await page.locator("html[data-theme][data-mode]").waitFor({ state: "attached" });
  // A newly shown Electron window can receive the native system-mode media
  // update just after its first paint. Let that event settle before treating
  // an auto-mode palette as visual evidence.
  await page.waitForTimeout(300);
  await waitFor(
    () =>
      page.evaluate(
        () =>
          document.documentElement.dataset.mode ===
          (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
      ),
    "CLI system appearance",
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForWindow(electronApp, predicate) {
  let found = null;
  await waitFor(() => {
    found = electronApp.windows().find((page) => !page.isClosed() && predicate(page)) ?? null;
    return Boolean(found);
  }, "CLI window");
  return found;
}
