import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

// Drives the New Chat composer (default draft provider: codex), so the
// picker is exercised end-to-end — IPC registry fetch included — without
// spawning a provider CLI.
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-slash-picker-"));

let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot, SONATA_WORKSPACES_DIR: workspaceRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(30000);

  const input = page.locator("#prompt-input");
  await input.waitFor({ state: "visible" });

  // Block real session creation in case a submit slips through.
  await page.evaluate(() => {
    window.__sonataComposerSubmitCount = 0;
    document.querySelector("#composer")?.addEventListener(
      "submit",
      (event) => {
        window.__sonataComposerSubmitCount += 1;
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

  // 7. Mid-prompt: the picker tracks the token AT THE CURSOR, and completion
  //    rewrites ONLY that token — the rest of the draft is untouched
  //    (2026-07-27 decision 4: mid-prompt slash is insertion assist).
  await input.fill("fix this /sta");
  await page.locator(".slash-picker").waitFor({ state: "visible" });
  await page.waitForTimeout(120);
  const midSelected = await page
    .locator(".slash-picker-option.selected .slash-picker-name")
    .first()
    .textContent();
  if (midSelected !== "/status") {
    throw new Error(`expected /status selected for the mid-prompt token, got ${midSelected}`);
  }
  await dispatchKey(page, "Tab");
  const midCompleted = await input.inputValue();
  if (midCompleted !== "fix this /status ") {
    throw new Error(`expected Tab to complete the token only, got "${midCompleted}"`);
  }
  await assertPickerHidden(page, "after mid-prompt Tab completion");
  await expectSubmitCount(page, 0, "mid-prompt Tab must not submit");

  // 8. Mid-prompt Enter INSERTS too. /status is a bare passthrough command —
  //    as the whole input it would execute on Enter; mid-prompt it must not,
  //    because the CLI dispatches commands only at line start.
  await input.fill("fix this /sta");
  await page.locator(".slash-picker").waitFor({ state: "visible" });
  await page.waitForTimeout(120);
  await dispatchKey(page, "Enter");
  const midEnter = await input.inputValue();
  if (midEnter !== "fix this /status ") {
    throw new Error(`expected mid-prompt Enter to complete the token, got "${midEnter}"`);
  }
  await expectSubmitCount(page, 0, "mid-prompt Enter must not submit");

  // 9. Caret moves open and close the picker — no input event involved.
  await input.fill("fix this /status extra");
  await page.waitForTimeout(120);
  await assertPickerHidden(page, "with the caret past the end of the token");
  await setCaret(page, "fix this /status".length);
  await page.locator(".slash-picker").waitFor({ state: "visible" });
  const caretSelected = await page
    .locator(".slash-picker-option.selected .slash-picker-name")
    .first()
    .textContent();
  if (caretSelected !== "/status") {
    throw new Error(`expected the caret-move picker to filter by "status", got ${caretSelected}`);
  }
  await setCaret(page, "fix this /status extra".length);
  await page.locator(".slash-picker").waitFor({ state: "hidden" });
  await expectSubmitCount(page, 0, "caret movement must not submit");

  // 10. Mid-TOKEN completion replaces the whole token run, not just the part
  //     before the caret, so no tail residue is left behind — while filtering
  //     still reads the caret prefix only (ratified 2026-07-27: Slack/VS Code
  //     completion semantics). The following " now" also proves completion
  //     does not double the separating space.
  await input.fill("check /statusx now");
  await setCaret(page, "check /status".length);
  await page.locator(".slash-picker").waitFor({ state: "visible" });
  await page.waitForTimeout(120);
  const tailSelected = await page
    .locator(".slash-picker-option.selected .slash-picker-name")
    .first()
    .textContent();
  if (tailSelected !== "/status") {
    throw new Error(`expected the caret-prefix query to select /status, got ${tailSelected}`);
  }
  await dispatchKey(page, "Tab");
  const tailReplaced = await input.inputValue();
  if (tailReplaced !== "check /status now") {
    throw new Error(`expected the whole token run replaced, got "${tailReplaced}"`);
  }
  await expectSubmitCount(page, 0, "mid-token completion must not submit");

  // 11. A pasted absolute path is not a command: the picker shows the empty
  //     state, the arrow keys stay with the CARET (there is no selection to
  //     move — swallowing them would freeze vertical movement until Esc), and
  //     a SINGLE Enter submits the text verbatim (decision 3 — the
  //     double-Enter unknown-command guard is retired).
  await input.fill("look at\n/Users/nobody/some/path");
  const emptyState = page.locator(".slash-picker-empty");
  await emptyState.waitFor({ state: "visible" });
  const emptyText = await emptyState.textContent();
  if (emptyText !== "No commands") {
    throw new Error(`expected the "No commands" empty state, got "${emptyText}"`);
  }
  for (const key of ["ArrowUp", "ArrowDown"]) {
    if (await dispatchKeyPrevented(page, key)) {
      throw new Error(`expected ${key} to fall through to the caret on the empty state`);
    }
  }
  await expectSubmitCount(page, 0, "the path must not have submitted yet");
  await dispatchKey(page, "Enter");
  await expectSubmitCount(page, 1, "a pasted path submits verbatim on one Enter");

  // 12. …and with options showing, the arrows are still the picker's.
  await input.fill("/");
  await page.locator(".slash-picker-option").first().waitFor({ state: "visible" });
  for (const key of ["ArrowUp", "ArrowDown"]) {
    if (!(await dispatchKeyPrevented(page, key))) {
      throw new Error(`expected ${key} to drive the picker while options are listed`);
    }
  }
  await expectSubmitCount(page, 1, "picker navigation must not submit");

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

/** Dispatch a key and report whether the composer claimed it (preventDefault).
 *  A synthetic keydown never moves the caret itself, so "did the handler take
 *  it?" is the observable that matters for key-ownership questions. */
async function dispatchKeyPrevented(page, key) {
  return await page.locator("#prompt-input").evaluate((element, keyName) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: keyName });
    return !element.dispatchEvent(event);
  }, key);
}

/** Move the caret without touching the value — the composer's `selectionchange`
 *  tracking is what must notice it. */
async function setCaret(page, offset) {
  await page.locator("#prompt-input").evaluate((element, index) => {
    element.focus();
    element.setSelectionRange(index, index);
  }, offset);
}

async function assertPickerHidden(page, label) {
  const count = await page.locator(".slash-picker").count();
  if (count !== 0) {
    throw new Error(`expected picker hidden ${label}`);
  }
}

async function expectSubmitCount(page, expected, label) {
  const actual = await page.evaluate(() => window.__sonataComposerSubmitCount);
  if (actual !== expected) {
    throw new Error(`${label}. Expected ${expected}, got ${actual}.`);
  }
}
