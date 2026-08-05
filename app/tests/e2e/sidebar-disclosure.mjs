// Slice 3 production-path acceptance fence for Sidebar progressive disclosure,
// control semantics, focus/scroll reconciliation, and all grouping modes.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { hoverSettled } from "./helpers/hover.mjs";
import { createSidebarFixture } from "./helpers/sidebar-fixture.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const appRoot = path.join(repoRoot, "app");
// Output defaults to a throwaway directory; publishing anywhere durable is
// an explicit argv[2] act — verification runs must not churn a kept tree.
const outputDir = path.resolve(
  process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "sonata-sidebar-disclosure-out-")),
);
const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-sidebar-disclosure-"));
const viewport = { width: 1280, height: 800 };
const screenshots = [];
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
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.setViewportSize(viewport);
  await installFixedClock(page, fixture.fixedNowMs);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".sidebar-project").first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);

  await assertInitialProjectDisclosure(page, fixture);
  await assertDisclosureControlA11yAndStyles(page);
  console.log("  pass: initial controls, a11y, hover, focus, reduced motion");
  await installDeterministicVisualStyle(page);
  await captureSidebar(page, "project-initial-light");

  await setReadingModeViaUi(page, "dark");
  // Design System Migration (S1b): the disclosure action rests at --text-tertiary
  // (p-ink @ .50, an rgba overlay) and strengthens to --text-primary on hover.
  await assertDisclosureInk(page, {
    resting: "rgba(216, 214, 209, 0.5)",
    hover: "rgb(216, 214, 209)",
  });
  await captureSidebar(page, "project-initial-dark");
  await setReadingModeViaUi(page, "light");

  await assertLocalAndOuterProjectBehavior(page, fixture);
  console.log("  pass: local project disclosure, collapse, simultaneous outer actions");
  await page.locator("#sidebar-sections").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await captureSidebar(page, "project-expanded-light");
  await assertProjectKeyboardFocusBehavior(page, fixture);
  console.log("  pass: keyboard and pointer disclosure focus policy");
  await assertDateBehavior(page);
  console.log("  pass: independent Date buckets");
  await assertFlatAndFocusedBehavior(page, fixture);
  console.log("  pass: flat and focused-project modes");
  await assertPreferenceResetAndNoOp(page, fixture);
  console.log("  pass: preference reset/no-op policy and canonical project order");
  await captureSidebar(page, "focused-project-light");
  await assertNarrowFilterMenuFocusAnchor(page, fixture);
  console.log("  pass: narrow filter menu preserves a visible keyboard focus anchor");
  await assertIndexRefreshAndFallback(page, fixture);
  await assertKeyboardVisibleRowActions(page);
  console.log("  pass: index refresh, semantic focus/scroll, keyboard row actions");

  assertDeepEqual(pageErrors, [], "renderer page errors");
  const manifest = publishEvidence({
    metadata: {
      generatedAt: new Date(fixture.fixedNowMs).toISOString(),
      sourceRevision: readGitHead(repoRoot),
      viewport,
      fixedNow: fixture.fixedNowIso,
      assertions: {
        exactInitialAndIncrement: true,
        localOnlyShowMore: true,
        outerControlsCoexistInFixedOrder: true,
        outerResetAll: true,
        projectCollapsePreservesDepth: true,
        projectOrderCanonical: true,
        dateBucketsIndependent: true,
        flatAndFocusedGroups: true,
        preferenceResetAndNoOp: true,
        semanticFocusAndScroll: true,
        pointerDoesNotForceFinalBatchFocus: true,
        keyboardFinalBatchFocus: true,
        nativeButtonA11yAndLockedStyles: true,
        backgroundIndexRefreshFallback: true,
        crossGroupNearestFallback: true,
        narrowFilterMenuFocusAnchor: true,
        closedMenuReturnsToTrigger: true,
      },
      sourceFiles: fingerprintSourceFiles(repoRoot, [
        "app/src/reading-core/state.ts",
        "app/src/reading-core/selectors/sidebar.ts",
        "app/src/reading-core/transitions/sidebar.ts",
        "app/src/renderer/view/sidebar.ts",
        "app/src/renderer/view/popover-geometry.ts",
        "app/src/renderer/styles.css",
        "app/tests/e2e/helpers/sidebar-fixture.mjs",
        "app/tests/e2e/sidebar-disclosure.mjs",
      ]),
    },
  });
  console.log(
    `sidebar-disclosure: production E2E passes; ${manifest.files.length} deterministic screenshots published`,
  );
} finally {
  try {
    if (electronApp) {
      await electronApp.close();
    }
  } finally {
    fixture?.cleanup();
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

async function assertInitialProjectDisclosure(page, fixture) {
  assertDeepEqual(
    await visibleProjectNames(page),
    fixture.expectations.activeProjectOrder.slice(0, 5),
    "initial project prefix follows canonical index order",
  );
  for (const name of fixture.expectations.activeProjectOrder.slice(0, 5)) {
    assertEqual(await projectSessionCount(page, name), 5, `${name} initial session prefix`);
  }
  assertEqual(await chatsGroup(page).locator(".sidebar-session").count(), 5, "Tasks initial prefix");
  assertDeepEqual(await outerLabels(page), ["Show more"], "initial outer actions");
  assertEqual(await outerAction(page, "Show less").count(), 0, "initial Show less absent");
}

async function assertDisclosureControlA11yAndStyles(page) {
  const controls = page.locator(".sidebar-disclosure-action");
  assertEqual((await controls.count()) > 0, true, "disclosure controls exist");
  for (let index = 0; index < (await controls.count()); index += 1) {
    const audit = await controls.nth(index).evaluate((element) => {
      const controlledId = element.getAttribute("aria-controls");
      return {
        tag: element.tagName,
        type: element.getAttribute("type"),
        text: element.textContent?.trim(),
        ariaLabel: element.getAttribute("aria-label"),
        ariaExpanded: element.hasAttribute("aria-expanded"),
        controlsExistingNode: controlledId !== null && document.getElementById(controlledId) !== null,
        height: element.getBoundingClientRect().height,
      };
    });
    assertEqual(audit.tag, "BUTTON", `control ${index} native button`);
    assertEqual(audit.type, "button", `control ${index} button type`);
    assertEqual(["Show more", "Show less"].includes(audit.text), true, `control ${index} exact copy`);
    assertEqual(/^Show \d+ more |^Show less and reset /.test(audit.ariaLabel ?? ""), true, `control ${index} scoped accessible name`);
    assertEqual(audit.ariaExpanded, false, `control ${index} avoids partial aria-expanded misuse`);
    assertEqual(audit.controlsExistingNode, true, `control ${index} aria-controls target`);
    assertEqual(audit.height >= 28, true, `control ${index} hit height`);
  }

  // Design System Migration (S1b): resting --text-tertiary → hover --text-primary
  // (light warm-ink roles); the teal disclosure-ink is retired.
  await assertDisclosureInk(page, {
    resting: "rgba(55, 53, 47, 0.5)",
    hover: "rgb(55, 53, 47)",
  });
  const first = controls.first();
  await first.focus();
  const focus = await first.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth };
  });
  assertDeepEqual(
    focus,
    { color: "rgba(39, 110, 241, 0.55)", style: "solid", width: "2px" },
    "disclosure focus-visible ring",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  assertEqual(
    await first.evaluate((element) => getComputedStyle(element).transitionDuration),
    "0s",
    "reduced motion removes disclosure transition",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
}

async function assertDisclosureInk(page, expected) {
  const action = page.locator(".sidebar-disclosure-action").first();
  await page.mouse.move(1100, 700);
  const resting = await action.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      background: style.backgroundColor,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      textDecoration: style.textDecorationLine,
    };
  });
  assertDeepEqual(
    resting,
    {
      color: expected.resting,
      background: "rgba(0, 0, 0, 0)",
      fontSize: "13px",
      fontWeight: "400",
      textDecoration: "none",
    },
    "disclosure resting style",
  );
  await hoverSettled(page, action);
  const hover = await action.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
  assertDeepEqual(
    hover,
    { color: expected.hover, background: "rgba(0, 0, 0, 0)" },
    "disclosure hover style",
  );
  await page.mouse.move(1100, 700);
}

