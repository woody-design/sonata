import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { createSidebarFixture } from "./helpers/sidebar-fixture.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "../..");
const fixture = createSidebarFixture({
  projectSpecs: [{ slug: "hover", name: "Hover Project", count: 3 }],
  chatCount: 1,
  archivedChatCount: 0,
});
const [primary, secondary, untagged] = fixture.projects[0].sessions;
rewriteManifest(primary.id, {
  title: "Determining User Intent",
  tags: ["type.automation", "type.design", "type.bug", "type.coding", "type.research"],
});
rewriteManifest(secondary.id, { title: "Instant relocation", tags: ["priority.p0"] });
rewriteManifest(untagged.id, { title: "No tags here", tags: [] });

let electronApp = null;
const pageErrors = [];
try {
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
  const primaryRow = rowFor(page, primary.id);
  await primaryRow.waitFor({ state: "visible" });

  await moveAway(page);
  await primaryRow.hover();
  await page.waitForTimeout(450);
  assertEqual(await openCard(page).count(), 0, "card stays closed before the 500ms dwell");
  // The negative assertion above pins the 500ms lower bound. Electron can
  // briefly throttle renderer timers while the new window settles in CI, so
  // allow a wider delivery ceiling without weakening that dwell contract.
  await openCard(page).waitFor({ state: "visible", timeout: 10_000 });
  await assertContentAndPresentation(page);
  await assertRerenderSurvival(page);
  await assertInstantRelocation(page);
  await assertNoTagsAndDismissals(page);

  assertDeepEqual(pageErrors, [], "renderer page errors");
  console.log(
    "sidebar-hover-card: dwell/content + re-render survival + zero-cycle relocation + dismissal pass",
  );
} finally {
  try {
    await electronApp?.close();
  } finally {
    fixture.cleanup();
  }
}

