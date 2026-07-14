import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { createSidebarFixture } from "./helpers/sidebar-fixture.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "../..");
const viewport = { width: 1280, height: 800 };
const fixture = createSidebarFixture({
  projectSpecs: [
    { slug: "bull-hill", name: "Bull Hill", count: 4 },
    { slug: "second-project", name: "Second Project", count: 2 },
    { slug: "rebuild-project", name: "Rebuild Project", count: 6 },
  ],
  chatCount: 2,
  archivedChatCount: 0,
});
const evidenceDir = path.resolve(
  process.argv[2] ?? path.join(fixture.root, "hover-card-evidence"),
);
const evidenceFiles = [];
const now = fixture.fixedNowMs;
const day = 24 * 60 * 60_000;
const projectTasks = fixture.projects[0].sessions;
const [primaryTask, overflowTask, secondTask, absoluteTask] = projectTasks;
const looseTask = fixture.chats[0];
const [staleDisconnectedTask, staleIdentityTask] = fixture.projects[1].sessions;
const rebuildTask = fixture.projects[2].sessions[0];
const primaryTitle = "0714-研究 AI 剪视频工作流";
const overflowTitle = `0714-${"unbroken-session-title-".repeat(420)}`;

rewriteManifest(fixture, primaryTask.id, {
  title: primaryTitle,
  updatedAt: new Date(now - 2 * day).toISOString(),
});
rewriteManifest(fixture, overflowTask.id, {
  title: overflowTitle,
  updatedAt: new Date(now - 3 * day).toISOString(),
});
rewriteManifest(fixture, absoluteTask.id, {
  title: "0714-Older research",
  updatedAt: new Date(now - 8 * day).toISOString(),
});
rewriteManifest(fixture, looseTask.id, {
  title: "0714-bull-hill",
  updatedAt: new Date(now - 2 * day).toISOString(),
});

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
  await page.setViewportSize(viewport);
  await installFixedClock(page, fixture.fixedNowMs);
  await page.reload({ waitUntil: "domcontentloaded" });
  await rowFor(page, primaryTask.id).waitFor({ state: "visible" });
  await waitForSidebarStructureToSettle(page);

  await assertPointerIntentAndContent(page);
  await assertKeyboardAndDismissal(page);
  await assertFocusWithinOwnerRowKeepsCard(page);
  await assertFocusLeavingOwnerRowClosesCard(page);
  await assertSingleOwnerAndStaleTimer(page);
  await assertTimeProjectAndGeometry(page);
  await assertThemeAndMotionEvidence(page);
  await assertOverflowKeyboardHandoff(page);
  await assertMenuRenameCollapseAndRebuild(page);
  await assertDisconnectedPendingOwners(page);
  await assertSelectionAndWindowBlur(page);

  assertDeepEqual(pageErrors, [], "renderer page errors");
  publishHoverEvidence();
  console.log(
    `sidebar-hover-card: pointer, keyboard, a11y, dismissal, geometry, overflow, and ${evidenceFiles.length} visual contracts pass`,
  );
} finally {
  try {
    if (electronApp) {
      await electronApp.close();
    }
  } finally {
    fixture.cleanup();
  }
}

