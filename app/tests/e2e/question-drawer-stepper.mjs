// Focus/flow S1 — the question drawer's GRAMMAR, walked end to end without a
// live CLI: stepper, single-select auto-advance, multi-select toggles, the
// explicit Next, Review, back-navigation into an answered question, the
// free-text row superseding a pick, Send, and the reconciled receipt handing the
// composer back.
//
// Why this exists next to tests/e2e/option-prompt-surface.mjs (which walks the
// same drawer against REAL claude): S1 rebuilt this card as an in-place
// reconciler so the free-text field can keep its DOM node (see
// question-drawer-focus-storm.mjs). That is a structural change to every step
// transition in the form, and its only previous fence needs a real CLI, a real
// model turn and the network. This one drives the same states through the hook
// sink in seconds, so the reconciler's step/identity handling stays honest on
// every run — the real-CLI test remains the proof that the KEY GRAMMAR reaches
// Claude, which this one deliberately does not claim.
//
// Fixture provenance: COMPOSED hook payloads, to the shapes their parsers pin
// (parseOptionPrompt for tool_input, reconcileOptionPromptAnswers for
// tool_response). The questions are ADAPTED from the real-claude prompts in
// option-prompt-surface.mjs / option-prompt-multiselect.mjs (same headers,
// labels and multiSelect mix), so the drawer renders the shape it renders live.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId } from "./helpers/session.mjs";
import { installFakeCli } from "./helpers/fake-cli.mjs";

