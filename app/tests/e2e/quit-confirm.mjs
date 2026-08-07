// Focus/Flow S4 — the quit / last-window confirmation (D5), against the built
// app with a fake `claude` on PATH and a real, live session behind the dialog.
//
// D5 rules that Sonata asks before it takes your sessions away, and that it asks
// the SAME question for the two gestures that take them: ⌘Q, and closing the
// last remaining window (`window-all-closed` → `runtimeController.dispose()`).
// There is one principled exception — a quit with NO windows open, where the
// runtimes are already gone and there is nothing left to protect.
//
// Phase 1 (main window only) drives the branded renderer dialog:
//   ⌘Q asks · the copy is exactly the approved copy · the caret lands on the
//   default button · Esc cancels and the session survives, composer and all ·
//   the dialog is the TOP of the Escape ladder (above the Settings overlay) ·
//   Cancel cancels · the last-window close asks the same question · confirming
//   it closes the window and leaves the app ALIVE in the dock (D5: macOS
//   default behavior unchanged) · and a ⌘Q with zero windows quits WITHOUT
//   asking.
//
// Phase 2 (CLI window last) drives the native fallback: closing the main window
// while the CLI window is open asks NOTHING (a satellite close is not at stake),
// and closing the CLI window — the last one, with no Sonata dialog surface of
// its own — raises `dialog.showMessageBox` carrying the SAME words the renderer
// drew in phase 1.
//
// Phase 3 covers the second trigger of review 1's blocking finding: a window
// whose RENDERER has already crashed still has a live BrowserWindow, so the
// guard used to pick the branded dialog and push into a dead frame. It must fall
// through to the native message box instead — and must not wedge afterwards.
//
// Phase 4 guards the guard's OTHER half — the routes that deliberately do not
// pass it. `app.quit()` (a Dock quit, a macOS logout, `quitAndInstall()`, and
// this harness's own `electronApp.close()`) must remain an honest "terminate
// now" EVEN WITH the confirmation on screen. It regressed exactly once, during
// this slice: `settle` read `.webContents` off a window that `closed` had
// already destroyed, the throw escaped into Electron's own teardown, and the app
// hung with zero windows and no way out (MEASURED: `close()` still pending after
// 30s; 138ms once fixed). A wedged quit is the worst failure a quit guard can
// have, so it gets its own phase.
//
// Phase 1 also carries the two other review-1 findings: the ⌘R reload that used
// to orphan the ask permanently (4c), and the focus trap that keeps the modal
// modal (4b).
//
// Fixture provenance:
//   - the fake CLI: COMPOSED — the session species from tests/e2e/helpers/
//     fake-cli.mjs (probe arms + idle prompt so the boot latch opens), echoing
//     stdin so a send earns its pty-composer-echo receipt instead of waiting out
//     the 45s timeout. No status ticker: this fence needs a live session, not a
//     turn held open.
//   - `dialog.showMessageBox`: MEASURED at the seam — phase 2 replaces the real
//     one from the test (the technique tests/e2e/preview-routing.mjs uses for
//     `shell.openPath`/`openExternal`) and records the options main passed it,
//     so the fallback's copy is read off the actual call rather than restated.
//   - the expected copy: MEASURED from the app's own pure spec
//     (dist/main/quit-guard.js) rather than typed in again here — a fence that
//     restates the strings would pass against a build whose two surfaces had
//     quietly drifted apart.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";
import { fakeCliSource } from "./helpers/fake-cli.mjs";

const require = createRequire(import.meta.url);
const { buildQuitDialog } = require("../../dist/main/quit-guard");
const SPEC = buildQuitDialog();
const CONFIRM_LABEL = SPEC.buttons[SPEC.confirmButtonId];
const CANCEL_LABEL = SPEC.buttons[SPEC.cancelId];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-quit-confirm-"));
const dataRoot = path.join(root, "data-root");
const fakeBin = path.join(root, "bin");
const project = path.join(root, "project");
for (const dir of [fakeBin, project]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(fakeBin, "claude"), fakeCliSource("claude", { echoStdin: true }), {
  mode: 0o755,
});
fs.chmodSync(path.join(fakeBin, "claude"), 0o755);

const checks = {};
const evidence = {};
let app = null;