async function assertPointerIntentAndContent(page) {
  const row = rowFor(page, primaryTask.id);
  const button = row.locator(".sidebar-session-button");
  const before = await row.boundingBox();
  const sidebarBox = await page.locator("#sidebar").boundingBox();
  assertEqual(
    before.width <= sidebarBox.width,
    true,
    "pathological sibling title cannot widen ordinary Sidebar rows",
  );
  await moveAway(page);
  await row.hover();
  await page.waitForTimeout(300);
  assertEqual(await hoverCard(page).count(), 0, "pointer delay keeps card closed before 400ms");
  await moveAway(page);
  await page.waitForTimeout(300);
  assertEqual(await hoverCard(page).count(), 0, "leaving before delay cancels pending open");

  await row.hover();
  assertEqual(
    await row.evaluate((element) => element.matches(":hover")),
    true,
    "successful intent begins with the pointer still owning the row",
  );
  // Electron can defer renderer timers while the freshly launched window is
  // still settling under CI load. The negative assertion above pins the 400ms
  // lower bound; this upper bound only waits for eventual delivery.
  await hoverCard(page).waitFor({ state: "visible", timeout: 10_000 });
  const card = hoverCard(page);
  const tooltip = card.locator('[role="tooltip"]');
  assertEqual(await card.getAttribute("data-task-id"), primaryTask.id, "card owner task");
  assertEqual(await tooltip.locator(".sidebar-hover-card-title").textContent(), primaryTitle, "full title");
  assertEqual(await tooltip.locator(".sidebar-hover-card-project-label").textContent(), "Bull Hill", "project display name");
  assertEqual(await tooltip.locator("time").textContent(), "2d", "relative last activity");
  assertMatch(
    await tooltip.locator("time").getAttribute("aria-label"),
    /^Last active 2 days ago — 2030-01-13$/,
    "accessible relative activity includes full local date",
  );
  assertEqual(await button.getAttribute("title"), null, "native session tooltip removed");
  const describedBy = await button.getAttribute("aria-describedby");
  assertEqual(describedBy, await tooltip.getAttribute("id"), "row describes itself with tooltip content");
  assertEqual(await tooltip.getAttribute("role"), "tooltip", "tooltip semantic role");
  assertEqual(await card.getAttribute("tabindex"), null, "ordinary card is absent from tab order");
  assertEqual(
    await page.evaluate(() => document.activeElement?.classList.contains("sidebar-hover-card")),
    false,
    "pointer open never steals focus",
  );

  const after = await row.boundingBox();
  assertDeepEqual(after, before, "portaled card does not shift the Sidebar row");
  const initialCardBox = await card.boundingBox();
  assertEqual(
    initialCardBox.x >= after.x + after.width + 7.5,
    true,
    "card uses preferred-right placement when space is available",
  );
  await card.hover();
  await page.waitForTimeout(150);
  assertEqual(await card.count(), 1, "pointer may cross the portal gap without flicker");
  await moveAway(page);
  await page.waitForTimeout(50);
  assertEqual(await card.count(), 1, "close grace keeps the card briefly persistent");
  await card.waitFor({ state: "detached", timeout: 500 });
  assertEqual(await button.getAttribute("aria-describedby"), null, "description removed on close");
}

async function waitForSidebarStructureToSettle(page) {
  await page.locator("#sidebar-list").waitFor({ state: "visible" });
  await page.evaluate(() => new Promise((resolve, reject) => {
    const root = document.querySelector("#sidebar-list");
    if (!root) {
      reject(new Error("Sidebar list disappeared before hover-card verification."));
      return;
    }
    let quietTimer = 0;
    const finish = () => {
      window.clearTimeout(quietTimer);
      observer.disconnect();
      resolve(undefined);
    };
    const armQuietWindow = () => {
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(finish, 1_200);
    };
    const observer = new MutationObserver(armQuietWindow);
    observer.observe(root, { childList: true, subtree: true });
    armQuietWindow();
  }));
  assertEqual(
    await rowFor(page, primaryTask.id).evaluate((element) => element.isConnected),
    true,
    "initial hover owner remains connected after Sidebar startup settles",
  );
}

