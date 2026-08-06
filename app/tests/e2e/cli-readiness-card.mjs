// CLI readiness S2 — the readiness card's loop, in the real app.
//
// The unit fences cover the matrix (tests/smoke/cli-readiness-card.mjs) and the
// run mechanics (tests/smoke/cli-setup-run.mjs). What only the app can show is
// the loop CLOSING across four processes — the probe's subprocesses, main's pty,
// the IPC push, and two renderers:
//
//   A. a machine with no CLI at all shows the both-absent card, and the composer
//      cannot send — not by the button alone, but through Enter too, which is the
//      path the old silent-queue bug took;
//   B. Install runs the VENDOR'S OFFICIAL COMMAND (D7) — proven by what the fake
//      `curl` was actually called with, not by reading the constant back — visibly
//      in the CLI window, and when the re-probe finds the CLI the card DISAPPEARS
//      and the composer comes back;
//   C. switching the draft provider swaps the card to that provider's fact and
//      removes it entirely when that provider is healthy (D6 — the card never
//      switches for you, but it yields the moment you do);
//   D. an install that fails shows the failure card, and Try again re-runs it;
//   E. Start runs the CLI itself in the CLI window (its own login screen, which
//      Sonata never reads), and finishing the login makes the card go on its own.
//
// Deterministic by construction: the app's PATH is a fixture bin dir plus the
// system dirs, the CLIs in it are stubs answering MEASURED probe shapes, and
// `curl` is a stub that prints whatever script the test wants. No network, no real
// installer, no real CLI.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { createCliReadinessFixture } from "./helpers/cli-readiness-fixture.mjs";
import { chooseDraftProvider } from "./helpers/session.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cli-readiness-card-e2e-"));
const fixture = createCliReadinessFixture(root);
const observed = {};