try {
  // ══ Phase 1 — the branded dialog, main window only ═════════════════════════
  const settingsDir = freshSettingsDir("phase1", { terminalOpen: false });
  app = await launch(settingsDir);
  const main = await app.firstWindow();
  main.setDefaultTimeout(20_000);
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  await chooseProject(main);
  assert.equal(await windowCount(), 1, "phase 1 runs with the main window as the only window");

  // A real session behind the dialog: this is what the question is ABOUT.
  await main.locator("#prompt-input").fill("keep this session alive");
  await main.keyboard.press("Enter");
  await main.locator(".turn-card").first().waitFor({ state: "visible" });

  // The menu item is Sonata's own, and it owns ⌘Q. Asserted as DATA because a
  // renderer-side key press cannot reach the macOS application menu: if this
  // binding were lost, ⌘Q would silently do nothing at all.
  evidence.quitMenuItem = await readQuitMenuItem();
  checks.quitAcceleratorIsBound =
    evidence.quitMenuItem.exists &&
    evidence.quitMenuItem.accelerator === "CmdOrCtrl+Q" &&
    // Not the stock role: `{ role: "quit" }` reaches `app.quit()` with no ask.
    evidence.quitMenuItem.role === null &&
    // …and nothing on screen moved: the label is the role's own wording.
    // (`app.name` is the productName in a packaged build — "Quit Sonata" — and
    // the electron binary's name in a dev launch, exactly as the role behaved.)
    evidence.quitMenuItem.label === evidence.quitMenuItem.expectedLabel;

  // (1) ⌘Q asks — regardless of liveness, and this session IS live.
  await clickQuitMenuItem();
  await main.locator(".quit-confirm-dialog").waitFor({ state: "visible" });
  evidence.dialog = await readDialog(main);
  checks.dialogCopyIsApproved =
    evidence.dialog.title === SPEC.title &&
    evidence.dialog.body === SPEC.body &&
    evidence.dialog.confirmLabel === CONFIRM_LABEL &&
    evidence.dialog.cancelLabel === CANCEL_LABEL;
  // Vertical alert stack (D5): mark, title, body, primary CTA over cancel.
  checks.dialogIsTheApprovedStack =
    evidence.dialog.childOrder.join(",") ===
      "svg.sonata-mark,h2.quit-confirm-title,p.quit-confirm-body,div.quit-confirm-actions" &&
    evidence.dialog.actionOrder.join(",") === "primary,secondary" &&
    evidence.dialog.role === "dialog" &&
    evidence.dialog.ariaModal === "true";
  // The caret opens on the DIALOG, not on a button (Woody's visual pass): a
  // macOS default button says "Return does this" with its fill, and a focus ring
  // around it at open reads as something the user already tabbed to.
  checks.focusOpensOnDialogNotAButton = evidence.dialog.focusOwner === "dialog";

  // (2) Esc cancels, and the app is untouched underneath — the session is still
  // live and the composer still takes a keystroke.
  await main.keyboard.press("Escape");
  await main.locator(".quit-confirm-dialog").waitFor({ state: "detached" });
  await main.locator("#prompt-input").click();
  await main.locator("#prompt-input").fill("still typing after cancel");
  evidence.afterCancel = {
    windows: await windowCount(),
    composerValue: await main.locator("#prompt-input").inputValue(),
    turnCards: await main.locator(".turn-card").count(),
    sessionLive: await main.locator("#send-prompt").isEnabled(),
  };
  checks.cancelLeavesTheAppRunning =
    evidence.afterCancel.windows === 1 &&
    evidence.afterCancel.composerValue === "still typing after cancel" &&
    evidence.afterCancel.turnCards >= 1 &&
    evidence.afterCancel.sessionLive;
  await main.locator("#prompt-input").fill("");

  // (3) The Escape ladder: the quit dialog is the TOP rung. With the Settings
  // overlay open beneath it, Esc must answer the quit — not close Settings.
  await openSettingsFromMenu();
  await main.locator(".settings-window").waitFor({ state: "visible" });
  await clickQuitMenuItem();
  await main.locator(".quit-confirm-dialog").waitFor({ state: "visible" });
  const settingsStillOpenWhileAsking = await main.locator(".settings-window").isVisible();
  await main.keyboard.press("Escape");
  await main.locator(".quit-confirm-dialog").waitFor({ state: "detached" });
  const settingsSurvivedTheCancel = await main.locator(".settings-window").isVisible();
  await main.keyboard.press("Escape");
  await main.locator(".settings-window").waitFor({ state: "hidden" });
  evidence.escapeLadder = { settingsStillOpenWhileAsking, settingsSurvivedTheCancel };
  checks.quitDialogOutranksSettingsOnEscape =
    settingsStillOpenWhileAsking && settingsSurvivedTheCancel;

  // (4) The Cancel button is the same answer as Esc.
  await clickQuitMenuItem();
  await main.locator(".quit-confirm-dialog").waitFor({ state: "visible" });
  await main.locator(".quit-confirm-actions .secondary").click();
  await main.locator(".quit-confirm-dialog").waitFor({ state: "detached" });
  checks.cancelButtonCancels = (await windowCount()) === 1;

  // (4b) MODALITY: focus cannot rest outside the dialog across a render (review
  // 1, minor 2). The real thief was `updateDrawerActive` handing the caret to the
  // composer when a blocking drawer resolves — but the INVARIANT is what matters,
  // so this steals the caret directly and then forces a full render (opening
  // Settings is the harness's cheapest one, and it also re-focuses its own dialog
  // AFTER render — a second, independent thief). Both must lose.
  await clickQuitMenuItem();
  await main.locator(".quit-confirm-dialog").waitFor({ state: "visible" });
  // Two thefts, two mechanisms. The first is a bare `.focus()` on the composer —
  // the shape `updateDrawerActive` uses — read back in the SAME tick, because the
  // trap is `focusin` and therefore repels it synchronously rather than waiting
  // for a render to repair it. The second rides a full render AND a post-render
  // grab (openSettingsOverlay focuses its own dialog after render() returns), so
  // it would defeat any render-time-only defense.
  const afterDirectTheft = await main.evaluate(() => {
    document.getElementById("prompt-input")?.focus();
    const dialog = document.querySelector(".quit-confirm-dialog");
    const active = document.activeElement;
    if (!dialog || !active) {
      return null;
    }
    if (!dialog.contains(active)) {
      return `escaped:${active.id || active.className || active.tagName}`;
    }
    if (active === dialog) {
      return "dialog";
    }
    return active.classList.contains("primary") ? "primary" : "secondary";
  });
  await openSettingsFromMenu();
  await main.locator(".settings-window").waitFor({ state: "visible" });
  evidence.focusDefense = {
    afterDirectTheft,
    afterRenderTheft: await readDialogFocusOwner(main),
  };
  // Both must lose. Without the trap the first reads `escaped:prompt-input` and
  // the second `escaped:settings-window` — which is what the bite proof shows.
  checks.focusCannotRestOutsideTheModal =
    afterDirectTheft === "dialog" && evidence.focusDefense.afterRenderTheft === "dialog";
  await main.keyboard.press("Escape");
  await main.locator(".quit-confirm-dialog").waitFor({ state: "detached" });
  await main.keyboard.press("Escape");
  await main.locator(".settings-window").waitFor({ state: "hidden" });

  // (4c) THE WEDGE (review 1, blocking 1): ⌘R replaces the document under the
  // dialog. That emits neither `closed` nor `render-process-gone`, so before the
  // fix the ask never settled, `quitAskInFlight` stayed true for the life of the
  // process, and from then on every ⌘Q was ignored and every last-window close
  // was preventDefault'd — an app that cannot be quit or closed from inside.
  // The guard must re-arm: the next ⌘Q has to ASK again.
  await clickQuitMenuItem();
  await main.locator(".quit-confirm-dialog").waitFor({ state: "visible" });
  await reloadMainWindow();
  await main.locator("#prompt-input").waitFor({ state: "visible" });
  const dialogSurvivedReload = await main.locator(".quit-confirm-dialog").count();
  await clickQuitMenuItem();
  // The whole finding in one wait: on the broken build this dialog never comes.
  const rearmed = await main
    .locator(".quit-confirm-dialog")
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  evidence.rendererReload = { dialogSurvivedReload, rearmed };
  checks.quitGuardRearmsAfterRendererReload = dialogSurvivedReload === 0 && rearmed;
  if (rearmed) {
    await main.locator(".quit-confirm-actions .secondary").click();
    await main.locator(".quit-confirm-dialog").waitFor({ state: "detached" });
  }

  // (5) Closing the LAST window asks the same question (D5) — that path kills
  // every PTY too. Cancelling keeps the window.
  // It doubles as the other half of (4c): a wedged guard would preventDefault
  // this close forever, so reaching the dialog at all proves the guard re-armed
  // on BOTH paths, not just the quit one.
  await closeWindow("Sonata");
  await main.locator(".quit-confirm-dialog").waitFor({ state: "visible" });
  evidence.lastWindowDialog = await readDialog(main);
  // Tab is the ONLY way a focus ring should ever appear on these buttons, and it
  // must still reach them from the container the dialog now opens on.
  await main.keyboard.press("Tab");
  evidence.tabRevealsTheRing = await readDialogFocusOwner(main);
  checks.tabMovesFocusOntoTheButtons = evidence.tabRevealsTheRing === "primary";
  await main.locator(".quit-confirm-actions .secondary").click();
  await main.locator(".quit-confirm-dialog").waitFor({ state: "detached" });
  checks.lastWindowCloseAsksTheSameQuestion =
    evidence.lastWindowDialog.title === SPEC.title &&
    evidence.lastWindowDialog.body === SPEC.body &&
    evidence.lastWindowDialog.confirmLabel === CONFIRM_LABEL;
  checks.cancelledCloseKeepsTheWindow = (await windowCount()) === 1;

  // (6) Confirming it closes the window and leaves the app ALIVE — macOS default
  // behavior, unchanged (D5): Sonata stays in the dock with no windows.
  //
  // Confirmed with RETURN, which is the path the visual pass made newly risky:
  // the caret is on the container now, so Return only still works because the
  // handler lives on the dialog rather than on the button it used to focus.
  await closeWindow("Sonata");
  await main.locator(".quit-confirm-dialog").waitFor({ state: "visible" });
  evidence.focusBeforeReturn = await readDialogFocusOwner(main);
  // A SUCCESSFUL Return destroys the very page the keystroke was sent to, so the
  // call's own round-trip loses its target. The window count below is the real
  // assertion; the gesture landing is not something the transport can report.
  await main.keyboard.press("Enter").catch(() => {});
  await waitFor(async () => (await windowCount()) === 0, "the confirmed last window to close");
  evidence.afterConfirmedClose = { windows: await windowCount(), appAlive: await appIsAlive() };
  checks.returnConfirmsFromTheContainer =
    evidence.focusBeforeReturn === "dialog" && evidence.afterConfirmedClose.windows === 0;
  checks.confirmedCloseLeavesAppInTheDock =
    evidence.afterConfirmedClose.windows === 0 && evidence.afterConfirmedClose.appAlive;

  // (6b) The other half of D5's dock ruling, and the primary CTA's click path.
  // `activate` is what a dock-icon click raises; the window comes back, and
  // closing it asks again — confirmed this time by CLICKING "Close Sonata", so
  // both confirm gestures are covered.
  await raiseFromDock();
  await waitFor(async () => (await windowCount()) === 1, "the dock click to reopen a window");
  const reopened = await app.firstWindow();
  reopened.setDefaultTimeout(20_000);
  await closeWindow("Sonata");
  await reopened.locator(".quit-confirm-dialog").waitFor({ state: "visible" });
  await reopened.locator(".quit-confirm-actions .primary").click().catch(() => {});
  await waitFor(async () => (await windowCount()) === 0, "the primary-click close");
  checks.dockReopenAndPrimaryClickClose = (await windowCount()) === 0 && (await appIsAlive());

  // (7) …and NOW ⌘Q quits without asking: the runtimes are already disposed, so
  // D5's one exception applies. If it asked, nothing could answer and the app
  // would never come down — which is exactly what this waits to disprove.
  const exited = whenAppExits(app);
  await clickQuitMenuItem().catch(() => {});
  checks.zeroWindowQuitDoesNotAsk = await exited;
  // Only a handle whose app actually EXITED may be dropped. Nulling a live one
  // orphans a running Electron whose child handle holds this process open long
  // after the verdict prints — the S4-D18 defect, and this is the failure path
  // where it would bite (the check being false means the app is still up).
  await releaseApp(checks.zeroWindowQuitDoesNotAsk);

  // ══ Phase 2 — the native fallback, CLI window last ═════════════════════════
  const settingsDir2 = freshSettingsDir("phase2", { terminalOpen: true });
  app = await launch(settingsDir2);
  const main2 = await app.firstWindow();
  main2.setDefaultTimeout(20_000);
  await main2.locator(".task-entry-panel").waitFor({ state: "visible" });
  await waitFor(async () => (await windowCount()) === 2, "the CLI window to open beside the main one");
  await stubNativeDialog(SPEC.cancelId);

  // A satellite close is never at stake — the runtimes outlive it — so closing
  // the main window while the CLI window is open must ask NOTHING.
  await closeWindow("Sonata");
  await waitFor(async () => (await windowCount()) === 1, "the main window to close unguarded");
  evidence.satelliteClose = { calls: await nativeDialogCalls(), windows: await windowCount() };
  checks.nonLastWindowCloseIsUnguarded =
    evidence.satelliteClose.calls.length === 0 && evidence.satelliteClose.windows === 1;

  // The CLI window is now the last one, and it has no Sonata dialog surface of
  // its own → native fallback, same words. Answering Cancel keeps it.
  await closeWindow("Sonata CLI");
  await waitFor(async () => (await nativeDialogCalls()).length === 1, "the native fallback dialog");
  const [nativeCall] = await nativeDialogCalls();
  evidence.nativeCall = nativeCall;
  checks.nativeFallbackCarriesTheSameCopy =
    nativeCall.message === SPEC.title &&
    nativeCall.detail === SPEC.body &&
    nativeCall.buttons.join(",") === SPEC.buttons.join(",") &&
    nativeCall.defaultId === SPEC.defaultId &&
    nativeCall.cancelId === SPEC.cancelId;
  // Parented to the window being closed, so it opens as that window's sheet.
  checks.nativeFallbackIsParented = nativeCall.ownerTitle === "Sonata CLI";
  await new Promise((resolve) => setTimeout(resolve, 500));
  checks.nativeCancelKeepsTheWindow = (await windowCount()) === 1;

  // …and answering "Close Sonata" closes it, exactly as the renderer dialog's
  // primary does.
  await stubNativeDialog(SPEC.confirmButtonId);
  await closeWindow("Sonata CLI");
  await waitFor(async () => (await windowCount()) === 0, "the confirmed CLI-window close");
  evidence.afterNativeConfirm = { windows: 0, appAlive: await appIsAlive() };
  checks.nativeConfirmClosesTheWindow = evidence.afterNativeConfirm.appAlive;
  // Close it EXPLICITLY before phase 3 overwrites the handle. That the app is
  // still alive with zero windows is the D5 behavior just asserted — so simply
  // dropping the reference would orphan a running Electron whose child handle
  // keeps THIS process alive after the verdict prints (MEASURED: the run
  // reported all 17 checks and then sat for 33 minutes). The `finally` only ever
  // closes the LAST handle; every earlier phase has to close its own.
  await app.close().catch(() => {});
  app = null;

  // ══ Phase 3 — a CRASHED renderer falls through to the native fallback ══════
  // The second trigger of review 1's blocking finding: `mainWindowCanAsk` used
  // to test only `isDestroyed()`, so a window whose renderer had already died
  // still won the "draw it yourself" branch — and `webContents.send` into a dead
  // frame is swallowed silently, wedging the guard exactly as the reload did.
  // The main window is alive and IS the only window here, so the branded dialog
  // is what the guard would pick if it could; it must pick native instead.
  const settingsDir3 = freshSettingsDir("phase3", { terminalOpen: false });
  app = await launch(settingsDir3);
  const main3 = await app.firstWindow();
  main3.setDefaultTimeout(20_000);
  await main3.locator(".task-entry-panel").waitFor({ state: "visible" });
  await stubNativeDialog(SPEC.cancelId);
  await crashMainRenderer();
  await waitFor(async () => await mainRendererIsCrashed(), "the renderer to be crashed");
  await clickQuitMenuItem();
  const crashedAsk = await waitFor(
    async () => (await nativeDialogCalls()).length === 1,
    "the native fallback after a renderer crash",
  ).then(
    () => true,
    () => false,
  );
  evidence.crashedRendererCall = (await nativeDialogCalls())[0] ?? null;
  checks.crashedRendererFallsBackToNative =
    crashedAsk &&
    evidence.crashedRendererCall?.message === SPEC.title &&
    evidence.crashedRendererCall?.detail === SPEC.body;
  // Answered Cancel, so the app is still here — and the guard is NOT wedged: a
  // second request must ask again rather than being swallowed as "already asking".
  await clickQuitMenuItem();
  checks.crashedRendererGuardDoesNotWedge = await waitFor(
    async () => (await nativeDialogCalls()).length === 2,
    "a second ask after the crashed-renderer cancel",
  ).then(
    () => true,
    () => false,
  );
  await app.close().catch(() => {});
  app = null;

  // ══ Phase 4 — `app.quit()` still quits, with the dialog on screen ══════════
  const settingsDir4 = freshSettingsDir("phase4", { terminalOpen: false });
  app = await launch(settingsDir4);
  const main4 = await app.firstWindow();
  main4.setDefaultTimeout(20_000);
  await main4.locator(".task-entry-panel").waitFor({ state: "visible" });
  await clickQuitMenuItem();
  await main4.locator(".quit-confirm-dialog").waitFor({ state: "visible" });
  const exitedWithDialogUp = whenAppExits(app);
  // NOT the menu item: the raw `app.quit()` every non-gesture route reaches.
  await app.evaluate(({ app: electronApp }) => {
    setTimeout(() => electronApp.quit(), 0);
  });
  checks.appQuitStillQuitsWithTheDialogUp = await exitedWithDialogUp;
  await releaseApp(checks.appQuitStillQuitsWithTheDialogUp);

  const success = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ success, checks, evidence }, null, 2));
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error(error);
  console.log(JSON.stringify({ success: false, checks, evidence }, null, 2));
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}