async function assertKeyboardAndDismissal(page) {
  const row = rowFor(page, primaryTask.id);
  const button = rowFor(page, primaryTask.id).locator(".sidebar-session-button");
  await page.locator("#sidebar-filter").focus();
  await button.focus();
  await hoverCard(page).waitFor({ state: "visible" });
  assertEqual(await button.evaluate((element) => element === document.activeElement), true, "focus open is immediate and retained");
  await row.hover();
  await moveAway(page);
  await page.waitForTimeout(150);
  assertEqual(await hoverCard(page).count(), 1, "pointer leave cannot close while the row still owns focus");
  await page.keyboard.press("Escape");
  await hoverCard(page).waitFor({ state: "detached" });
  assertEqual(await button.evaluate((element) => element === document.activeElement), true, "Escape keeps row focus");

  await page.locator("#sidebar-filter").focus();
  await button.focus();
  await hoverCard(page).waitFor({ state: "visible" });
  await rowFor(page, secondTask.id).hover();
  await page.waitForTimeout(500);
  assertEqual(
    await hoverCard(page).getAttribute("data-task-id"),
    primaryTask.id,
    "pointer cannot replace a card owned by keyboard focus",
  );
  assertEqual(
    await button.evaluate((element) => element === document.activeElement),
    true,
    "cross-row pointer movement preserves the focused owner",
  );
  await page.keyboard.press("Escape");
  await hoverCard(page).waitFor({ state: "detached" });
}

async function assertFocusWithinOwnerRowKeepsCard(page) {
  // §5.2 hoverable/persistent: focus moving WITHIN the owning row (session
  // button -> its own trailing menu button) keeps the card open. This is the
  // legitimate keep-open path the focus-leak guard must not break.
  const row = rowFor(page, primaryTask.id);
  const button = row.locator(".sidebar-session-button");
  const ownMenu = row.locator(".sidebar-row-hover-action");
  await moveAway(page);
  await page.locator("#sidebar-filter").focus();
  await button.focus();
  const card = hoverCard(page);
  await card.waitFor({ state: "visible" });
  assertEqual(await card.getAttribute("tabindex"), null, "owner card is on the plain non-overflow path");
  await page.keyboard.press("Tab");
  assertEqual(
    await ownMenu.evaluate((element) => element === document.activeElement),
    true,
    "Tab from the session button reaches the owning row's own trailing menu button",
  );
  assertEqual(await hoverCard(page).count(), 1, "focus staying within the owner row keeps its card open");
  assertEqual(await card.getAttribute("data-task-id"), primaryTask.id, "same owner keeps the same card");
  await page.keyboard.press("Escape");
  await card.waitFor({ state: "detached" });
}

async function assertFocusLeavingOwnerRowClosesCard(page) {
  // §5.2 focus-leaves-owner: a card owned by keyboard focus must close when
  // focus moves to ANOTHER row — including that row's trailing menu button,
  // which opens no card of its own. Regression guard for the unconditional
  // focusin cancel: a foreign row's focusin must not keep the stale card (and
  // its dangling aria-describedby) alive. A neighbour's menu button is
  // visibility:hidden until its row is hovered, so this leak only manifests
  // with mixed pointer+keyboard input; pure Shift+Tab lands on the neighbour's
  // session button, which hands the card off instead.
  const pair = await page.evaluate(() => {
    for (const container of document.querySelectorAll(".sidebar-disclosure-items")) {
      const rows = Array.from(container.querySelectorAll(":scope > .sidebar-session"))
        .map((element) => element.dataset.taskId)
        .filter(Boolean);
      if (rows.length >= 2) {
        return { prevId: rows[rows.length - 2], ownerId: rows[rows.length - 1] };
      }
    }
    return null;
  });
  assertEqual(Boolean(pair), true, "fixture provides two adjacent session rows in one container");
  const { prevId, ownerId } = pair;
  const ownerButton = rowFor(page, ownerId).locator(".sidebar-session-button");
  const prevMenu = rowFor(page, prevId).locator(".sidebar-row-hover-action");

  await moveAway(page);
  await page.locator("#sidebar-filter").focus();
  await ownerButton.focus();
  const card = hoverCard(page);
  await card.waitFor({ state: "visible" });
  assertEqual(await card.getAttribute("data-task-id"), ownerId, "keyboard focus owns the card");
  assertEqual(await card.getAttribute("tabindex"), null, "owner card is on the plain non-overflow path");

  // Reveal the previous row's trailing menu button without disturbing the
  // keyboard-owned card: a pointer merely passing over a neighbour is ignored
  // while keyboard ownership holds.
  await rowFor(page, prevId).hover();
  assertEqual(
    await card.getAttribute("data-task-id"),
    ownerId,
    "pointer over a neighbour cannot replace the keyboard-owned card",
  );

  await page.keyboard.press("Shift+Tab");
  await card.waitFor({ state: "detached" });
  assertEqual(
    await prevMenu.evaluate((element) => element === document.activeElement),
    true,
    "Shift+Tab moves focus to the previous row's trailing menu button",
  );
  assertEqual(await hoverCard(page).count(), 0, "focus leaving the owner row closes its card");
  assertEqual(
    await ownerButton.getAttribute("aria-describedby"),
    null,
    "the closed card leaves no dangling description on the former owner",
  );
  await page.locator("#sidebar-filter").focus();
  await moveAway(page);
}