let app = null;
try {
  // ── A. Nothing installed ─────────────────────────────────────────────────
  const main = await launch();
  const card = main.locator(".cli-readiness-card");
  await card.waitFor({ state: "visible" });
  assert.equal(await card.getAttribute("data-kind"), "both-absent");
  assert.equal(
    await main.locator(".cli-readiness-copy").textContent(),
    "Claude Code CLI or Codex CLI not installed.",
  );
  assert.deepEqual(
    await main.locator(".cli-readiness-action").allTextContents(),
    ["Install Claude Code CLI", "Install Codex CLI"],
  );
  observed.bothAbsent = await main.locator(".cli-readiness-copy").textContent();

  // The send path is CLOSED — and the assertion that matters is the keyboard one.
  // The old failure was a prompt queueing in silence, and Enter reaches submit
  // through requestSubmit(), which a disabled button does not guard.
  await main.locator("#prompt-input").fill("this must not start a session");
  assert.equal(await main.locator("#send-prompt").isDisabled(), true, "send is disabled");
  await main.locator("#prompt-input").press("Enter");
  await main.waitForTimeout(1000);
  assert.equal(
    await main.locator(".sidebar-session").count(),
    0,
    "Enter on a card-blocked composer creates no session",
  );
  assert.equal(
    await main.locator("#prompt-input").inputValue(),
    "this must not start a session",
    "and the draft is not consumed — nothing was sent",
  );
  observed.sendBlocked = "button disabled + Enter inert + no session";

  // …and the THIRD door, which the first implementation left open (review B1). The
  // slash picker's execute path calls submitPrompt DIRECTLY — no form event, no
  // send button — and it is reachable here precisely because the card leaves the
  // textarea enabled. The builtin list is a hardcoded snapshot needing no installed
  // CLI, so `/status` (a listed passthrough with no argument hint) classifies
  // "execute" and would have created a session on a provider that cannot boot.
  await main.locator("#prompt-input").fill("/status");
  await main.locator(".slash-picker").waitFor({ state: "visible" });
  await main.locator("#prompt-input").press("Enter");
  await main.waitForTimeout(1500);
  assert.equal(
    await main.locator(".sidebar-session").count(),
    0,
    "executing a slash command while the card is up creates no session",
  );
  assert.equal(
    await main.locator(".cli-readiness-card").count(),
    1,
    "and the card is still the honest state of the surface",
  );
  observed.slashExecuteBlocked = "/status + Enter on the picker → no session";
  await main.locator("#prompt-input").fill("");

  // ── B. Install, visibly, and the card yields when it works ───────────────
  // The installer HOLDS until a marker file appears, so the "Installing…" state
  // can be observed rather than raced.
  const holdFile = path.join(root, "release-install");
  fixture.setInstallScript(fixture.successInstallScript("claude", { holdFile }));
  await main.locator("#cli-readiness-install-claude").click();

  await main
    .locator('.cli-readiness-card[data-kind="installing"]')
    .waitFor({ state: "visible" });
  assert.equal(
    await main.locator(".cli-readiness-copy").textContent(),
    "Installing Claude Code — follow along in the terminal window.",
  );
  assert.equal(
    await main.locator(".cli-readiness-action").count(),
    0,
    "nothing to click while it runs",
  );
  observed.installing = await main.locator(".cli-readiness-copy").textContent();

  // Visibly: the CLI window is up, hosting the run, and showing its output.
  const cli = await waitForWindow(app, (page) => page.url().endsWith("/terminal.html"));
  cli.setDefaultTimeout(30_000);
  await cli.locator(".task-terminal[data-setup-run]").waitFor({ state: "visible" });
  await waitUntil(
    async () =>
      ((await cli.locator(".task-terminal[data-setup-run] .xterm-rows").textContent()) ?? "").includes(
        "Downloading",
      ),
    "the installer's output to appear in the CLI window",
  );
  // The breadcrumb names what is on screen, not the task Reading has selected.
  assert.equal(await cli.locator("#terminal-project-name").textContent(), "Setup");
  assert.equal(await cli.locator("#terminal-session-title").textContent(), "Install Claude Code");
  observed.cliWindowHostsTheRun = await cli.locator("#terminal-session-title").textContent();

  // D7, proven from the outside: this is the command that ran.
  assert.deepEqual(
    fixture.curlInvocations(),
    ["-fsSL https://claude.ai/install.sh"],
    "the official Claude install command is what executed",
  );
  observed.curlArgv = fixture.curlInvocations();

  // THE ESCAPE HATCH (review O2). A wedged installer — one sitting on an
  // unanswered sudo prompt — shows "Installing…" with no card-side way out, and the
  // answer is that the run is a real pty whose keystrokes are forwarded: Ctrl-C in
  // the CLI window reaches the installer, kills it, and settles the card to the
  // failed state with Try again. This install is HELD open, so it stands in for the
  // wedged one exactly.
  await cli.locator(".task-terminal[data-setup-run]").click();
  await cli.keyboard.press("Control+C");
  await main
    .locator('.cli-readiness-card[data-kind="install-failed"]')
    .waitFor({ state: "visible" });
  assert.deepEqual(await main.locator(".cli-readiness-action").allTextContents(), ["Try again"]);
  observed.ctrlCEscapesAWedgedInstall = "Ctrl-C in the CLI window → failed + Try again";

  // Try again, and let it through this time.
  fs.writeFileSync(holdFile, "go", "utf8");
  await main.locator("#cli-readiness-retry").click();
  // The card goes on its own: the pty exits, main re-probes with the PATH bust,
  // the facts turn green, the run clears, and the push repaints.
  await card.waitFor({ state: "detached" });
  await main.locator("#prompt-input").fill("now the composer works");
  await main.locator("#send-prompt:not([disabled])").waitFor();
  observed.healedByItself = "card gone, send re-armed";
  await main.locator("#prompt-input").fill("");
  // And the CLI window returns to the task surface it was showing before.
  await cli.locator("#terminal-window-empty").waitFor({ state: "visible" });
  assert.equal(await cli.locator(".task-terminal[data-setup-run]").count(), 0);

  // ── C. The draft's provider is the subject (D6) ───────────────────────────
  // Claude works now, Codex still does not. Switching the draft swaps the card;
  // switching back removes it. Sonata never switches for the user — the card is
  // simply about whatever they chose.
  await chooseDraftProvider(main, "codex");
  await main.locator('.cli-readiness-card[data-kind="absent"]').waitFor({ state: "visible" });
  assert.equal(
    await main.locator(".cli-readiness-copy").textContent(),
    "Codex CLI not installed.",
  );
  assert.deepEqual(
    await main.locator(".cli-readiness-action").allTextContents(),
    ["Install Codex CLI"],
    "only the missing CLI is named (L1)",
  );
  observed.singleAbsent = await main.locator(".cli-readiness-copy").textContent();

  await chooseDraftProvider(main, "claude");
  await card.waitFor({ state: "detached" });
  await main.locator("#prompt-input").fill("x");
  await main.locator("#send-prompt:not([disabled])").waitFor();
  await main.locator("#prompt-input").fill("");
  observed.switchToHealthyRemovesCard = true;

  // ── D. A failed install, and Try again ───────────────────────────────────
  await chooseDraftProvider(main, "codex");
  await main.locator('.cli-readiness-card[data-kind="absent"]').waitFor({ state: "visible" });
  fixture.setInstallScript(fixture.failingInstallScript());
  await main.locator("#cli-readiness-install-codex").click();
  await main
    .locator('.cli-readiness-card[data-kind="install-failed"]')
    .waitFor({ state: "visible" });
  assert.equal(
    await main.locator(".cli-readiness-copy").textContent(),
    "Installation didn't finish — check the output in the terminal window.",
  );
  assert.deepEqual(await main.locator(".cli-readiness-action").allTextContents(), ["Try again"]);
  assert.deepEqual(
    fixture.curlInvocations().at(-1),
    "-fsSL https://chatgpt.com/codex/install.sh",
    "the official Codex install command is what executed",
  );
  observed.installFailed = await main.locator(".cli-readiness-copy").textContent();

  // The card says "check the output in the terminal window", so the output has to
  // still BE there. (Found in self-review: retiring the grid when the run stopped
  // running deleted the very thing this copy points at.)
  const failedOutput =
    (await cli.locator(".task-terminal[data-setup-run] .xterm-rows").textContent()) ?? "";
  assert.match(
    failedOutput,
    /permission denied writing to/,
    "the failed install's output survives on screen, which is what the copy promises",
  );
  observed.failedOutputSurvives = "permission denied writing to /usr/local/bin";

  fixture.setInstallScript(fixture.successInstallScript("codex"));
  await main.locator("#cli-readiness-retry").click();
  await card.waitFor({ state: "detached" });
  observed.retrySucceeded = "card gone after Try again";

  // ── E. Signed out → Start → the CLI's own login screen ───────────────────
  //
  // A RELAUNCH, on purpose. Both CLIs work at this point, and D4's whole design is
  // that a healthy machine is never re-probed — window focus self-gates to
  // nothing. So the honest way to observe a machine that changed while Sonata was
  // closed is the launch probe, which is also what a real user hits: their token
  // expired overnight.
  //
  // The last-used record is pre-written (the fresh-launch-defaults idiom) so the
  // draft lands on Claude deterministically instead of inheriting the sole-healthy
  // tiebreak — the card's subject has to be unambiguous for its copy to be an
  // assertion rather than a coincidence.
  await app.close();
  app = null;
  fixture.setSignedIn("claude", false);
  fs.writeFileSync(
    path.join(fixture.settingsDir, "sonata-settings.json"),
    `${JSON.stringify({ lastUsedProvider: "claude" }, null, 2)}\n`,
    "utf8",
  );

  const main2 = await launch();
  const card2 = main2.locator(".cli-readiness-card");
  await card2.waitFor({ state: "visible" });
  assert.equal(await card2.getAttribute("data-kind"), "signed-out");
  assert.equal(
    await main2.locator(".cli-readiness-copy").textContent(),
    "Claude Code CLI isn't signed in. Finish its first-run setup in the terminal window.",
  );
  assert.deepEqual(await main2.locator(".cli-readiness-action").allTextContents(), [
    "Start Claude Code CLI",
  ]);
  // Installed, and not signed in: the two axes stayed independent all the way to
  // the card, so nobody is offered an install for a CLI they already have.
  observed.signedOut = await main2.locator(".cli-readiness-copy").textContent();

  const cli2 = await waitForWindow(app, (page) => page.url().endsWith("/terminal.html"));
  cli2.setDefaultTimeout(30_000);
  await main2.locator("#cli-readiness-start").click();
  // The CLI itself, in the CLI window, on its own first-run screen. Sonata renders
  // bytes and forwards keys; it parses none of this (D1/D2).
  await cli2.locator(".task-terminal[data-setup-run]").waitFor({ state: "visible" });
  await waitUntil(
    async () =>
      (
        (await cli2.locator(".task-terminal[data-setup-run] .xterm-rows").textContent()) ?? ""
      ).includes("Welcome to Claude Code"),
    "the CLI's own first-run screen to appear",
  );
  assert.equal(await cli2.locator("#terminal-session-title").textContent(), "Start Claude Code");
  // While it runs, the sentence stands and the button is gone — starting a second
  // copy of a CLI that is waiting for input would only make a mess.
  assert.equal(
    await main2.locator(".cli-readiness-copy").textContent(),
    "Claude Code CLI isn't signed in. Finish its first-run setup in the terminal window.",
  );
  assert.equal(await main2.locator(".cli-readiness-action").count(), 0);
  observed.startRunHostsTheCli = "Welcome to Claude Code, no button while it runs";

  // Finish the login the only way Sonata allows: inside the CLI. The control file
  // is what "signed in" means to the next probe, and Ctrl-C is the user closing the
  // CLI once it is done — whose pty exit is what triggers that probe.
  fixture.setSignedIn("claude", true);
  await cli2.locator(".task-terminal[data-setup-run]").click();
  await cli2.keyboard.press("Control+C");
  await card2.waitFor({ state: "detached" });
  await main2.locator("#prompt-input").fill("ready now");
  await main2.locator("#send-prompt:not([disabled])").waitFor();
  observed.loginClosesTheLoop = "card gone and send re-armed after the CLI exits signed in";

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

async function waitForWindow(electronApp, predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const found = electronApp.windows().find(predicate);
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