async function assertContentAndPresentation(page) {
  const card = openCard(page);
  assertEqual(await card.getAttribute("data-task-id"), primary.id, "card owner is taskId-keyed");
  assertEqual(
    await card.locator(".sidebar-hover-card-title").textContent(),
    "Determining User Intent",
    "session name",
  );
  assertEqual(
    await card.locator(".sidebar-hover-card-folder-label").textContent(),
    "Hover Project",
    "folder row",
  );
  assertMatch(await card.locator("time").textContent(), /^(now|\d+[mhdwmoy]+)$/, "relative time");
  assertDeepEqual(
    await card.locator(".tag-chip").allTextContents(),
    ["Automation", "Design", "Bug", "Coding", "Research"],
    "tag strip follows persisted task tag order",
  );
  assertDeepEqual(
    await card.locator(".tag-chip").evaluateAll((chips) =>
      chips.map((chip) => chip.getAttribute("data-tag-color")),
    ),
    ["teal", "pink", "brown", "cyan", "purple"],
    "tag strip consumes persisted definition colors",
  );
  const presentation = await card.evaluate((element) => {
    const title = element.querySelector(".sidebar-hover-card-title");
    const time = element.querySelector("time");
    const folder = element.querySelector(".sidebar-hover-card-folder");
    const tags = element.querySelector(".sidebar-hover-card-tags");
    return {
      pointerEvents: getComputedStyle(element).pointerEvents,
      titleSize: title ? getComputedStyle(title).fontSize : null,
      timeSize: time ? getComputedStyle(time).fontSize : null,
      folderSize: folder ? getComputedStyle(folder).fontSize : null,
      tagWrap: tags ? getComputedStyle(tags).flexWrap : null,
      tagOverflow: tags ? getComputedStyle(tags).overflowX : null,
      chipEllipsis: tags?.firstElementChild
        ? getComputedStyle(tags.firstElementChild).textOverflow
        : null,
      animation: getComputedStyle(element).animationName,
      transition: getComputedStyle(element).transitionDuration,
    };
  });
  assertDeepEqual(
    presentation,
    {
      pointerEvents: "none",
      titleSize: "12px",
      timeSize: "11px",
      folderSize: "12px",
      tagWrap: "nowrap",
      tagOverflow: "hidden",
      chipEllipsis: "ellipsis",
      animation: "none",
      transition: "0s",
    },
    "display-only card uses ui-xs/sm tokens and a clipped single-line strip",
  );
  const appearance = await page.locator("html").evaluate((root) => {
    const card = document.querySelector("#sidebar-hover-card");
    const firstChip = card?.querySelector(".tag-chip");
    const snapshot = () => ({
      card: card ? getComputedStyle(card).backgroundColor : null,
      chipText: firstChip ? getComputedStyle(firstChip).color : null,
      chipSurface: firstChip ? getComputedStyle(firstChip).backgroundColor : null,
    });
    const originalMode = root.dataset.mode;
    root.dataset.mode = "light";
    const light = snapshot();
    root.dataset.mode = "dark";
    const dark = snapshot();
    if (originalMode === undefined) delete root.dataset.mode;
    else root.dataset.mode = originalMode;
    return { light, dark };
  });
  assertDeepEqual(
    appearance,
    {
      light: {
        card: "rgb(255, 255, 255)",
        chipText: "rgb(15, 138, 122)",
        chipSurface: "rgba(15, 138, 122, 0.12)",
      },
      dark: {
        card: "rgb(25, 25, 25)",
        chipText: "rgb(77, 185, 168)",
        chipSurface: "rgba(77, 185, 168, 0.18)",
      },
    },
    "card and persisted tag colors resolve through light/dark design tokens",
  );
  const row = rowFor(page, primary.id);
  assertEqual(
    await row.locator(".sidebar-session-button").getAttribute("title"),
    "Determining User Intent",
    "native title fallback applicability is unchanged",
  );
  assertEqual(await row.locator(".tag-chip").count(), 0, "session row itself still has no tags");
  const rowBox = await row.boundingBox();
  const cardBox = await card.boundingBox();
  assertEqual(Boolean(rowBox && cardBox), true, "row and card have geometry");
  assertEqual(cardBox.x >= 7.5, true, "card is left-clamped");
  assertEqual(cardBox.x + cardBox.width <= 1092.5, true, "card is right-clamped");
  assertEqual(cardBox.y >= 7.5, true, "card is top-clamped");
  assertEqual(cardBox.y + cardBox.height <= 752.5, true, "card is bottom-clamped");
}

async function assertRerenderSurvival(page) {
  await page.evaluate((taskId) => {
    const card = document.querySelector("#sidebar-hover-card");
    const row = document.querySelector(`.sidebar-session[data-task-id="${taskId}"]`);
    globalThis.__hoverFence = {
      card,
      row,
      detached: false,
      hidden: false,
      observer: new MutationObserver(() => {
        if (!card?.isConnected) globalThis.__hoverFence.detached = true;
        if (card?.hidden) globalThis.__hoverFence.hidden = true;
      }),
    };
    globalThis.__hoverFence.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
  }, primary.id);
  await page.evaluate(
    (taskId) => window.sonataRuntime.setSessionTags({ taskId, tagIds: ["type.design"] }),
    primary.id,
  );
  await page.waitForFunction((taskId) => {
    const current = document.querySelector(`.sidebar-session[data-task-id="${taskId}"]`);
    return current && current !== globalThis.__hoverFence?.row;
  }, primary.id);
  await page.waitForTimeout(50);
  const result = await page.evaluate(() => {
    const fence = globalThis.__hoverFence;
    fence?.observer.disconnect();
    const current = document.querySelector("#sidebar-hover-card");
    return {
      sameNode: current === fence?.card,
      detached: fence?.detached,
      hiddenDuringRebuild: fence?.hidden,
      hiddenNow: current?.hidden,
      taskId: current?.dataset.taskId,
      chips: Array.from(current?.querySelectorAll(".tag-chip") ?? [], (chip) => chip.textContent),
    };
  });
  assertDeepEqual(
    result,
    {
      sameNode: true,
      detached: false,
      hiddenDuringRebuild: false,
      hiddenNow: false,
      taskId: primary.id,
      chips: ["Design"],
    },
    "background sessions:updated rebuild preserves the open singleton and refreshes content",
  );
}