async function assertSingleOwnerAndStaleTimer(page) {
  const first = rowFor(page, primaryTask.id);
  const second = rowFor(page, secondTask.id);
  await first.hover();
  await page.waitForTimeout(120);
  await second.hover();
  await hoverCard(page).waitFor({ state: "visible", timeout: 3_000 });
  assertEqual(await hoverCard(page).count(), 1, "only one card exists after rapid movement");
  assertEqual(await hoverCard(page).getAttribute("data-task-id"), secondTask.id, "stale first timer cannot win");
  await moveAway(page);
  await hoverCard(page).waitFor({ state: "detached" });
}

async function assertTimeProjectAndGeometry(page) {
  await rowFor(page, absoluteTask.id).hover();
  await hoverCard(page).waitFor({ state: "visible" });
  assertEqual(
    await hoverCard(page).locator("time").textContent(),
    "2030-01-07",
    "activity older than seven days uses full local date",
  );
  await moveAway(page);
  await hoverCard(page).waitFor({ state: "detached" });

  const looseRow = rowFor(page, looseTask.id);
  await looseRow.hover();
  await hoverCard(page).waitFor({ state: "visible", timeout: 3_000 });
  assertEqual(
    await hoverCard(page).locator(".sidebar-hover-card-project-label").textContent(),
    "Tasks",
    "project-less session never exposes its generated workspace slug",
  );
  await page.setViewportSize({ width: 500, height: 420 });
  await page.waitForTimeout(50);
  const box = await hoverCard(page).boundingBox();
  assertEqual(Boolean(box), true, "card has measurable geometry");
  assertEqual(box.x >= 7.5, true, "narrow card respects left margin");
  assertEqual(box.x + box.width <= 492.5, true, "narrow card respects right margin");
  assertEqual(box.y >= 7.5, true, "card respects top margin");
  assertEqual(box.y + box.height <= 412.5, true, "card respects bottom margin");
  // The visual matrix changes mode while the pointer remains near the narrow
  // card. Give the trigger explicit focus so both screenshots share a stable,
  // contract-owned card rather than racing pointer dismissal.
  await looseRow.locator(".sidebar-session-button").focus();
  await captureHoverEvidence(page, "narrow-light");
  await page.locator("html").evaluate((element) => { element.dataset.mode = "dark"; });
  await captureHoverEvidence(page, "narrow-dark");
  await page.locator("html").evaluate((element) => { element.dataset.mode = "light"; });
  await page.setViewportSize(viewport);
  // Moving a pointer-owned anchor legitimately starts the close grace. Give
  // this synthetic geometry probe explicit keyboard ownership so the card's
  // persistence is contractual rather than a race against that timer.
  await page.locator("#sidebar").evaluate((element) => {
    element.style.transform = "translateX(900px)";
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(50);
  const flippedRowBox = await looseRow.boundingBox();
  const flippedCardBox = await hoverCard(page).boundingBox();
  assertEqual(
    flippedCardBox.x + flippedCardBox.width <= flippedRowBox.x - 7.5,
    true,
    "card flips to the left when only the left side fits",
  );
  await page.locator("#sidebar").evaluate((element) => {
    element.style.removeProperty("transform");
    window.dispatchEvent(new Event("resize"));
  });
  await page.keyboard.press("Escape");
  await hoverCard(page).waitFor({ state: "detached" });
}

async function assertThemeAndMotionEvidence(page) {
  const root = page.locator("html");
  const original = await root.evaluate((element) => ({
    theme: element.dataset.theme,
    mode: element.dataset.mode,
  }));
  await root.evaluate((element) => {
    element.dataset.theme = "duet";
    element.dataset.mode = "light";
  });
  await page.locator("#sidebar-filter").focus();
  await rowFor(page, primaryTask.id).hover();
  const card = hoverCard(page);
  await card.waitFor({ state: "visible" });
  const light = await hoverCardChromeSnapshot(card);
  assertDeepEqual(
    light,
    {
      background: "rgb(255, 255, 255)",
      border: "rgb(229, 227, 224)",
      color: "rgb(52, 53, 54)",
      title: "rgb(36, 37, 38)",
    },
    "light hover card uses Sidebar chrome tokens",
  );
  await captureHoverEvidence(page, "normal-light");
  await root.evaluate((element) => {
    element.dataset.theme = "focus";
  });
  assertDeepEqual(
    await hoverCardChromeSnapshot(card),
    light,
    "reading theme cannot alter hover card chrome",
  );
  await root.evaluate((element) => {
    element.dataset.mode = "dark";
  });
  assertDeepEqual(
    await hoverCardChromeSnapshot(card),
    {
      background: "rgb(41, 41, 41)",
      border: "rgb(56, 56, 56)",
      color: "rgb(232, 232, 232)",
      title: "rgb(245, 245, 245)",
    },
    "dark hover card uses Sidebar chrome tokens",
  );
  await captureHoverEvidence(page, "normal-dark");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assertDeepEqual(
    await card.evaluate((element) => {
      const style = getComputedStyle(element);
      return { animation: style.animationName, transition: style.transitionDuration };
    }),
    { animation: "none", transition: "0s" },
    "reduced motion leaves the hover card motion-free",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await root.evaluate((element, value) => {
    if (value.theme === undefined) delete element.dataset.theme;
    else element.dataset.theme = value.theme;
    if (value.mode === undefined) delete element.dataset.mode;
    else element.dataset.mode = value.mode;
  }, original);
  await moveAway(page);
  await card.waitFor({ state: "detached" });
}

async function assertOverflowKeyboardHandoff(page) {
  const row = rowFor(page, overflowTask.id);
  const button = row.locator(".sidebar-session-button");
  const menu = row.locator(".sidebar-row-hover-action");
  await button.focus();
  const card = hoverCard(page);
  await card.waitFor({ state: "visible" });
  assertEqual(await card.getAttribute("role"), "region", "overflow card becomes a region");
  assertEqual(await card.getAttribute("aria-label"), "Session details", "overflow region named");
  assertEqual(await card.getAttribute("tabindex"), "0", "overflow card joins explicit Tab handoff");
  assertEqual(
    await card.locator(".sidebar-hover-card-title").textContent(),
    overflowTitle,
    "pathological title remains complete in the DOM",
  );

  await card.hover();
  const pointerScrollBefore = await card.evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, 280);
  await page.waitForTimeout(50);
  const pointerScrollAfter = await card.evaluate((element) => element.scrollTop);
  assertEqual(pointerScrollAfter > pointerScrollBefore, true, "overflow card supports pointer scrolling");
  await card.evaluate((element) => { element.scrollTop = 0; });

  await page.keyboard.press("Tab");
  assertEqual(await card.evaluate((element) => element === document.activeElement), true, "row Tab explicitly enters overflow scrollport");
  assertDeepEqual(
    await card.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        focusVisible: element.matches(":focus-visible"),
        color: style.outlineColor,
        style: style.outlineStyle,
        width: style.outlineWidth,
      };
    }),
    {
      focusVisible: true,
      color: "rgb(79, 119, 109)",
      style: "solid",
      width: "2px",
    },
    "keyboard-owned overflow card has a visible Sidebar focus ring",
  );
  const beforeScroll = await card.evaluate((element) => element.scrollTop);
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("ArrowDown");
  }
  await page.waitForTimeout(50);
  const afterScroll = await card.evaluate((element) => element.scrollTop);
  assertEqual(afterScroll > beforeScroll, true, "focused scrollport is keyboard-scrollable");

  await page.keyboard.press("Shift+Tab");
  assertEqual(await button.evaluate((element) => element === document.activeElement), true, "Shift+Tab returns to origin row");
  assertEqual(await card.count(), 1, "returning to the row keeps its card open");

  await page.keyboard.press("Tab");
  assertEqual(await card.evaluate((element) => element === document.activeElement), true, "handoff can be repeated");
  await page.keyboard.press("Escape");
  await card.waitFor({ state: "detached" });
  assertEqual(await button.evaluate((element) => element === document.activeElement), true, "Escape from scrollport restores origin");

  await page.locator("#sidebar-filter").focus();
  await button.focus();
  await hoverCard(page).waitFor({ state: "visible" });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await hoverCard(page).waitFor({ state: "detached" });
  assertEqual(await menu.evaluate((element) => element === document.activeElement), true, "forward Tab exits to semantic next row control");

  await button.focus();
  await hoverCard(page).waitFor({ state: "visible" });
  await page.keyboard.press("Tab");
  await row.evaluate((element) => element.remove());
  await page.keyboard.press("Escape");
  await hoverCard(page).waitFor({ state: "detached" });
  assertEqual(
    await page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLElement && active.isConnected && Boolean(active.dataset.sidebarFocusKey);
    }),
    true,
    "disconnected overflow owner falls back to a connected semantic Sidebar target",
  );
}