// ── Harness ─────────────────────────────────────────────────────────────────

/** A settings dir seeded with the CLI window's open preference — the whole point
 *  of the two phases is which window ends up being the last one. */
function freshSettingsDir(name, { terminalOpen }) {
  const dir = path.join(root, `settings-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "terminal-window-settings.json"),
    `${JSON.stringify({ open: terminalOpen }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "claude-settings.json"),
    `${JSON.stringify({ defaultPermissionMode: "default", defaultRemoteControl: false }, null, 2)}\n`,
  );
  return dir;
}

function launch(settingsDir) {
  return electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: dataRoot,
      SONATA_WORKSPACES_DIR: path.join(root, "workspaces"),
      SONATA_SETTINGS_DIR: settingsDir,
      SONATA_TEST_PICK_FOLDER: project,
      SONATA_NOTIFICATIONS: "0",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
}

async function chooseProject(page) {
  await page.locator("#project-chip").click();
  await page.locator("#entry-choose-folder").click();
  await page
    .locator("#project-chip", { hasText: path.basename(project) })
    .waitFor({ state: "visible" });
}

function windowCount() {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length,
  );
}

/** The main process answering at all is the app being alive. */
function appIsAlive() {
  return app.evaluate(({ app: electronApp }) => electronApp.isReady()).catch(() => false);
}