async function assertLocalAndOuterProjectBehavior(page, fixture) {
  const mango = projectByName(page, "Mango");
  const mangoMore = mango.locator(".sidebar-disclosure-local");
  await mangoMore.click();
  assertEqual(await projectSessionCount(page, "Mango"), 15, "local +10 reveals 15");
  assertEqual((await visibleProjectNames(page)).length, 5, "local expansion does not add projects");
  assertDeepEqual(await outerLabels(page), ["Show less", "Show more"], "outer actions coexist in fixed order");
  assertEqual(
    await outerAction(page, "Show less").getAttribute("aria-label"),
    "Show less and reset all project and session lists to 5 items",
    "outer reset accessible scope",
  );

  await chatsGroup(page).locator(".sidebar-disclosure-local").click();
  assertEqual(await chatsGroup(page).locator(".sidebar-session").count(), 6, "Tasks expands independently");
  assertEqual(await projectSessionCount(page, "Mango"), 15, "Tasks does not change project group depth");
  assertEqual((await visibleProjectNames(page)).length, 5, "Tasks do not count as projects");

  await mango.locator(".sidebar-project-label").click();
  assertEqual(await mango.locator(".sidebar-project-sessions").count(), 0, "project collapses");
  assertDeepEqual(await outerLabels(page), ["Show less", "Show more"], "collapse preserves latent depth");
  await mango.locator(".sidebar-project-label").click();
  assertEqual(await projectSessionCount(page, "Mango"), 15, "re-expand restores local depth");

  await mangoMore.click();
  assertEqual(await projectSessionCount(page, "Mango"), 25, "second local +10 reveals 25");
  await mangoMore.click();
  assertEqual(await projectSessionCount(page, "Mango"), 26, "final local batch reveals remainder");
  const finalNewTaskId = await mango.locator(".sidebar-session").last().getAttribute("data-task-id");
  assertEqual(await mangoMore.count(), 0, "local Show more disappears at completion");
  assertEqual(await mango.getByText("Show less", { exact: true }).count(), 0, "local scope never gains Show less");
  assertEqual(
    await activeSidebarFocusKey(page) === `session:${finalNewTaskId}`,
    false,
    "pointer final batch does not force focus to new session",
  );
}