async function assertMenuRenameCollapseAndRebuild(page) {
  const row = rowFor(page, primaryTask.id);
  const button = row.locator(".sidebar-session-button");
  await button.focus();
  await hoverCard(page).waitFor({ state: "visible" });
  await row.locator(".sidebar-row-hover-action").click();
  await hoverCard(page).waitFor({ state: "detached" });
  const menu = page.locator("#sidebar-menu-root .sidebar-menu");
  await menu.waitFor({ state: "visible" });
  await menu.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const renameInput = row.locator(".sidebar-rename-input");
  await renameInput.waitFor({ state: "visible" });
  assertEqual(await hoverCard(page).count(), 0, "rename mode suppresses the card");
  await renameInput.press("Escape");
  await row.locator(".sidebar-session-button").waitFor({ state: "visible" });

  await row.locator(".sidebar-session-button").focus();
  await hoverCard(page).waitFor({ state: "visible" });
  await page.locator("#sidebar-filter").click();
  await hoverCard(page).waitFor({ state: "detached" });
  await page.locator("#sidebar-filter").click();

  await rowFor(page, rebuildTask.id).hover();
  await hoverCard(page).waitFor({ state: "visible" });
  const project = rowFor(page, rebuildTask.id).locator("xpath=ancestor::div[contains(@class, 'sidebar-project')]");
  const beforeCount = await project.locator(".sidebar-session").count();
  await project.locator(".sidebar-disclosure-local").evaluate((element) => element.click());
  await hoverCard(page).waitFor({ state: "detached" });
  await page.waitForFunction(
    ({ taskId, count }) => {
      const row = document.querySelector(`.sidebar-session[data-task-id="${taskId}"]`);
      const owner = row?.closest(".sidebar-project");
      return owner !== null && owner.querySelectorAll(".sidebar-session").length > count;
    },
    { taskId: rebuildTask.id, count: beforeCount },
  );

  await rowFor(page, primaryTask.id).locator(".sidebar-session-button").focus();
  await hoverCard(page).waitFor({ state: "visible" });
  await page.locator("#sidebar-collapse").click();
  await hoverCard(page).waitFor({ state: "detached" });
  assertEqual(await page.locator("#sidebar").evaluate((element) => element.classList.contains("collapsed")), true, "collapse dismisses card");
  await page.locator("#sidebar-toggle").click();
  await rowFor(page, primaryTask.id).waitFor({ state: "visible" });
}