function readQuitMenuItem() {
  return app.evaluate(({ Menu, app: electronApp }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("quit");
    return item
      ? {
          exists: true,
          label: item.label,
          expectedLabel: `Quit ${electronApp.name}`,
          accelerator: item.accelerator,
          role: item.role ?? null,
        }
      : { exists: false };
  });
}

/** The path ⌘Q takes: the accelerator fires this item's click handler, and a
 *  renderer key press cannot reach the macOS application menu. */
function clickQuitMenuItem() {
  return app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("quit");
    if (!item) {
      throw new Error("Quit menu item is missing from the application menu.");
    }
    item.click();
  });
}

function openSettingsFromMenu() {
  return app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("settings")?.click();
  });
}

/** The traffic-light / ⌘W gesture, from the main process — `close()` is what
 *  both of them reach. */
function closeWindow(title) {
  return app.evaluate(({ BrowserWindow }, windowTitle) => {
    const target = BrowserWindow.getAllWindows().find((window) => window.getTitle() === windowTitle);
    if (!target) {
      throw new Error(`No window titled ${windowTitle}`);
    }
    target.close();
  }, title);
}

/** Which of the dialog's controls holds the caret, or where it escaped to. */
function readDialogFocusOwner(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector(".quit-confirm-dialog");
    const active = document.activeElement;
    if (!dialog || !active) {
      return null;
    }
    if (!dialog.contains(active)) {
      return `escaped:${active.id || active.className || active.tagName}`;
    }
    if (active === dialog) {
      return "dialog";
    }
    return active.classList.contains("primary") ? "primary" : "secondary";
  });
}

