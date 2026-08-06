// CLI readiness S4 — the existing-chat banner's loop, in the real app.
//
// The unit fences cover the two triggers on the real controller
// (tests/smoke/cli-session-start-triggers.mjs) and the banner's presence matrix and
// copy (tests/smoke/cli-session-start-banner.mjs). What only the app can show is
// the loop closing across four processes — the probe's subprocesses, main's pty,
// the runtime event, and two renderers:
//
//   A. a HEALTHY machine whose CLI simply has not reached a prompt yet says
//      nothing, and the composer keeps its ordinary "is starting" copy. This is the
//      block that matters most: the diagnosis must never fire on a slow boot;
//   B. the same conversation, resumed after the CLI is signed out, gets the banner
//      when the observation window elapses (L5) — and the composer's boot promise
//      yields to an honest state in the same paint;
//   C. the banner's action is S2's seam verbatim: the CLI window comes forward
//      running the CLI itself, the button withdraws while it runs, and finishing
//      the login retires the banner with nobody clearing anything;
//   D. with the binary GONE the pty dies before any prompt, and the banner arrives
//      immediately wearing the install action instead (trigger 1);
//   E. the CLI window's own "Start CLI" — which bypasses Reading's composer
//      entirely and can spawn a session on a broken provider (S2's out-of-scope
//      O3) — produces a session that carries the banner like any other, with no
//      special-casing anywhere.
//
// Deterministic by construction, on S2's fixture: the app's PATH is a fixture bin
// dir plus the system dirs, and the CLI in it is a stub that answers the probe's
// MEASURED shapes and otherwise prints a first-run screen and waits — which is
// exactly the machine shape this slice is about. No network, no real CLI.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { createCliReadinessFixture } from "./helpers/cli-readiness-fixture.mjs";

/** The production boot observation window (L5) plus room for the probe that
 *  follows it and the paint that follows that. */
const WINDOW_WAIT_MS = 15_000;

const SIGNED_OUT_COPY =
  "Claude Code CLI isn't signed in. Finish its first-run setup in the terminal window.";
const ABSENT_COPY = "Claude Code CLI not installed.";
const STARTING_PLACEHOLDER = "Claude is starting — your message will send when it's ready";
const YIELDED_PLACEHOLDER = "Claude can't start yet";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cli-session-start-e2e-"));
const fixture = createCliReadinessFixture(root);
// A fully healthy machine to begin with, so nothing is on screen at launch and
// every banner below is something this test caused.
fixture.installCli("claude", { signedIn: true });
fixture.installCli("codex", { signedIn: true });