async function assertProjectKeyboardFocusBehavior(page, fixture) {
  const selectedToHide = projectByName(page, "Mango").locator(".sidebar-session").nth(10);
  const selectedToHideId = await selectedToHide.getAttribute("data-task-id");
  const selectedToHideTitle = await selectedToHide.locator(".sidebar-session-title").textContent();
  await selectedToHide.locator(".sidebar-session-button").click();
  await selectedToHide.locator('.sidebar-session-button[aria-current="page"]').waitFor({
    state: "attached",
  });
  await outerAction(page, "Show less").click();
  assertEqual(await projectSessionCount(page, "Mango"), 5, "outer reset restores local count");
  assertEqual(await chatsGroup(page).locator(".sidebar-session").count(), 5, "outer reset restores Tasks");
  assertEqual(
    await page.locator(`.sidebar-session[data-task-id="${selectedToHideId}"]`).count(),
    0,
    "global reset may hide the selected row",
  );
  assertEqual(
    await page.locator("#task-title").textContent(),
    selectedToHideTitle,
    "hidden selection remains the active Header session",
  );

  const mangoMore = projectByName(page, "Mango").locator(".sidebar-disclosure-local");
  await mangoMore.focus();
  await mangoMore.press("Enter");
  assertEqual(await projectSessionCount(page, "Mango"), 15, "keyboard local non-final batch");
  assertEqual(
    await activeSidebarFocusKey(page),
    `disclosure:project:${fixture.projects[0].path}:more`,
    "non-final local action keeps semantic focus",
  );
  await outerAction(page, "Show less").click();

  const echo = projectByName(page, "Echo");
  const echoMore = echo.locator(".sidebar-disclosure-local");
  await echoMore.focus();
  await echoMore.press("Enter");
  assertEqual(await projectSessionCount(page, "Echo"), 6, "keyboard local final batch");
  const echoLastId = await echo.locator(".sidebar-session").last().getAttribute("data-task-id");
  assertEqual(await activeSidebarFocusKey(page), `session:${echoLastId}`, "local final focuses first new session");

  await outerAction(page, "Show less").click();
  const firstOuterMore = outerAction(page, "Show more");
  await firstOuterMore.focus();
  await firstOuterMore.press("Enter");
  assertEqual((await visibleProjectNames(page)).length, 15, "outer +10 reveals 15 projects");
  assertEqual(await projectSessionCount(page, "Mango"), 5, "outer expansion does not expand sessions");
  assertEqual(await activeSidebarFocusKey(page), "disclosure:outer:more", "non-final outer action keeps focus");
  assertDeepEqual(await outerLabels(page), ["Show less", "Show more"], "outer pair remains fixed");

  await outerAction(page, "Show more").press("Enter");
  assertEqual((await visibleProjectNames(page)).length, 16, "outer final batch reveals remainder");
  assertEqual(await outerAction(page, "Show more").count(), 0, "outer Show more disappears at completion");
  const finalProjectName = fixture.expectations.activeProjectOrder[15];
  assertEqual(
    await activeSidebarFocusKey(page),
    `project:${fixture.projects.find((project) => project.name === finalProjectName).path}`,
    "outer final batch focuses first newly revealed project",
  );

  await outerAction(page, "Show less").focus();
  await outerAction(page, "Show less").press("Enter");
  assertEqual((await visibleProjectNames(page)).length, 5, "keyboard Show less resets projects");
  assertEqual(await activeSidebarFocusKey(page), "disclosure:outer:more", "Show less focuses available outer Show more");
}

