import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

// Drives the New Chat composer (default draft provider: codex), so the
// picker is exercised end-to-end — IPC registry fetch included — without
// spawning a provider CLI.
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-slash-picker-"));

let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_PROJECTS_DIR: workspaceRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(30000);

  const input = page.locator("#prompt-input");
  await input.waitFor({ state: "visible" });

  // Block real session creation in case a submit slips through.
  await page.evaluate(() => {
    window.__duetComposerSubmitCount = 0;
    document.querySelector("#composer")?.addEventListener(
      "submit",
      (event) => {
        window.__duetComposerSubmitCount += 1;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true },
    );
  });

  // 1. "/" opens the picker with listed builtins.
  await input.fill("/");
  await page.locator(".slash-picker").waitFor({ state: "visible" });
  await page.locator(".slash-picker-option").first().waitFor({ state: "visible" });
  const allNames = await page.locator(".slash-picker-name").allTextContents();
  if (!allNames.includes("/status")) {
    throw new Error(`expected /status among codex entries, got: ${allNames.join(", ")}`);
  }
  const selectedCount = await page.locator(".slash-picker-option.selected").count();
  if (selectedCount !== 1) {
    throw new Error(`expected exactly one selected option, got ${selectedCount}`);
  }

  // 2. Narrowing: "/sta" ranks /status first.
  await input.fill("/sta");
  await page.waitForTimeout(120);
  const firstName = await page
    .locator(".slash-picker-option.selected .slash-picker-name")
    .first()
    .textContent();
  if (firstName !== "/status") {
    throw new Error(`expected /status selected for query "sta", got ${firstName}`);
  }

  // 3. Tab completes without submitting.
  await dispatchKey(page, "Tab");
  const completed = await input.inputValue();
  if (completed !== "/status ") {
    throw new Error(`expected Tab to complete "/status ", got "${completed}"`);
  }
  await assertPickerHidden(page, "after Tab completion");
  await expectSubmitCount(page, 0, "Tab must not submit");

  // 4. Unknown query shows the empty state.
  await input.fill("/zzz-nope");
  await page.locator(".slash-picker-empty").waitFor({ state: "visible" });

  // 5. Esc dismisses; the same value does not reopen; editing reopens.
  await dispatchKey(page, "Escape");
  await assertPickerHidden(page, "after Esc");
  await input.fill("/sta");
  await page.locator(".slash-picker").waitFor({ state: "visible" });

  // 6. ArrowDown moves the selection.
  await input.fill("/");
  await page.waitForTimeout(120);
  const before = await page
    .locator(".slash-picker-option.selected .slash-picker-name")
    .first()
    .textContent();
  await dispatchKey(page, "ArrowDown");
  const after = await page
    .locator(".slash-picker-option.selected .slash-picker-name")
    .first()
    .textContent();
  if (before === after) {
    throw new Error(`expected ArrowDown to move selection away from ${before}`);
  }
  await expectSubmitCount(page, 0, "navigation must not submit");

  console.log(JSON.stringify({ workspaceRoot, success: true }, null, 2));
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

async function dispatchKey(page, key) {
  await page.locator("#prompt-input").evaluate((element, keyName) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: keyName,
      }),
    );
  }, key);
}

async function assertPickerHidden(page, label) {
  const count = await page.locator(".slash-picker").count();
  if (count !== 0) {
    throw new Error(`expected picker hidden ${label}`);
  }
}

async function expectSubmitCount(page, expected, label) {
  const actual = await page.evaluate(() => window.__duetComposerSubmitCount);
  if (actual !== expected) {
    throw new Error(`${label}. Expected ${expected}, got ${actual}.`);
  }
}
