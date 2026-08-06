// codex-trust S2 — the trust-dialog banner, photographed in the real app.
//
// Not a regression test: visual acceptance material, following
// cli-readiness-screenshots.mjs. Every frame is reached by making the MACHINE
// the state and letting the real spawn, the real watchdog, the real grid, the
// real IPC and the real renderer produce the banner. Nothing is stubbed, no
// fake CLI, and NO PRODUCT CODE is touched or bypassed.
//
// HOW THE STATE IS REACHED — honestly, and without inventing a scenario.
//
// After S1, codex pre-trusts every spawn's cwd unconditionally, so the dialog is
// a residual state. The plan (D5) names its causes, and the second — "profile 层
// 被破坏", a damaged profile layer — is manufacturable from the filesystem alone,
// because the product already has a designed, documented behaviour for it:
//
//   terminal-host.ts, buildArgs: "If the write fails (unwritable dir, ENOSPC, a
//   shell-unsafe shim path), DEGRADE to a hookless spawn rather than aborting
//   the launch."
//
// The trust ledger rides in the profile file — `$CODEX_HOME/sonata.config.toml`
// (codex-runtime-settings.ts `codexProfilePath`), written by `writeIfChanged`
// through a tmp file + rename. Put a DIRECTORY where that file belongs and the
// rename fails (EISDIR). Sonata degrades to a hookless spawn, which is a spawn
// without `-p sonata` — and therefore without the trust ledger. Codex finds no
// trust entry for the cwd and paints its directory-trust dialog. The residual
// case, produced by one of its own real causes.
//
//   1. the damage is scoped to that ONE path. An earlier attempt sealed the
//      whole CODEX_HOME (chmod 555) and was rejected on evidence: codex writes
//      its own state there at boot (sqlite, caches, installation_id), so the
//      seal killed the CLI itself and produced a dead pty instead of a dialog —
//      the wrong state, photographed would have been a lie. CODEX_HOME stays
//      fully writable here; only Sonata's write fails.
//   2. auth is SYMLINKED, never copied: codex reads the real credential through
//      the link, so this script never duplicates a token to disk. The user's
//      `config.toml` is deliberately NOT linked — it can carry `[projects]`
//      trust entries, and inheriting one would defeat the whole setup.
//   3. the cwd is a fresh mkdtemp folder, so no trust entry for it can exist
//      anywhere.
//
// Two things the real boot confirmed, worth recording: the dialog renders
// WITHOUT the git-root note and without an error line (the cwd is not a repo),
// and the signature matched anyway — the "TOLERATES, does not DEPEND ON" claim
// on `isCodexTrustDialog`, met in the field rather than only in a fixture.
//
// FRAMES
//   banner-light       the banner in Reading, light
//   banner-dark        the same state, dark (via the Aa popover, the user's door)
//   dialog-cli         the co-visible CLI window showing the dialog itself —
//                      the other half of what "answer in the CLI window" points at
//   banner-retired     after the USER answers in the CLI, the banner is gone
//
// The answer in the last frame is written through `writeTerminalUserInput` — the
// SAME IPC the CLI window's xterm uses for a keystroke, i.e. the user's own
// channel. That is the user answering, which is the only way this dialog may
// ever be answered. Sonata never writes into it, and the smoke fence asserts the
// watchdog's byte count is zero.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { chooseDraftProvider } from "./helpers/session.mjs";

const outDir =
  process.argv[2] ??
  path.join(process.cwd(), "..", "private", "reports", "2026-08-06-codextrust-s2-screenshots");

const realCodexHome = process.env.SONATA_REAL_CODEX_HOME || path.join(os.homedir(), ".codex");
const realAuth = path.join(realCodexHome, "auth.json");