async function assertDisconnectedPendingOwners(page) {
  const disconnected = rowFor(page, staleDisconnectedTask.id);
  await disconnected.hover();
  await page.waitForTimeout(200);
  await disconnected.evaluate((element) => {
    const inertReplacement = document.createElement("div");
    inertReplacement.style.height = `${element.getBoundingClientRect().height}px`;
    element.replaceWith(inertReplacement);
  });
  await page.waitForTimeout(300);
  assertEqual(await hoverCard(page).count(), 0, "detached pending owner cannot open stale content");
  await moveAway(page);

  const identityChanged = rowFor(page, staleIdentityTask.id);
  await identityChanged.hover();
  await page.waitForTimeout(200);
  await identityChanged.evaluate((element) => { element.dataset.taskId = "recycled-owner"; });
  await page.waitForTimeout(300);
  assertEqual(await hoverCard(page).count(), 0, "recycled row identity cannot open stale content");
  await moveAway(page);
}

async function assertSelectionAndWindowBlur(page) {
  const button = rowFor(page, secondTask.id).locator(".sidebar-session-button");
  await button.focus();
  await hoverCard(page).waitFor({ state: "visible" });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await hoverCard(page).waitFor({ state: "detached" });

  await page.locator("#sidebar-filter").focus();
  await button.focus();
  await hoverCard(page).waitFor({ state: "visible" });
  await button.click();
  await hoverCard(page).waitFor({ state: "detached" });
}