async function assertDateBehavior(page) {
  await chooseSidebarPreference(page, "Group by", "Date", "menu:filter:group:date");
  await closeFilterMenu(page);
  assertEqual(
    await page.locator("#sidebar-sections").evaluate((element) => element.scrollTop),
    0,
    "new view definition starts at the top",
  );
  assertDeepEqual(
    await page.locator(".sidebar-session-group .sidebar-section-label").allTextContents(),
    ["Today", "Yesterday", "This week", "Older"],
    "Date bucket order",
  );
  for (const label of ["Today", "Yesterday", "This week", "Older"]) {
    assertEqual(await dateGroup(page, label).locator(".sidebar-session").count(), 5, `${label} initial 5`);
  }
  await captureSidebar(page, "date-initial-light");
  await dateGroup(page, "Today").locator(".sidebar-disclosure-local").click();
  assertEqual(await dateGroup(page, "Today").locator(".sidebar-session").count(), 15, "Today owns +10");
  assertEqual(await dateGroup(page, "Yesterday").locator(".sidebar-session").count(), 5, "Yesterday remains independent");
  assertDeepEqual(await outerLabels(page), ["Show less"], "Date has outer reset only");
  assertEqual(await outerAction(page, "Show more").count(), 0, "Date outer never expands");
  await page.locator("#sidebar-sections").evaluate((element) => {
    element.scrollTop = 0;
  });
  await captureSidebar(page, "date-expanded-light");
  await outerAction(page, "Show less").focus();
  await outerAction(page, "Show less").press("Enter");
  assertEqual(await dateGroup(page, "Today").locator(".sidebar-session").count(), 5, "Date outer reset all buckets");
  assertEqual(
    /^session:/.test((await activeSidebarFocusKey(page)) ?? ""),
    true,
    "Date keyboard Show less focuses the first visible row when outer Show more is unavailable",
  );
}

