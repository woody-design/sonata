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
//   C. a LIVE signed-out session is offered the family's pointer and NEVER a second
//      CLI (review round 1 — a second copy hides the task's own login screen, and
//      finishing the login there would turn the facts green while leaving this pty
//      parked: the eternal pin rebuilt by its own cure), and that pointer opens the
//      window on the task's own login screen without starting anything;
//   D. with the binary GONE the pty dies before any prompt, so there IS nothing to
//      point at — the banner arrives immediately wearing the install action, which is
//      the only door left (trigger 1) — and a dismissal hides it without letting the
//      composer lie, while the next attempt speaks again;
//  D2. that button reaches S2's install seam verbatim (proven by the argv the fake
//      curl saw), and the banner then retires on the re-probed FACTS — the other of
//      the two heal paths;
//   E. the CLI window's own "Start CLI" — which bypasses Reading's composer
//      entirely and can spawn a session on a broken provider (S2's out-of-scope
//      O3) — produces a session that carries the banner like any other, with no
//      special-casing anywhere, and it does so from STALE-GOOD facts, so the
//      diagnosis's own re-probe is what learns the truth;
//   G. and the heal that actually works: the login finished in the task's OWN pty
//      retires the banner AND the honest copy on the session's own progress, and
//      delivers the prompt that waited through the whole outage. Last, because that
//      delivery opens a run the stub never closes.
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