async function assertInstantRelocation(page) {
  const target = rowFor(page, secondary.id);
  const box = await target.boundingBox();
  assertEqual(Boolean(box), true, "relocation target has geometry");
  await page.evaluate(() => {
    const card = document.querySelector("#sidebar-hover-card");
    globalThis.__relocationFence = { card, hidden: false, detached: false };
    globalThis.__relocationObserver = new MutationObserver(() => {
      if (card?.hidden) globalThis.__relocationFence.hidden = true;
      if (!card?.isConnected) globalThis.__relocationFence.detached = true;
    });
    globalThis.__relocationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const result = await page.evaluate((taskId) => {
    globalThis.__relocationObserver?.disconnect();
    const fence = globalThis.__relocationFence;
    const card = document.querySelector("#sidebar-hover-card");
    return {
      sameNode: card === fence?.card,
      hidden: fence?.hidden,
      detached: fence?.detached,
      open: card?.hidden === false,
      taskId: card?.dataset.taskId,
      expected: taskId,
    };
  }, secondary.id);
  assertDeepEqual(
    result,
    {
      sameNode: true,
      hidden: false,
      detached: false,
      open: true,
      taskId: secondary.id,
      expected: secondary.id,
    },
    "row-to-row relocation is an immediate open→open content/position swap",
  );
}

async function assertNoTagsAndDismissals(page) {
  await rowFor(page, untagged.id).hover();
  const card = openCard(page);
  assertEqual(await card.getAttribute("data-task-id"), untagged.id, "open card relocates to untagged row");
  assertEqual(await card.locator(".sidebar-hover-card-tags").isHidden(), true, "no tags means no strip row");
  await moveAway(page);
  assertEqual(await openCard(page).count(), 0, "row unhover dismisses immediately");

  await rowFor(page, secondary.id).hover();
  assertEqual(await openCard(page).count(), 1, "warm window opens the next row immediately");
  await page.locator("#run-list").dispatchEvent("scroll");
  assertEqual(await openCard(page).count(), 1, "reading-pane scroll does not dismiss");
  await page.locator("#sidebar-sections").dispatchEvent("scroll");
  assertEqual(await openCard(page).count(), 0, "sidebar scroll dismisses");

  await moveAway(page);
  await rowFor(page, secondary.id).hover();
  await page.waitForTimeout(510);
  await openCard(page).waitFor({ state: "visible" });
  await rowFor(page, secondary.id).dispatchEvent("dragstart");
  assertEqual(await openCard(page).count(), 0, "drag dismisses");

  await moveAway(page);
  await rowFor(page, secondary.id).hover();
  await page.waitForTimeout(510);
  await openCard(page).waitFor({ state: "visible" });
  await rowFor(page, secondary.id).locator(".sidebar-row-hover-action").click();
  await page.locator("#sidebar-menu-root .sidebar-menu").waitFor({ state: "visible" });
  assertEqual(await openCard(page).count(), 0, "menu open dismisses");
}

function rowFor(page, taskId) {
  return page.locator(`.sidebar-session[data-task-id="${taskId}"]`);
}

function openCard(page) {
  return page.locator("#sidebar-hover-card:not([hidden])");
}

async function moveAway(page) {
  await page.mouse.move(1000, 700);
}

function rewriteManifest(taskId, patch) {
  const manifestPath = fixture.manifestPath(taskId);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  Object.assign(manifest.task, patch);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function isolatedElectronEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DUET_") || key.startsWith("SONATA_")) {
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

function assertMatch(actual, pattern, label) {
  if (typeof actual !== "string" || !pattern.test(actual)) {
    throw new Error(`${label}: expected ${pattern}, got ${JSON.stringify(actual)}`);
  }
}