async function assertFlatAndFocusedBehavior(page, fixture) {
  await chooseSidebarPreference(page, "Group by", "None", "menu:filter:group:none");
  await closeFilterMenu(page);
  assertEqual(await page.locator(".sidebar-session-group").count(), 1, "flat mode has one group");
  assertEqual(await page.locator(".sidebar-session").count(), 5, "flat initial 5");
  await page.locator(".sidebar-session-group .sidebar-disclosure-local").click();
  assertEqual(await page.locator(".sidebar-session").count(), 15, "flat +10");
  assertDeepEqual(await outerLabels(page), ["Show less"], "flat has outer reset only");

  await chooseSidebarPreference(page, "Project", "Mango", `menu:filter:project:${fixture.projects[0].path}`);
  await closeFilterMenu(page);
  assertEqual(await page.locator(".sidebar-list-header .sidebar-section-label").textContent(), "Mango", "focused header");
  assertEqual(await page.locator(".sidebar-session-group").count(), 1, "focused mode has one group");
  assertEqual(await page.locator(".sidebar-session").count(), 5, "entering focus resets to 5");
  assertEqual(
    await page.locator(".sidebar-disclosure-local").getAttribute("aria-label"),
    "Show 10 more sessions in Mango",
    "focused local accessible scope",
  );
  await page.locator(".sidebar-disclosure-local").click();
  assertEqual(await page.locator(".sidebar-session").count(), 15, "focused +10");
  assertDeepEqual(await outerLabels(page), ["Show less"], "focused has outer reset only");
}

async function assertPreferenceResetAndNoOp(page, fixture) {
  await chooseSidebarPreference(page, "Project", "All projects", "menu:filter:project:all");
  await chooseSidebarPreference(page, "Group by", "Project", "menu:filter:group:project");
  await closeFilterMenu(page);
  await projectByName(page, "Mango").locator(".sidebar-disclosure-local").click();
  await outerAction(page, "Show more").click();
  assertEqual(await projectSessionCount(page, "Mango"), 15, "pre-sort local depth");
  assertEqual((await visibleProjectNames(page)).length, 15, "pre-sort project depth");

  await chooseSidebarPreference(page, "Sort by", "Alphabetically", "menu:filter:sort:alphabetical");
  await closeFilterMenu(page);
  assertEqual(await projectSessionCount(page, "Mango"), 5, "actual sort change resets local depth");
  assertEqual((await visibleProjectNames(page)).length, 5, "actual sort change resets projects");
  assertDeepEqual(
    await visibleProjectNames(page),
    fixture.expectations.activeProjectOrder.slice(0, 5),
    "alphabetical session sort preserves canonical project order",
  );

  await projectByName(page, "Mango").locator(".sidebar-disclosure-local").click();
  await chooseSidebarPreference(page, "Sort by", "Alphabetically", "menu:filter:sort:alphabetical");
  await closeFilterMenu(page);
  assertEqual(await projectSessionCount(page, "Mango"), 15, "already-selected sort is a no-op");

  await chooseSidebarPreference(page, "Show", "All", "menu:filter:status:all");
  await closeFilterMenu(page);
  assertEqual(await projectSessionCount(page, "Mango"), 5, "actual status filter change resets depth");
  await page.locator("#sidebar-filter").click();
  const clearFilters = page.locator("#sidebar-menu-root .sidebar-menu-item", {
    hasText: "Clear filters",
  });
  await clearFilters.focus();
  await clearFilters.press("Enter");
  await page.locator("#sidebar-menu-root .sidebar-filter-menu").waitFor({ state: "detached" });
  assertEqual(await activeSidebarFocusKey(page), "filter", "keyboard menu close returns focus to its trigger");

  await chooseSidebarPreference(page, "Project", "Mango", `menu:filter:project:${fixture.projects[0].path}`);
  await closeFilterMenu(page);
}

