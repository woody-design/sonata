// CLI readiness S2 — the five card states, photographed in the real app (D11).
//
// Not a regression test: visual acceptance material. The plan deliberately skips
// up-front mocks and puts the perception check at the end, on real frames — so
// every state here is reached by making the MACHINE that state and letting the
// real probe, the real IPC, and the real renderer produce the card.
//
// Frames (plus three beyond the brief's five, noted where they are taken):
//   d-initial     both CLIs missing — the opening state, two installs
//   d-single      one missing, the other usable (L1)                 [extra]
//   d-installing  an install running, held so it can be photographed
//   d-installing-cli  the CLI window hosting that install            [extra]
//   d-failed      an install that did not finish
//   d-failed-cli  the output that card points at, still there            [extra]
//   c-claude      Claude Code installed but not signed in
//   c-codex       Codex installed but not signed in
//   healthy       the same New Chat with nothing wrong — the contrast frame
//   d-initial-dark  the opening state in dark mode                   [extra]
//
// The dark frame is here because the design system treats light/dark as an
// orthogonal transform of one token set: the fence proves the card consumes only
// tokens, and this proves the result is legible.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { createCliReadinessFixture } from "./helpers/cli-readiness-fixture.mjs";
import { chooseDraftProvider } from "./helpers/session.mjs";

const outDir =
  process.argv[2] ??
  path.join(process.cwd(), "..", "private", "reports", "2026-08-05-cliready-s2-screenshots");
fs.mkdirSync(outDir, { recursive: true });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cliready-shots-"));
const fixture = createCliReadinessFixture(root);
const shots = [];

let app = null;
try {
  // ── Launch 1: an empty machine, then one that heals ──────────────────────
  let main = await launch();
  const card = () => main.locator(".cli-readiness-card");
  await card().waitFor({ state: "visible" });
  await shoot(main, "d-initial", "both CLIs missing");

  // Dark, same state. The Aa popover is the user-facing door to it.
  await main.locator("#reading-settings").click();
  await main.locator(".reading-segment", { hasText: "Dark" }).click();
  await main.keyboard.press("Escape");
  await card().waitFor({ state: "visible" });
  await shoot(main, "d-initial-dark", "both CLIs missing, dark");
  await main.locator("#reading-settings").click();
  await main.locator(".reading-segment", { hasText: "Light" }).click();
  await main.keyboard.press("Escape");

  // An install, HELD open so the running state is a photograph and not a race.
  const holdFile = path.join(root, "release-install");
  fixture.setInstallScript(fixture.successInstallScript("claude", { holdFile }));
  await main.locator("#cli-readiness-install-claude").click();
  await main.locator('.cli-readiness-card[data-kind="installing"]').waitFor({ state: "visible" });
  await shoot(main, "d-installing", "an install in flight");

  const cli = await waitForWindow(app, (page) => page.url().endsWith("/terminal.html"));
  cli.setDefaultTimeout(30_000);
  await waitUntil(
    async () =>
      (
        (await cli.locator(".task-terminal[data-setup-run] .xterm-rows").textContent()) ?? ""
      ).includes("Installing to"),
    "the installer's output",
  );
  await shoot(cli, "d-installing-cli", "the CLI window hosting the installer");

  fs.writeFileSync(holdFile, "go", "utf8");
  await card().waitFor({ state: "detached" });

  // One missing, one usable (L1) — the draft moves to the CLI that is not there.
  await chooseDraftProvider(main, "codex");
  await main.locator('.cli-readiness-card[data-kind="absent"]').waitFor({ state: "visible" });
  await shoot(main, "d-single", "one CLI missing, the other usable");

  // An install that does not finish.
  fixture.setInstallScript(fixture.failingInstallScript());
  await main.locator("#cli-readiness-install-codex").click();
  await main
    .locator('.cli-readiness-card[data-kind="install-failed"]')
    .waitFor({ state: "visible" });
  await shoot(main, "d-failed", "an install that did not finish");
  // The other half of that card: its copy sends the user here, so the failed
  // installer's output has to still be on screen.
  await waitUntil(
    async () =>
      (
        (await cli.locator(".task-terminal[data-setup-run] .xterm-rows").textContent()) ?? ""
      ).includes("permission denied"),
    "the failed install's output",
  );
  await shoot(cli, "d-failed-cli", "the output the failed card points at");

  // …and the contrast frame: the same New Chat with nothing wrong.
  fixture.setInstallScript(fixture.successInstallScript("codex"));
  await main.locator("#cli-readiness-retry").click();
  await card().waitFor({ state: "detached" });
  await main.locator("#composer-context-row:not(.hidden)").waitFor();
  await shoot(main, "healthy", "nothing wrong — the normal composer");

  // ── Launches 2 and 3: installed, not signed in ───────────────────────────
  // A relaunch per provider: the launch probe is the real path by which Sonata
  // learns a token expired while it was closed, and the pre-written last-used
  // record is what puts the draft on the provider each frame is about.
  for (const provider of ["claude", "codex"]) {
    await app.close();
    app = null;
    fixture.setSignedIn("claude", provider !== "claude");
    fixture.setSignedIn("codex", provider !== "codex");
    fs.writeFileSync(
      path.join(fixture.settingsDir, "sonata-settings.json"),
      `${JSON.stringify({ lastUsedProvider: provider }, null, 2)}\n`,
      "utf8",
    );
    main = await launch();
    await main.locator('.cli-readiness-card[data-kind="signed-out"]').waitFor({ state: "visible" });
    await shoot(main, provider === "claude" ? "c-claude" : "c-codex", `${provider} not signed in`);
  }

  console.log(JSON.stringify({ outDir, shots, success: true }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(root, { recursive: true, force: true });
}

async function shoot(page, name, note) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push({ name, note });
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