/** What a dock-icon click raises on macOS — `app.on("activate")` re-creates the
 *  main window (main.ts). Emitted directly because the harness has no dock. */
function raiseFromDock() {
  return app.evaluate(({ app: electronApp }) => {
    electronApp.emit("activate");
  });
}

/** View → Reload, the real menu path (⌘R via `{ role: "viewMenu" }`). */
function reloadMainWindow() {
  return app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.getTitle() === "Sonata")
      ?.webContents.reload();
  });
}

function crashMainRenderer() {
  return app
    .evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Sonata")
        ?.webContents.forcefullyCrashRenderer();
    })
    .catch(() => {});
}

function mainRendererIsCrashed() {
  return app
    .evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === "Sonata",
      );
      return Boolean(target && target.webContents.isCrashed());
    })
    .catch(() => false);
}

/** Everything the dialog is saying, plus where the caret is. */
function readDialog(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector(".quit-confirm-dialog");
    const primary = dialog?.querySelector(".quit-confirm-actions .primary");
    return {
      title: dialog?.querySelector(".quit-confirm-title")?.textContent ?? null,
      body: dialog?.querySelector(".quit-confirm-body")?.textContent ?? null,
      confirmLabel: primary?.textContent ?? null,
      cancelLabel: dialog?.querySelector(".quit-confirm-actions .secondary")?.textContent ?? null,
      role: dialog?.getAttribute("role") ?? null,
      ariaModal: dialog?.getAttribute("aria-modal") ?? null,
      childOrder: [...(dialog?.children ?? [])].map(
        (node) => `${node.tagName.toLowerCase()}.${node.getAttribute("class")}`,
      ),
      actionOrder: [...(dialog?.querySelectorAll(".quit-confirm-actions button") ?? [])].map((node) =>
        node.classList.contains("primary") ? "primary" : "secondary",
      ),
      focusOwner: (() => {
        const active = document.activeElement;
        if (!dialog || !active) {
          return null;
        }
        if (!dialog.contains(active)) {
          return `escaped:${active.id || active.className || active.tagName}`;
        }
        if (active === dialog) {
          return "dialog";
        }
        return active.classList.contains("primary") ? "primary" : "secondary";
      })(),
    };
  });
}