async function assertIndexRefreshAndFallback(page, fixture) {
  await chooseSidebarPreference(page, "Project", "All projects", "menu:filter:project:all");
  await chooseSidebarPreference(page, "Sort by", "Recency", "menu:filter:sort:recency");
  await closeFilterMenu(page);
  const targetId = await projectByName(page, "Bravo")
    .locator(".sidebar-session")
    .nth(2)
    .getAttribute("data-task-id");
  if (!targetId) {
    throw new Error("Missing visible session for index-refresh focus fence");
  }
  const target = page.locator(`.sidebar-session[data-task-id="${targetId}"] .sidebar-session-button`);
  const nextTargetId = await projectByName(page, "Bravo")
    .locator(".sidebar-session")
    .nth(3)
    .getAttribute("data-task-id");
  if (!nextTargetId) {
    throw new Error("Missing adjacent visible session for index-refresh fallback fence");
  }
  await target.focus();
  await target.scrollIntoViewIfNeeded();
  const before = await focusGeometry(page);

  await page.evaluate(
    ({ projectPath, nextName }) => window.sonataRuntime.renameProject({ path: projectPath, displayName: nextName }),
    { projectPath: fixture.projects[0].path, nextName: "Mango refreshed" },
  );
  await projectByName(page, "Mango refreshed").locator(".sidebar-project-name").waitFor({
    state: "visible",
  });
  const after = await focusGeometry(page);
  assertEqual(after.key, `session:${targetId}`, "background index refresh restores semantic focus");
  assertEqual(Math.abs(after.offsetTop - before.offsetTop) <= 1, true, "background refresh preserves focus anchor");
  assertEqual(Math.abs(after.scrollTop - before.scrollTop) <= 1, true, "background refresh preserves scrollTop");

  await page.evaluate(
    ({ projectPath, nextName }) => window.sonataRuntime.renameProject({ path: projectPath, displayName: nextName }),
    { projectPath: fixture.projects[0].path, nextName: "Mango" },
  );
  await projectByName(page, "Mango").locator(".sidebar-project-name").waitFor({ state: "visible" });

  await target.focus();
  await page.evaluate((taskId) => window.sonataRuntime.deleteSession({ taskId }), targetId);
  await page.locator(`.sidebar-session[data-task-id="${targetId}"]`).waitFor({ state: "detached" });
  assertEqual(
    await activeSidebarFocusKey(page),
    `session:${nextTargetId}`,
    "removed focused entity falls back to its nearest surviving session",
  );

  await outerAction(page, "Show more").click();
  const singletonProject = projectByName(page, "Hotel");
  const singletonSession = singletonProject.locator(".sidebar-session-button");
  const singletonId = await singletonProject.locator(".sidebar-session").getAttribute("data-task-id");
  const nextProject = fixture.projects.find((project) => project.name === "Delta");
  if (!singletonId || !nextProject) {
    throw new Error("Missing singleton-project cross-group fallback fixture");
  }
  await singletonSession.focus();
  await page.evaluate((taskId) => window.sonataRuntime.deleteSession({ taskId }), singletonId);
  await singletonProject.waitFor({ state: "detached" });
  assertEqual(
    await activeSidebarFocusKey(page),
    `project:${nextProject.path}`,
    "removed singleton group falls forward to the nearest cross-group row",
  );
}