const TOOL_USE_ID = "toolu-stepper-1";
const SESSION_ID = "stepper-session";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-drawer-stepper-"));
const dataRoot = path.join(root, "data-root");
const settingsDir = path.join(root, "settings");
const fakeBin = path.join(root, "bin");
const project = path.join(root, "project");
for (const dir of [settingsDir, fakeBin, project]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(
  path.join(settingsDir, "claude-settings.json"),
  `${JSON.stringify({ defaultPermissionMode: "default", defaultRemoteControl: false }, null, 2)}\n`,
);
installFakeCli(fakeBin, "claude", {
  readyOutput: "Fake Claude ready\n❯ opus xhigh ~\n",
  records: ["stdin"],
  echoStdin: true,
});

let app;
const checks = {};
try {
  app = await electron.launch({
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
  const main = await app.firstWindow();
  main.setDefaultTimeout(20_000);
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  await chooseProject(main);
  await main.locator("#prompt-input").click();
  await main.locator("#prompt-input").fill("ask me something");
  await main.keyboard.press("Enter");
  const taskId = await waitForActiveTask(main);
  await waitFor(() => readStdin(taskId).includes("ask me something"), "first delivery");

  fireHook(taskId, {
    hook_event_name: "PreToolUse",
    session_id: SESSION_ID,
    tool_name: "AskUserQuestion",
    tool_use_id: TOOL_USE_ID,
    tool_input: {
      questions: [
        {
          header: "Fruit",
          question: "Which fruit?",
          multiSelect: false,
          options: [
            { label: "Banana", description: "a tropical fruit" },
            { label: "Cherry", description: "a stone fruit" },
            { label: "Apple", description: "a pome fruit" },
          ],
        },
        {
          header: "Langs",
          question: "Which languages do you use?",
          multiSelect: true,
          options: [
            { label: "Python", description: "py" },
            { label: "Rust", description: "rs" },
            { label: "Go", description: "go" },
          ],
        },
      ],
    },
  });

  const card = main.locator("#option-prompt-card");
  await main.locator('#option-prompt-card[data-state="asking"]').waitFor({ state: "visible" });
  await main.locator("#composer.drawer-active").waitFor({ state: "visible" });
  await card.locator(".drawer-step", { hasText: "1 of 2" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-badge", { hasText: "Fruit" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-option-desc", { hasText: "a pome fruit" }).waitFor({ state: "visible" });
  checks.steppedOneQuestion = (await card.locator(".option-prompt-question").count()) === 1;
  checks.singleSelectHasFreeText = (await card.locator(".option-prompt-freetext-input").count()) === 1;

  // Single-select pick auto-advances onto the multi-select question.
  await card.locator(".option-prompt-option", { hasText: "Apple" }).click();
  await card.locator(".drawer-step", { hasText: "2 of 2" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-badge", { hasText: "Langs" }).waitFor({ state: "visible" });
  checks.multiSelectHasNoFreeText = (await card.locator(".option-prompt-freetext-input").count()) === 0;
  checks.multiSelectTag =
    (await card.locator(".option-prompt-multi-tag").textContent()) === "choose one or more";

  // Toggles hold across each other's renders, and the footer Next carries the step.
  await card.locator(".option-prompt-option", { hasText: "Python" }).click();
  await card.locator(".option-prompt-option", { hasText: "Go" }).click();
  checks.multiSelectToggles =
    (await card.locator(".option-prompt-option.selected").count()) === 2 &&
    (await card.locator(".option-prompt-option.selected", { hasText: "Rust" }).count()) === 0;
  await card.locator(".option-prompt-actions .option-prompt-step-next").click();
  await card.locator(".drawer-step", { hasText: "Review" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-review-row", { hasText: "Apple" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-review-row", { hasText: "Python, Go" }).waitFor({ state: "visible" });
  checks.reviewListsBothAnswers = true;

  // Back into Q1 from Review: the pick is intact, and the free-text row (a NEW
  // step, so a new field) supersedes it when typed into.
  await card.locator(".option-prompt-review-row", { hasText: "Apple" }).click();
  await card.locator(".option-prompt-option.selected", { hasText: "Apple" }).waitFor({ state: "visible" });
  checks.reviewRowReopensQuestion = true;
  const freeText = card.locator(".option-prompt-freetext-input");
  await freeText.click();
  await freeText.fill("a pomelo");
  checks.freeTextSupersedesPick = (await card.locator(".option-prompt-option.selected").count()) === 0;
  // Enter in the field advances the step (it never inserts a newline). Advance =
  // the next UNANSWERED question, else Review — Q2 is answered, so: Review.
  await main.keyboard.press("Enter");
  await card.locator(".drawer-step", { hasText: "Review" }).waitFor({ state: "visible" });
  checks.freeTextEnterAdvances = true;
  await card.locator(".option-prompt-review-row", { hasText: "a pomelo" }).waitFor({ state: "visible" });
  checks.reviewShowsFreeText = true;

  // Send, then the CLI's own PostToolUse reconciles the receipt.
  await card.locator(".option-prompt-actions button.primary", { hasText: "Send answers" }).click();
  fireHook(taskId, {
    hook_event_name: "PostToolUse",
    session_id: SESSION_ID,
    tool_name: "AskUserQuestion",
    tool_use_id: TOOL_USE_ID,
    tool_response: {
      answers: { "Which fruit?": "a pomelo", "Which languages do you use?": ["Python", "Go"] },
    },
  });
  await main.locator('#option-prompt-card[data-state="answered"]').waitFor({ state: "visible" });
  await card.locator(".eyebrow", { hasText: "Your answer:" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-receipt-choice", { hasText: "a pomelo" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-receipt-choice", { hasText: "Python, Go" }).waitFor({ state: "visible" });
  checks.reconciledReceipt = true;
  // The drawer resolved: the composer comes back and takes the caret (the
  // blocking→free edge, which S1 now derives from state).
  await main.locator("#composer:not(.drawer-active)").waitFor({ state: "visible" });
  checks.composerReturnedFocused =
    (await main.evaluate(() => document.activeElement?.id)) === "prompt-input";

  const success = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ success, checks, taskId }, null, 2));
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ success: false, checks, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
}

/** Write a hook payload the way Sonata's own sink does (tmp + rename into the
 *  task's runtime hooks dir), which is the only thing the watcher cares about. */
function fireHook(taskId, payload) {
  const hooksDir = path.join(runtimeRoot(taskId), "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(
    hooksDir,
    `hook-${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}.json`,
  );
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(payload), "utf8");
  fs.renameSync(`${file}.tmp`, file);
}

async function chooseProject(page) {
  await page.locator("#project-chip").click();
  await page.locator("#entry-choose-folder").click();
  await page
    .locator("#project-chip", { hasText: path.basename(project) })
    .waitFor({ state: "visible" });
}

async function waitForActiveTask(page) {
  await waitFor(async () => Boolean(await activeSessionTaskId(page).catch(() => null)), "active task");
  return activeSessionTaskId(page);
}

function runtimeRoot(taskId) {
  return path.join(dataRoot, "data", "runtime", taskId);
}

function readStdin(taskId) {
  try {
    return fs.readFileSync(path.join(runtimeRoot(taskId), "stdin.bin"), "utf8");
  } catch {
    return "";
  }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