/** Replace `dialog.showMessageBox` and record what main asks it for. The
 *  technique preview-routing.mjs uses for shell.openPath/openExternal: the
 *  module object is shared, and main reads the property at call time. */
function stubNativeDialog(responseIndex) {
  return app.evaluate(({ dialog }, index) => {
    globalThis.__quitDialogCalls = [];
    dialog.showMessageBox = (ownerOrOptions, maybeOptions) => {
      const owner = maybeOptions ? ownerOrOptions : null;
      const options = maybeOptions ?? ownerOrOptions;
      globalThis.__quitDialogCalls.push({
        ownerTitle: owner ? owner.getTitle() : null,
        type: options.type,
        title: options.title,
        message: options.message,
        detail: options.detail,
        buttons: options.buttons,
        defaultId: options.defaultId,
        cancelId: options.cancelId,
      });
      return Promise.resolve({ response: index, checkboxChecked: false });
    };
  }, responseIndex);
}

function nativeDialogCalls() {
  return app.evaluate(() => globalThis.__quitDialogCalls ?? []);
}

/** Drop the handle — closing it first unless the app is already gone. */
async function releaseApp(alreadyExited) {
  if (!alreadyExited) {
    await app?.close().catch(() => {});
  }
  app = null;
}

/** True when the app process actually goes away — the only honest evidence that
 *  a zero-window quit did not stop to ask. */
function whenAppExits(handle) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15_000);
    handle.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
