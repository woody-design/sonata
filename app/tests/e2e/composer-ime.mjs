import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-composer-ime-"));

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

  // No session needed: the New Chat composer handles IME exactly like the
  // task composer, and the submit listener below blocks session creation.
  await page.locator("#prompt-input").waitFor({ state: "visible" });
  await page.locator("#prompt-input").fill("G4");

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

  await dispatchCompositionEnter(page, { phase: "during" });
  await expectSubmitCount(page, 0, "Enter during IME composition must not submit");

  await dispatchCompositionEnter(page, { phase: "ended" });
  await expectSubmitCount(page, 0, "Enter that commits IME composition must not submit");

  await dispatchKeyCode229Enter(page);
  await expectSubmitCount(page, 0, "IME process Enter must not submit");

  await page.waitForTimeout(120);
  await dispatchPlainEnter(page);
  await expectSubmitCount(page, 1, "Enter after composition settles should submit");

  console.log(JSON.stringify({ workspaceRoot, success: true }, null, 2));
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

async function dispatchCompositionEnter(page, { phase }) {
  await page.locator("#prompt-input").evaluate((input, currentPhase) => {
    if (currentPhase === "during") {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "G" }));
    } else {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "G" }));
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "G4" }));
    }
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        isComposing: currentPhase === "during",
      }),
    );
    if (currentPhase === "during") {
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "G4" }));
    }
  }, phase);
}

async function dispatchKeyCode229Enter(page) {
  await page.locator("#prompt-input").evaluate((input) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });
    Object.defineProperty(event, "keyCode", { get: () => 229 });
    input.dispatchEvent(event);
  });
}

async function dispatchPlainEnter(page) {
  await page.locator("#prompt-input").evaluate((input) => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    );
  });
}

async function expectSubmitCount(page, expected, label) {
  const actual = await page.evaluate(() => window.__sonataComposerSubmitCount);
  if (actual !== expected) {
    throw new Error(`${label}. Expected ${expected}, got ${actual}.`);
  }
}