function rowFor(page, taskId) {
  return page.locator(`.sidebar-session[data-task-id="${taskId}"]`);
}

function hoverCard(page) {
  return page.locator("#sidebar-hover-card-root > .sidebar-hover-card");
}

async function hoverCardChromeSnapshot(card) {
  return card.evaluate((element) => {
    const style = getComputedStyle(element);
    const title = element.querySelector(".sidebar-hover-card-title");
    return {
      background: style.backgroundColor,
      border: style.borderTopColor,
      color: style.color,
      title: title ? getComputedStyle(title).color : null,
    };
  });
}

async function captureHoverEvidence(page, name) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  await hoverCard(page).waitFor({ state: "visible" });
  const fileName = `${name}.png`;
  await page.screenshot({
    path: path.join(evidenceDir, fileName),
    animations: "disabled",
  });
  evidenceFiles.push(fileName);
}

function publishHoverEvidence() {
  assertDeepEqual(
    [...evidenceFiles].sort(),
    ["narrow-dark.png", "narrow-light.png", "normal-dark.png", "normal-light.png"],
    "exact hover visual matrix",
  );
  const files = evidenceFiles.map((name) => ({
    name,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(evidenceDir, name))).digest("hex"),
  }));
  fs.writeFileSync(
    path.join(evidenceDir, "manifest.json"),
    `${JSON.stringify({
      generatedAt: new Date(fixture.fixedNowMs).toISOString(),
      fixedNow: fixture.fixedNowIso,
      matrix: { widths: ["normal", "narrow"], modes: ["light", "dark"] },
      files,
    }, null, 2)}\n`,
    "utf8",
  );
}

async function moveAway(page) {
  await page.mouse.move(1100, 700);
}

function rewriteManifest(sidebarFixture, taskId, patch) {
  const manifestPath = sidebarFixture.manifestPath(taskId);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  Object.assign(manifest.task, patch);
  if (patch.updatedAt) {
    manifest.generatedAt = patch.updatedAt;
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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

function isolatedElectronEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DUET_")) {
      delete env[key];
    }
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    ...env,
    ...overrides,
    DUET_NOTIFICATIONS: "0",
    DUET_LOCAL_API: "0",
    DUET_INSTANCE_LABEL: "",
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