async function assertNarrowFilterMenuFocusAnchor(page, fixture) {
  const targetProject = fixture.projects.find((project) => project.name === "Gamma");
  if (!targetProject) {
    throw new Error("Missing narrow-menu focus fixture project");
  }

  await page.setViewportSize({ width: viewport.width, height: 360 });
  await chooseSidebarPreference(
    page,
    "Project",
    targetProject.name,
    `menu:filter:project:${targetProject.path}`,
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  const geometry = await page.evaluate(() => {
    const menu = document.querySelector("#sidebar-menu-root .sidebar-filter-menu");
    const active = document.activeElement;
    if (!(menu instanceof HTMLElement) || !(active instanceof HTMLElement) || !menu.contains(active)) {
      throw new Error("Missing active narrow filter-menu option");
    }
    const menuRect = menu.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    return {
      menuScrollTop: menu.scrollTop,
      menuTop: menuRect.top,
      menuBottom: menuRect.bottom,
      activeTop: activeRect.top,
      activeBottom: activeRect.bottom,
    };
  });
  assertEqual(geometry.menuScrollTop > 0, true, "narrow filter menu restores its own scrollTop");
  assertEqual(
    geometry.activeTop >= geometry.menuTop - 1 && geometry.activeBottom <= geometry.menuBottom + 1,
    true,
    "restored narrow filter-menu focus remains visible",
  );

  await chooseSidebarPreference(page, "Project", "All projects", "menu:filter:project:all");
  await closeFilterMenu(page);
  await page.setViewportSize(viewport);
}

async function assertKeyboardVisibleRowActions(page) {
  const project = page.locator(".sidebar-project").first();
  await project.locator(".sidebar-project-label").focus();
  assertEqual(
    await project.locator(".sidebar-row-actions").evaluate((element) => getComputedStyle(element).visibility),
    "visible",
    "project keyboard focus reveals row actions",
  );
  const session = page.locator(".sidebar-session").first();
  await session.locator(".sidebar-session-button").focus();
  assertEqual(
    await session.locator(".sidebar-row-hover-action").evaluate((element) => getComputedStyle(element).visibility),
    "visible",
    "session keyboard focus reveals row action",
  );
}

function projectByName(page, name) {
  return page.locator(".sidebar-project").filter({
    has: page.locator(".sidebar-project-name").filter({
      hasText: new RegExp(`^${escapeRegExp(name)}$`),
    }),
  }).first();
}

function chatsGroup(page) {
  return page.locator(".sidebar-session-group").filter({
    has: page.locator(".sidebar-section-label", { hasText: "Tasks" }),
  });
}

function dateGroup(page, label) {
  return page.locator(".sidebar-session-group").filter({
    has: page.locator(".sidebar-section-label", { hasText: label }),
  });
}

async function projectSessionCount(page, name) {
  return projectByName(page, name).locator(".sidebar-session").count();
}

async function visibleProjectNames(page) {
  return page.locator(".sidebar-project-name").allTextContents();
}

function outerAction(page, label) {
  return page.locator(".sidebar-disclosure-footer .sidebar-disclosure-action").filter({
    hasText: label,
  });
}

async function outerLabels(page) {
  return page.locator(".sidebar-disclosure-footer .sidebar-disclosure-action").allTextContents();
}

async function activeSidebarFocusKey(page) {
  return page.evaluate(() =>
    document.activeElement instanceof HTMLElement
      ? (document.activeElement.dataset.sidebarFocusKey ?? null)
      : null,
  );
}

async function focusGeometry(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const scroller = document.querySelector("#sidebar-sections");
    if (!(active instanceof HTMLElement) || !(scroller instanceof HTMLElement)) {
      throw new Error("Missing Sidebar focus geometry target");
    }
    return {
      key: active.dataset.sidebarFocusKey ?? null,
      offsetTop: active.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      scrollTop: scroller.scrollTop,
    };
  });
}