const SIGNED_OUT_COPY = "Claude Code CLI isn't logged in.";
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

  // ── C. The pointer, and the heal through the task's OWN pty ──────────────
  //
  // The banner offers NO "Log in" button here, and that is the review-round-1 fix. This
  // session's own CLI is alive and parked on the login screen the copy points at, so
  // a second copy would hide it — and finishing the login in that second copy would
  // turn the machine facts green, retire this banner on them, and leave THIS pty
  // parked forever with its prompt queued: the eternal pin, rebuilt by its own cure.
  // The family's ordinary pointer is what is offered instead.
  assert.equal(
    await bannerAction.textContent(),
    "Open CLI →",
    "a live signed-out session gets the POINTER, never an offer to start a second CLI",
  );
  assert.equal(
    await main.locator('.attention-banner[data-kind="cli-session-start"] button').count(),
    2,
    "…and only the pointer and the dismiss — no third button",
  );

  await bannerAction.click();
  const cli = await waitForWindow(app, (page) => page.url().endsWith("/terminal.html"));
  cli.setDefaultTimeout(30_000);
  // The pointer opens the window on the TASK's own grid — the login screen itself —
  // and starts nothing: no setup run exists.
  await waitUntil(
    async () =>
      ((await cli.locator(".task-terminal .xterm-rows").first().textContent()) ?? "").includes(
        "Welcome to Claude Code",
      ),
    "the task's own first-run screen in the CLI window",
  );
  assert.equal(
    await cli.locator(".task-terminal[data-setup-run]").count(),
    0,
    "the pointer starts no second CLI",
  );
  observed.pointerNotASecondCli = "Open CLI → shows the task's own login screen, starts nothing";
  // Leave it dormant for the blocks below; the REAL heal through this pty is block G,
  // last, because a delivered prompt opens a run the fixture's stub never closes and
  // an open run outranks every placeholder assertion after it.

  // ── D. Binary gone → the pre-latch exit trigger, install action ──────────
  //
  // Spawned through the CLI window's "Resume task" rather than the composer, for the
  // determinism reason this file already pays elsewhere: `view.live` lags a pty
  // Sonata just retired, and a composer send in that gap takes the LIVE branch and
  // reports TaskNotLiveError instead of resuming. Waiting for that button to read
  // "Resume task" IS waiting for the renderer to agree the session is dormant. (The
  // delivered prompt from block C also leaves a run open until its pty dies, which
  // would put the send button in stop-mode.)
  fixture.removeCli("claude");
  await closeActiveTask(main);
  await waitForCliAction(cli, "Resume task");
  await cli.locator("#terminal-empty-action", { hasText: "Resume task" }).click();

  // No window to wait out: a missing binary fails inside the pty, so the diagnosis
  // is immediate.
  await banner.waitFor({ state: "visible", timeout: WINDOW_WAIT_MS });
  assert.equal(await bannerCopy.textContent(), ABSENT_COPY, "the L1 sentence, verbatim");
  assert.equal(
    await bannerAction.textContent(),
    "Install Claude Code CLI",
    "…and the install action — a dead pty has nothing to point at",
  );
  // Waited rather than asserted flat: the composer repaints off the same events, and
  // the run block C's delivered prompt opened closes on that pty's death.
  await waitUntil(
    async () => (await placeholder()) === YIELDED_PLACEHOLDER,
    "the composer to yield here too",
  );
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

  // ── D2. The recovery button IS S2's seam, and the machine heal works ──────
  // The one recovery the banner still offers as a BUTTON (nothing is running, and
  // there is no login screen to point at). It must reach S2's install seam verbatim —
  // proven by what the fake `curl` was actually called with, not by reading a
  // constant back — and the banner must then retire on the re-probed FACTS, which is
  // the other of the two heal paths (block C healed on the session's own progress).
  //
  // The installer HOLDS until a marker file appears (the same pattern S2's e2e uses),
  // so the running state can be OBSERVED rather than raced. Without the hold this
  // block was a coin flip on one build: a script that finishes in milliseconds clears
  // the run, `setupRunOwnsWindow()` goes false, and the grid this asserts on is
  // already disposed — so the wait spun for its full timeout instead.
  const holdFile = path.join(root, "release-install");
  fixture.setInstallScript(
    fixture.successInstallScript("claude", { holdFile, signedIn: true }),
  );
  await bannerAction.click();
  await waitUntil(
    async () =>
      ((await cli.locator(".task-terminal[data-setup-run] .xterm-rows").textContent()) ?? "").includes(
        "Downloading claude installer",
      ),
    "the installer's output in the CLI window",
  );
  assert.deepEqual(
    fixture.curlInvocations(),
    ["-fsSL https://claude.ai/install.sh"],
    "the vendor's official command (D7) is what ran",
  );
  fs.writeFileSync(holdFile, "go", "utf8");
  // The grid goes with the run on SUCCESS (a success CLEARS — only a failure's output
  // is kept). That is exactly why the hold above is not optional: an installer that
  // finishes first leaves nothing for the assertions to look at.
  await waitUntil(
    async () => (await cli.locator(".task-terminal[data-setup-run]").count()) === 0,
    "the setup grid to go with the finished run",
  );
  await banner.waitFor({ state: "detached" });
  // Waited, not asserted flat: the composer's copy stands while EITHER the machine is
  // broken or this pty is live, and `view.live` lags a pty that died on its own — so
  // the honest copy can outlive the banner's detach by one index refresh.
  await waitUntil(
    async () => (await placeholder()) !== YIELDED_PLACEHOLDER,
    "the composer's copy to come back once the machine is fixed",
  );
  observed.installSeamAndFactsHeal = {
    curl: fixture.curlInvocations(),
    healed: "banner + copy retired on the re-probed facts",
  };

  // ── E. The CLI window's Start CLI, on a broken provider (S2's O3) ────────
  // "Start CLI" does not go through Reading's composer at all, so none of the New
  // Chat card's guards apply to it and it CAN spawn a session on a CLI that is not
  // installed. It should need no special handling: that session's pty dies pre-prompt
  // like any other, and the same trigger speaks.
  //
  // Note what the machine facts say right now: still HEALTHY, because D2's install
  // fixed them and nothing has looked since (a focus re-probe is gated on something
  // being broken — D4). So this block is also the case where a spawn goes out over
  // stale-good facts, and the diagnosis's own re-probe is what learns the truth.
  fixture.removeCli("claude");
  await main.locator("#sidebar-new-chat").click();
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
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

  // ── G. The heal that actually works: this task's OWN pty ─────────────────
  // Last on purpose (see block C): the delivered prompt below opens a run the stub
  // never closes, and an active run outranks the composer copy every later block
  // asserts. Everything here is the product's own machinery once the CLI paints its
  // composer — `acceptsPromptInput()` turns true, the delivery pump latches, the
  // queued message goes out — and the banner and the honest copy retire on the
  // SESSION's own progress, with no probe involved.
  fixture.installCli("claude", { signedIn: false });
  await selectSession(main, taskId);
  await waitForCliAction(cli, "Resume task");
  await cli.locator("#terminal-empty-action", { hasText: "Resume task" }).click();
  await banner.waitFor({ state: "visible", timeout: WINDOW_WAIT_MS });
  assert.equal(await bannerCopy.textContent(), SIGNED_OUT_COPY, "parked on its login screen again");
  assert.equal(
    await bannerAction.textContent(),
    "Open CLI →",
    "…and still only the pointer, never a second CLI",
  );

  // A message sent into the parked session: the queue holds it (this is the promise
  // the send-gate asymmetry rests on).
  await main.locator("#prompt-input").fill("held until the login finishes");
  await main.locator("#send-prompt").click();

  fixture.setSignedIn("claude", true);
  fixture.completeCliLogin();
  await banner.waitFor({ state: "detached" });
  await waitUntil(
    async () => (await placeholder()) !== YIELDED_PLACEHOLDER,
    "the composer's copy to come back with it",
  );
  await waitUntil(
    async () =>
      ((await cli.locator(".task-terminal .xterm-rows").first().textContent()) ?? "").includes(
        "held until the login finishes",
      ),
    "the prompt queued during the outage to be delivered",
  );
  observed.healViaOwnPty = "own login finished → banner + copy retire, queued prompt delivered";

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

/** Click a session's sidebar row (blocks that ran a New Chat in between). */
async function selectSession(page, taskId) {
  const row = page.locator(`.sidebar-session[data-task-id="${taskId}"]`);
  await row.waitFor({ state: "visible" });
  if (!(await row.evaluate((node) => node.classList.contains("active")))) {
    await row.locator(".sidebar-session-button").click();
    await page.locator(`.sidebar-session[data-task-id="${taskId}"].active`).waitFor();
  }
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