// The one environmental precondition. Without a real, signed-in codex there is
// no honest way to reach this state — codex would stop at its LOGIN screen, a
// different failure entirely. Refuse rather than photograph the wrong thing.
if (!fs.existsSync(realAuth)) {
  console.error(
    `SKIP: no codex credential at ${realAuth} — this harness photographs a REAL codex boot ` +
      `parked on its trust dialog, and a signed-out codex parks on its login screen instead.`,
  );
  process.exit(77);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codextrust-shots-"));
const workspaceRoot = path.join(root, "workspace");
const settingsDir = path.join(root, "settings");
const selectedFolder = path.join(root, "project");
const codexHome = path.join(root, "codex-home");
for (const dir of [workspaceRoot, settingsDir, selectedFolder, codexHome]) {
  fs.mkdirSync(dir, { recursive: true });
}

// The credential, reachable but never duplicated.
fs.symlinkSync(realAuth, path.join(codexHome, "auth.json"));
// The damage: a non-empty DIRECTORY where the profile file belongs, so
// `writeIfChanged`'s rename fails with EISDIR. Nothing else in CODEX_HOME is
// touched — codex boots normally and writes its own state as usual.
const profilePath = path.join(codexHome, "sonata.config.toml");
fs.mkdirSync(profilePath, { recursive: true });
fs.writeFileSync(path.join(profilePath, "occupied"), "damaged profile layer\n", "utf8");

const projectsDir = path.join(workspaceRoot, "data", "projects");
const shots = [];
let app = null;

try {
  const main = await launch();
  await main.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor();

  // A codex draft, in the untrusted folder.
  await chooseDraftProvider(main, "codex");
  await main.locator("#project-chip").click();
  await main.locator("#entry-choose-folder").click();
  await main
    .locator("#project-chip", { hasText: path.basename(selectedFolder) })
    .waitFor({ state: "visible" });

  // The first message creates the task and spawns codex for real. The prompt
  // will NOT be delivered — the dialog holds readiness, which is the whole point
  // (the `bootDialogHints` guard, untouched by this slice) — so nothing here
  // waits on a turn.
  await main.locator("#prompt-input").fill("hello from the trust-dialog screenshot harness");
  await main.locator("#send-prompt").click();

  // Proof the manufacture actually took, BEFORE any photograph: a spawn that
  // silently pre-trusted would render no banner and the waits below would just
  // time out with nothing to say. The banner IS that proof — it can only exist
  // if the real watchdog matched the real dialog on the real grid.
  const banner = main.locator('.attention-banner[data-kind="codex-trust-dialog"]');
  await banner.waitFor({ state: "visible", timeout: 90_000 });
  await shoot(main, "banner-light", "the trust-dialog banner in Reading");

  // Dark, same state, through the user-facing door.
  await main.locator("#reading-settings").click();
  await main.locator(".reading-segment", { hasText: "Dark" }).click();
  await main.keyboard.press("Escape");
  await banner.waitFor({ state: "visible" });
  await shoot(main, "banner-dark", "the same banner, dark");
  await main.locator("#reading-settings").click();
  await main.locator(".reading-segment", { hasText: "Light" }).click();
  await main.keyboard.press("Escape");
  await banner.waitFor({ state: "visible" });

  // The other half of the pointer: the CLI window the copy sends the user to,
  // with the dialog actually on it.
  const cli = await waitForWindow((page) => page.url().endsWith("/terminal.html"));
  cli.setDefaultTimeout(30_000);
  await waitUntil(
    async () => (await cliText(cli)).includes("Do you trust the contents of this directory"),
    "the trust dialog in the CLI window",
  );
  await shoot(cli, "dialog-cli", "the dialog itself, in the co-visible CLI window");

  // The USER answers — through the same IPC a keystroke in that window uses
  // (`writeTerminalUserInput`, the CLI xterm's own `onData` path). Sonata never
  // does this; the smoke fence pins the watchdog at zero bytes written.
  const taskId = await waitForTaskId();
  await main.evaluate(
    ({ id }) => window.sonataRuntime.writeTerminalUserInput({ taskId: id, data: "\r" }),
    { id: taskId },
  );

  // …and the banner retires on its own — no dismissal, no pty:exit. This is the
  // clearing path (plan L2) end-to-end in the real app.
  await banner.waitFor({ state: "detached", timeout: 60_000 });
  await shoot(main, "banner-retired", "answered in the CLI — the banner retired itself");

  console.log(JSON.stringify({ outDir, shots, taskId, success: true }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(root, { recursive: true, force: true });
}

/** The task's id is its own directory under the data root (the pattern
 *  midsession-permission-switch.mjs uses) — needed only to address the pty for
 *  the user's answer. */
async function waitForTaskId(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let entry = null;
    try {
      entry = fs
        .readdirSync(projectsDir, { withFileTypes: true })
        .find((item) => item.isDirectory())?.name;
    } catch {
      entry = null;
    }
    if (entry) {
      return entry;
    }
    await delay(250);
  }
  throw new Error("timed out waiting for the task directory");
}

async function shoot(page, name, note) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push({ name, note });
}

async function cliText(cli) {
  return (await cli.locator(".task-terminal .xterm-rows").first().textContent()) ?? "";
}

async function launch() {
  app = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot,
      SONATA_WORKSPACES_DIR: workspaceRoot,
      SONATA_SETTINGS_DIR: settingsDir,
      SONATA_TEST_PICK_FOLDER: selectedFolder,
      // The manufacture. Everything else here is ordinary e2e isolation.
      CODEX_HOME: codexHome,
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(60_000);
  return page;
}

async function waitForWindow(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find(predicate);
    if (found) {
      return found;
    }
    await delay(100);
  }
  throw new Error("timed out waiting for the CLI window");
}

async function waitUntil(predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