async function chooseSidebarPreference(page, section, option, expectedFocusKey) {
  if ((await page.locator("#sidebar-menu-root .sidebar-filter-menu").count()) === 0) {
    await page.locator("#sidebar-filter").click();
  }
  const menu = page.locator("#sidebar-menu-root .sidebar-filter-menu");
  await menu.waitFor({ state: "visible" });
  const sectionKeys = {
    Show: "status",
    Project: "project",
    "Last activity": "activity",
    "Group by": "group",
    "Sort by": "sort",
  };
  const row = menu.locator(
    `.sidebar-filter-row[data-sidebar-focus-key="menu:filter:${sectionKeys[section]}"]`,
  );
  if (!(await row.evaluate((element) => element.classList.contains("open")))) {
    await row.click();
  }
  const choice = menu.locator(".sidebar-filter-option").filter({
    hasText: new RegExp(`^${escapeRegExp(option)}\\s*✓?\\s*$`),
  });
  await choice.click();
  await page.waitForFunction(
    (key) =>
      document.activeElement instanceof HTMLElement &&
      document.activeElement.dataset.sidebarFocusKey === key,
    expectedFocusKey,
  );
  assertEqual(await choice.getAttribute("aria-checked"), "true", `${section}/${option} selected`);
}

async function closeFilterMenu(page) {
  if ((await page.locator("#sidebar-menu-root .sidebar-filter-menu").count()) > 0) {
    await page.locator("#sidebar-filter").click();
    await page.locator("#sidebar-menu-root .sidebar-filter-menu").waitFor({ state: "detached" });
  }
}

async function setReadingModeViaUi(page, mode) {
  const trigger = page.locator("#reading-settings");
  await trigger.click();
  const popover = page.locator(".reading-settings-popover");
  await popover.waitFor({ state: "visible" });
  await popover.getByRole("radio", { name: mode === "dark" ? "Dark" : "Light", exact: true }).click();
  await page.waitForFunction((value) => document.documentElement.dataset.mode === value, mode);
  await trigger.click();
  await popover.waitFor({ state: "detached" });
}

async function installFixedClock(page, nowMs) {
  await page.addInitScript((fixedNowMs) => {
    const NativeDate = Date;
    class FixedDate extends NativeDate {
      constructor(...args) {
        super(...(args.length === 0 ? [fixedNowMs] : args));
      }
    }
    FixedDate.now = () => fixedNowMs;
    globalThis.Date = FixedDate;
  }, nowMs);
}

async function installDeterministicVisualStyle(page) {
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

async function captureSidebar(page, name) {
  await page.mouse.move(1100, 700);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const fileName = `${name}.png`;
  await page.locator(".sidebar").screenshot({
    path: path.join(stagingDir, fileName),
    animations: "disabled",
  });
  screenshots.push(fileName);
}

function publishEvidence({ metadata }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const files = [...new Set(screenshots)].sort();
  if (files.length !== screenshots.length) {
    throw new Error("Duplicate disclosure screenshot name");
  }
  const published = [];
  for (const fileName of files) {
    const source = path.join(stagingDir, fileName);
    const target = path.join(outputDir, fileName);
    const temporary = `${target}.tmp-${process.pid}`;
    fs.copyFileSync(source, temporary);
    fs.renameSync(temporary, target);
    published.push({ name: fileName, sha256: sha256File(target) });
  }
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".png") && !files.includes(entry.name)) {
      fs.rmSync(path.join(outputDir, entry.name));
    }
  }
  const manifest = { ...metadata, files: published };
  const manifestPath = path.join(outputDir, "manifest.json");
  const temporaryManifest = `${manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryManifest, manifestPath);
  return manifest;
}

function fingerprintSourceFiles(root, relativePaths) {
  return relativePaths.map((relativePath) => ({
    path: relativePath,
    sha256: sha256File(path.join(root, relativePath)),
  }));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readGitHead(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function isolatedElectronEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SONATA_")) {
      delete env[key];
    }
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    ...env,
    ...overrides,
    SONATA_NOTIFICATIONS: "0",
    SONATA_LOCAL_API: "0",
    SONATA_INSTANCE_LABEL: "",
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