const observed = {};
let app = null;
try {
  const main = await launch();
  const banner = main.locator('.attention-banner[data-kind="cli-session-start"]');
  const bannerCopy = banner.locator(".attention-banner-copy");
  const bannerAction = banner.locator(".attention-open-terminal");
  const placeholder = () => main.locator("#prompt-input").getAttribute("placeholder");

  assert.equal(
    await main.locator(".cli-readiness-card").count(),
    0,
    "a healthy machine shows no New Chat card",
  );

  // ── A. Healthy, just not booted yet → silence ────────────────────────────
  // The fixture's CLI prints its first-run screen and waits, so this session never
  // reaches a prompt and the observation window WILL elapse on it. The probe finds
  // a healthy machine, so nothing may be said — the same silence a genuinely slow
  // boot must get.
  await main.locator("#prompt-input").fill("hello");
  await main.locator("#send-prompt").click();
  await main.locator(".sidebar-session").first().waitFor({ state: "visible" });
  await main.waitForTimeout(WINDOW_WAIT_MS);
  assert.equal(await banner.count(), 0, "a healthy machine is never accused");
  assert.equal(
    await placeholder(),
    STARTING_PLACEHOLDER,
    "…and the composer keeps its ordinary boot copy",
  );
  observed.healthySilence = "window elapsed on a healthy machine → no banner, copy unchanged";

  // ── B. Signed out, on a resumed conversation (D10) ───────────────────────
  // Sign the CLI out, then end this session the way Sonata itself would (a close is
  // never diagnosed) and send again — which resumes the SAME conversation. That
  // resume is the "旧 chat 续聊" case D10 exists for.
  fixture.setSignedIn("claude", false);
  const taskId = await closeActiveTask(main);
  await main.locator("#prompt-input").fill("still there?");
  await main.locator("#send-prompt").click();

  await banner.waitFor({ state: "visible", timeout: WINDOW_WAIT_MS });
  assert.equal(await bannerCopy.textContent(), SIGNED_OUT_COPY, "the D8 sentence, verbatim");
  assert.equal(
    await bannerAction.textContent(),
    "Start Claude Code CLI",
    "…and the D8 action, verbatim",
  );
  assert.equal(
    await placeholder(),
    YIELDED_PLACEHOLDER,
    "the composer stops promising a boot that is not coming",
  );
  // The asymmetry with the New Chat card, on purpose: this conversation already
  // exists, and the message is held in the delivery queue until the login finishes.
  // (Typed text first — send is disabled on an EMPTY composer for every session,
  // which would make an untyped assertion pass for the wrong reason.)
  await main.locator("#prompt-input").fill("queued until the login finishes");
  assert.equal(
    await main.locator("#send-prompt").isDisabled(),
    false,
    "an existing chat's send stays open (the queue is honest here)",
  );
  assert.equal(
    await main.locator("#send-prompt").getAttribute("title"),
    "Queued — delivers when Claude is ready.",
    "and the send title yields onto the truthful queue statement, not a boot promise",
  );
  await main.locator("#prompt-input").fill("");
  observed.signedOutBanner = {
    copy: await bannerCopy.textContent(),
    action: await bannerAction.textContent(),
    placeholder: await placeholder(),
    taskId,
  };

  // ── C. The action is S2's seam, and the heal is the facts' ───────────────
  await bannerAction.click();
  const cli = await waitForWindow(app, (page) => page.url().endsWith("/terminal.html"));
  cli.setDefaultTimeout(30_000);
  await cli.locator(".task-terminal[data-setup-run]").waitFor({ state: "visible" });
  await waitUntil(
    async () =>
      ((await cli.locator(".task-terminal[data-setup-run] .xterm-rows").textContent()) ?? "").includes(
        "Welcome to Claude Code",
      ),
    "the CLI's own first-run screen in the CLI window",
  );
  // The sentence still holds while that CLI is up, but the recovery withdraws —
  // starting a second copy of a CLI awaiting input is a mess rather than a fix — and
  // degrades to the family's own pointer at the window where the CLI now is.
  await waitUntil(
    async () => (await bannerAction.textContent()) === "Open CLI →",
    "the recovery action to degrade to the family pointer",
  );
  assert.equal(await bannerCopy.textContent(), SIGNED_OUT_COPY, "and the copy is not rewritten");
  observed.actionRunsTheCli = "CLI window hosts the real CLI; the recovery becomes Open CLI →";

  // Finish the login the only way Sonata allows — inside the CLI. The control file
  // is what "signed in" means to the next probe; Ctrl-C is the user closing the CLI,
  // and that pty's exit is what triggers the probe.
  fixture.setSignedIn("claude", true);
  await cli.locator(".task-terminal[data-setup-run]").click();
  await cli.keyboard.press("Control+C");
  await banner.waitFor({ state: "detached" });
  assert.notEqual(
    await placeholder(),
    YIELDED_PLACEHOLDER,
    "and the composer's copy comes back with it",
  );
  observed.healRetiresIt = "facts turned green → banner and copy retire themselves";

  // ── D. Binary gone → the pre-latch exit trigger, install action ──────────
  fixture.removeCli("claude");
  await closeActiveTask(main);
  await main.locator("#prompt-input").fill("and now?");
  await main.locator("#send-prompt").click();

  // No window to wait out: a missing binary fails inside the pty, so the diagnosis
  // is immediate.
  await banner.waitFor({ state: "visible", timeout: WINDOW_WAIT_MS });
  assert.equal(await bannerCopy.textContent(), ABSENT_COPY, "the L1 sentence, verbatim");
  assert.equal(
    await bannerAction.textContent(),
    "Install Claude Code CLI",
    "…and the install action",
  );
  assert.equal(await placeholder(), YIELDED_PLACEHOLDER, "the composer yields here too");
  observed.absentBanner = {
    copy: await bannerCopy.textContent(),
    action: await bannerAction.textContent(),
  };

  // Dismissing is "I have read this", not "this is no longer true". The banner goes;
  // the COMPOSER keeps the honest copy, because folding the two together would send
  // it back to promising a boot the moment the notice was closed.
  await banner.locator(".attention-banner-dismiss").click();
  await banner.waitFor({ state: "detached" });
  assert.equal(
    await placeholder(),
    YIELDED_PLACEHOLDER,
    "a dismissed banner does not restore the boot promise",
  );
  observed.dismissKeepsTheFact = "banner closed, composer copy unchanged";

  // …and a dismissal is spent by the next attempt. Trying again on the SAME
  // conversation is a new statement, so the banner comes back — otherwise one close
  // would silence this surface for that task for the rest of the session.
  //
  // Retried through the CLI window's own "Resume task" rather than the composer,
  // for determinism: `view.live` lags a pty that died on its own (nothing in the
  // reducer clears it — the session-index refresh does, asynchronously), so a
  // composer send in that gap can take the LIVE path and report TaskNotLiveError
  // instead of resuming. Waiting for that button to read "Resume task" IS waiting
  // for the renderer to agree the session is dormant. (Filed as out-of-scope; it is
  // a pre-existing lifecycle lag, not readiness.)
  await waitForCliAction(cli, "Resume task");
  await cli.locator("#terminal-empty-action", { hasText: "Resume task" }).click();
  await banner.waitFor({ state: "visible", timeout: WINDOW_WAIT_MS });
  assert.equal(await bannerCopy.textContent(), ABSENT_COPY, "the next attempt speaks again");
  observed.dismissIsSpentByTheNextAttempt = "re-raised on the same task";

  // ── E. The CLI window's Start CLI, on a broken provider (S2's O3) ────────
  // Reading's own composer is closed here — the New Chat card blocks it — but the
  // CLI window's Start CLI does not go through the composer at all, so it CAN spawn
  // a session on a CLI that is not installed. It should need no special handling:
  // that session's pty dies pre-prompt like any other, and the same trigger speaks.
  await main.locator("#sidebar-new-chat").click();
  await main.locator(".cli-readiness-card").waitFor({ state: "visible" });
  const sessionsBefore = await main.locator(".sidebar-session").count();
  await waitForCliAction(cli, "Start CLI");
  await cli.locator("#terminal-empty-action", { hasText: "Start CLI" }).click();
  await waitUntil(
    async () => (await main.locator(".sidebar-session").count()) > sessionsBefore,
    "the session Start CLI creates on a broken provider",
  );
  await banner.waitFor({ state: "visible", timeout: WINDOW_WAIT_MS });
  assert.equal(
    await bannerCopy.textContent(),
    ABSENT_COPY,
    "the session Start CLI made carries the banner like any other",
  );
  assert.equal(await placeholder(), YIELDED_PLACEHOLDER, "…and its composer is honest too");
  observed.startCliCovered = "Start CLI's session is diagnosed by the same trigger — no special case";

  console.log(JSON.stringify({ ...observed, success: true }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(root, { recursive: true, force: true });
}

async function launch() {
  app = await electron.launch({ args: ["dist/main/main.js"], env: fixture.env() });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  return page;
}

/**
 * End the active session's pty the way Sonata itself does. A `sonataInitiated` exit
 * is deliberately never diagnosed, so this leaves a dormant conversation and no
 * banner — which is what makes the next send a clean RESUME to observe.
 *
 * Tolerant of an already-dead runtime (a pty that exited on its own has retired
 * itself, and `task:close` rightly refuses to close what is not live) so a caller
 * only has to know it wants the conversation dormant.
 */
async function closeActiveTask(page) {
  const taskId = await page.evaluate(async () => {
    const id = document.querySelector(".sidebar-session.active")?.getAttribute("data-task-id");
    if (id) {
      await window.sonataRuntime.closeTask({ taskId: id }).catch(() => {});
    }
    return id;
  });
  assert.ok(taskId, "an active session to close");
  await page.waitForTimeout(1_000);
  return taskId;
}

async function waitForCliAction(page, text) {
  await page.locator("#terminal-empty-action", { hasText: text }).waitFor({ state: "visible" });
  await page
    .locator("#terminal-empty-action:not(:disabled)", { hasText: text })
    .waitFor({ state: "visible" });
}

async function waitForWindow(electronApp, predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const found = electronApp.windows().find((page) => !page.isClosed() && predicate(page));
    if (found) {
      return found;
    }
    await delay(100);
  }
  throw new Error("timed out waiting for the CLI window");
}

async function waitUntil(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
