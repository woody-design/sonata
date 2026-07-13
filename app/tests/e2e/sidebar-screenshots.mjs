// Deterministic visual evidence for the Sidebar. The corpus, settings,
// Chromium userData, clock, and Duet-specific environment are isolated; this
// generator never reads or mutates real Duet sessions or preferences.
//
//   node tests/e2e/sidebar-screenshots.mjs [outputDir]
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { createSidebarFixture } from "./helpers/sidebar-fixture.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const appRoot = path.join(repoRoot, "app");
// Output defaults to a throwaway directory; the committed evidence tree
// (product-thinking/sidebar-refactor-evidence/) is historical and must not
// churn on verification runs — publishing there is an explicit argv[2] act.
const outputDir = path.resolve(
  process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "duet-sidebar-screenshots-out-")),
);
const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-sidebar-evidence-"));
const themes = ["duet", "paper", "calm", "focus"];
const modes = ["light", "dark"];
const viewport = { width: 1280, height: 800 };
const capturedFiles = [];
const visualBaselines = [];
const pageErrors = [];
let fixture = null;
let electronApp = null;

try {
  fixture = createSidebarFixture();
  electronApp = await electron.launch({
    args: [
      path.join(appRoot, "dist", "main", "main.js"),
      `--user-data-dir=${fixture.userDataDir}`,
    ],
    env: isolatedElectronEnv(fixture.env),
  });
  const page = await electronApp.firstWindow();
  page.on("pageerror", (error) => {
    pageErrors.push(error.stack ?? error.message);
  });
  page.setDefaultTimeout(60_000);
  await page.setViewportSize(viewport);
  await installFixedClock(page, fixture.fixedNowMs);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await page.locator(".sidebar-session").first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  assertEqual(await page.evaluate(() => Date.now()), fixture.fixedNowMs, "renderer fixed clock");
  assertEqual(
    await page.locator("html").getAttribute("data-instance-label"),
    null,
    "inherited Duet instance label is stripped",
  );
  await assertFixtureIndex(page, fixture.expectations);
  await disableVisualNondeterminism(page);

  for (const theme of themes) {
    for (const mode of modes) {
      await setReadingSettings(page, { theme, mode, textStep: 16 });
      await openFirstSessionMenu(page);
      visualBaselines.push({
        theme,
        mode,
        styles: await collectVisualBaseline(page),
      });
      await closeSidebarMenu(page);
      await shoot(page, `${theme}-${mode}-full`);
      await shoot(page, `${theme}-${mode}-sidebar`, page.locator(".sidebar"));
    }
  }

  await setReadingSettings(page, { theme: "duet", mode: "light", textStep: 16 });

  const firstSession = page.locator(".sidebar-session-button").first();
  await firstSession.click();
  await page.locator(".run-column-new-chat").waitFor({ state: "hidden" });
  await shoot(page, "detail-dormant-session-reading");

  await openFirstSessionMenu(page);
  await shoot(page, "detail-session-menu");
  await closeSidebarMenu(page);

  const projectHeader = page.locator(".sidebar-project-header").first();
  await projectHeader.hover();
  await projectHeader.locator(".sidebar-icon-button").first().click();
  await page.locator("#sidebar-menu-root .sidebar-menu").waitFor({ state: "visible" });
  await shoot(page, "detail-project-menu");
  await closeSidebarMenu(page);

  const projectLabel = page.locator(".sidebar-project-label").first();
  await projectLabel.hover();
  await shoot(page, "detail-project-chevron-hover");
  await projectLabel.click();
  await page.locator(".sidebar-project").first().locator(".sidebar-project-sessions").waitFor({
    state: "detached",
  });
  await shoot(page, "detail-project-collapsed");
  await projectLabel.click();

  await page.locator("#sidebar-new-chat").click();
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });

  const filterButton = page.locator("#sidebar-filter");
  await filterButton.click();
  await page.locator(".sidebar-filter-row", { hasText: "Status" }).click();
  await shoot(page, "detail-filter-menu-status");

  await page.locator(".sidebar-filter-row", { hasText: "Group by" }).click();
  await page.locator(".sidebar-filter-option", { hasText: "Date" }).click();
  await shoot(page, "detail-filter-menu-nondefault");
  await closeSidebarMenu(page);
  await page.locator(".sidebar-section-label", { hasText: "Today" }).waitFor({ state: "visible" });
  await shoot(page, "detail-group-by-date");

  await filterButton.click();
  await page.locator(".sidebar-filter-row", { hasText: "Status" }).click();
  await page.locator(".sidebar-filter-option", { hasText: "Archived" }).click();
  await closeSidebarMenu(page);
  await page.locator(".sidebar-session.archived").first().waitFor({ state: "visible" });
  await shoot(page, "detail-filter-archived");

  await page.locator("#sidebar-collapse").click();
  await page.locator(".sidebar.collapsed").waitFor({ state: "attached" });
  await shoot(page, "detail-sidebar-collapsed");
  await page.locator("#sidebar-toggle").click();

  assertDeepEqual(pageErrors, [], "renderer page errors");
  const manifest = publishEvidence({
    stagingDir,
    outputDir,
    metadata: {
      schemaVersion: 1,
      slice: "0-before",
      purpose: "Pre-change Sidebar characterization; PNGs are human-review evidence.",
      command: "npm run e2e:sidebar-screenshots",
      sourceRevision: readGitHead(repoRoot),
      sourceFiles: fingerprintSourceFiles(repoRoot, [
        "app/src/reading-core/selectors/sidebar.ts",
        "app/src/renderer/main.ts",
        "app/src/renderer/styles.css",
        "app/src/renderer/view/sidebar.ts",
        "app/tests/e2e/helpers/sidebar-fixture.mjs",
        "app/tests/e2e/sidebar-screenshots.mjs",
      ]),
      fixtureClock: fixture.fixedNowIso,
      viewport,
      themes,
      modes,
      projectOrder: fixture.expectations.projectOrder,
      projectCounts: fixture.expectations.projectCounts,
      visualBaselines,
    },
  });

  console.log(
    JSON.stringify(
      {
        outputDir,
        evidenceFiles: manifest.files.length,
        themes,
        modes,
        projectOrder: fixture.expectations.projectOrder,
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
    console.error("Failed to close Sidebar evidence Electron app:", error);
    process.exitCode = 1;
  } finally {
    fixture?.cleanup();
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function isolatedElectronEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DUET_")) {
      delete env[key];
    }
  }
  return {
    ...env,
    ...overrides,
    DUET_LOCAL_API: "0",
    DUET_NOTIFICATIONS: "0",
  };
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

async function assertFixtureIndex(page, expectations) {
  const index = await page.evaluate(() =>
    window.duetRuntime.readSessionIndex({ includeArchived: true }),
  );
  const projectOrder = index.projects.map((project) => project.name);
  assertDeepEqual(projectOrder, expectations.projectOrder, "fixture project order");
  assertDeepEqual(
    Object.fromEntries(index.projects.map((project) => [project.name, project.sessions.length])),
    expectations.projectCounts,
    "fixture project counts",
  );
  assertEqual(index.chats.length, expectations.allChatCount, "fixture all-chat count");
}

async function setReadingSettings(page, settings) {
  // The Reading renderer applies its own write before IPC; a raw preload write
  // intentionally broadcasts only to satellite windows. For this CSS evidence
  // harness, stamp the same root attributes directly after persisting the
  // isolated settings store so the main window and cold-relaunch record agree.
  await page.evaluate(async (next) => {
    await window.duetRuntime.writeReadingSettings(next);
    const root = document.documentElement;
    root.dataset.theme = next.theme;
    root.dataset.mode = next.mode;
    root.dataset.readingModeSetting = next.mode;
    root.dataset.textStep = String(next.textStep);
  }, settings);
  await page.waitForFunction(
    (expected) => {
      const root = document.documentElement;
      return root.dataset.theme === expected.theme && root.dataset.mode === expected.mode;
    },
    settings,
  );
  await page.waitForTimeout(50);
}

async function disableVisualNondeterminism(page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        caret-color: transparent !important;
        transition-duration: 0s !important;
        animation-duration: 0s !important;
      }
    `,
  });
}

async function openFirstSessionMenu(page) {
  const firstRow = page.locator(".sidebar-session").first();
  await firstRow.hover();
  await firstRow.locator(".sidebar-row-hover-action").click();
  await page.locator("#sidebar-menu-root .sidebar-menu").waitFor({ state: "visible" });
  await page.mouse.move(1100, 700);
}

async function closeSidebarMenu(page) {
  await page.mouse.click(1100, 700);
  await page.locator("#sidebar-menu-root .sidebar-menu").waitFor({ state: "detached" });
}

async function collectVisualBaseline(page) {
  return page.evaluate(() => {
    const properties = {
      sidebar: ["backgroundColor", "borderRightColor", "color", "fontFamily", "fontSize"],
      sectionLabel: ["color", "fontFamily", "fontSize", "fontWeight"],
      projectHeader: ["backgroundColor", "color", "fontFamily"],
      sessionButton: ["backgroundColor", "color", "fontFamily", "fontSize"],
      resizer: ["backgroundColor", "borderColor"],
      menu: ["backgroundColor", "borderColor", "boxShadow", "color", "fontFamily"],
      mainPane: ["backgroundColor", "color", "fontFamily"],
    };
    const selectors = {
      sidebar: ".sidebar",
      sectionLabel: ".sidebar-section-label",
      projectHeader: ".sidebar-project-header",
      sessionButton: ".sidebar-session-button",
      resizer: "#sidebar-resizer",
      menu: "#sidebar-menu-root .sidebar-menu",
      mainPane: ".task-entry-panel",
    };
    return Object.fromEntries(
      Object.entries(selectors).map(([key, selector]) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) {
          throw new Error(`Missing visual-baseline element: ${selector}`);
        }
        const style = getComputedStyle(element);
        return [
          key,
          Object.fromEntries(properties[key].map((property) => [property, style[property]])),
        ];
      }),
    );
  });
}

async function shoot(page, name, locator = null) {
  const fileName = `${name}.png`;
  const filePath = path.join(stagingDir, fileName);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  if (locator) {
    await locator.screenshot({ path: filePath, animations: "disabled" });
  } else {
    await page.screenshot({ path: filePath, animations: "disabled" });
  }
  capturedFiles.push(fileName);
  console.log(`captured ${name}`);
}

function publishEvidence({ stagingDir: sourceDir, outputDir: targetDir, metadata }) {
  const files = [...new Set(capturedFiles)].sort();
  if (files.length !== capturedFiles.length) {
    throw new Error("Duplicate Sidebar evidence filename");
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const manifestPath = path.join(targetDir, "manifest.json");
  fs.rmSync(manifestPath, { force: true });

  const publishedFiles = [];
  for (const fileName of files) {
    const sourcePath = path.join(sourceDir, fileName);
    const targetPath = path.join(targetDir, fileName);
    const tempPath = `${targetPath}.tmp-${process.pid}`;
    fs.copyFileSync(sourcePath, tempPath);
    fs.renameSync(tempPath, targetPath);
    publishedFiles.push({
      name: fileName,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex"),
    });
  }

  const currentNames = new Set(files);
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".png") && !currentNames.has(entry.name)) {
      fs.rmSync(path.join(targetDir, entry.name));
    }
  }

  const manifest = { ...metadata, files: publishedFiles };
  const tempManifestPath = `${manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(tempManifestPath, manifestPath);
  return manifest;
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
