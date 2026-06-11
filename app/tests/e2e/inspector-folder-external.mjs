import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId, sendFirstPrompt, waitForCompletedTurns } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-inspector-folder-e2e-"));
let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_PROJECTS_DIR: workspaceRoot,
    },
  });
  await installExternalOpenProbe(electronApp);

  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(180000);

  // Sessions are born from the first composer message (deferred creation);
  // this suite only needs a live session workspace, so use a no-op prompt.
  await sendFirstPrompt(page, [
    "Reply exactly DUET_FOLDER_SESSION_READY.",
    "Do not create or modify any files.",
  ]);
  const taskId = await activeSessionTaskId(page);
  if (!taskId) {
    throw new Error("Sidebar session did not expose a task id.");
  }
  await waitForCompletedTurns(page, 1);

  const taskWorkspace = path.join(workspaceRoot, taskId);
  const reviewFilePath = path.join(taskWorkspace, "folder_review.md");
  fs.writeFileSync(reviewFilePath, "Inspector folder external opening ready.\n", "utf8");

  const inspectorWindowPromise = electronApp.waitForEvent("window");
  await page.locator("#open-inspector-window").click();
  const inspectorPage = await inspectorWindowPromise;
  inspectorPage.setDefaultTimeout(180000);

  await inspectorPage.locator(".inspector-window-tab", { hasText: "Folder" }).click();
  await inspectorPage.locator(".workspace-tree-item", { hasText: "folder_review.md" }).click();
  await inspectorPage.locator(".text-preview", {
    hasText: "Inspector folder external opening ready.",
  }).waitFor({ state: "visible" });

  await inspectorPage.locator("#open-workspace-folder").click();
  await inspectorPage.locator("#inspector-window-status", { hasText: "Opened folder" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator("#open-workspace-cursor").click();
  await inspectorPage.locator("#inspector-window-status", { hasText: "Opened workspace in Cursor" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-action", { hasText: "Open File in Cursor" }).click();
  await inspectorPage.locator("#inspector-window-status", { hasText: "Opened file in Cursor" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-action", { hasText: "Reveal in Folder" }).click();
  await inspectorPage.locator("#inspector-window-status", { hasText: "Revealed in folder" }).waitFor({
    state: "visible",
  });

  const calls = await readExternalOpenCalls(electronApp);
  const reports = readReports(workspaceRoot);
  const reportText = JSON.stringify(reports);
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("OpenAI Codex") ||
    reportText.includes("Do you trust the contents of this directory");
  const workspaceFolderOpened = calls.some(
    (call) => call.method === "openPath" && call.path === taskWorkspace,
  );
  const cursorWorkspaceOpened = calls.some(
    (call) => call.method === "openExternal" && call.url.startsWith("cursor://file") && call.url.includes(taskId),
  );
  const cursorFileOpened = calls.some(
    (call) =>
      call.method === "openExternal" &&
      call.url.startsWith("cursor://file") &&
      call.url.includes("folder_review.md"),
  );
  const fileRevealed = calls.some(
    (call) => call.method === "showItemInFolder" && call.path === reviewFilePath,
  );
  const success =
    reports.length === 1 &&
    workspaceFolderOpened &&
    cursorWorkspaceOpened &&
    cursorFileOpened &&
    fileRevealed &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskId,
        taskWorkspace,
        calls,
        rawTerminalPersisted,
        success,
      },
      null,
      2,
    ),
  );

  process.exitCode = success ? 0 : 1;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

async function installExternalOpenProbe(electronApp) {
  await electronApp.evaluate(({ shell }) => {
    globalThis.__duetExternalOpenCalls = [];
    shell.openPath = async (targetPath) => {
      globalThis.__duetExternalOpenCalls.push({ method: "openPath", path: targetPath });
      return "";
    };
    shell.openExternal = async (url) => {
      globalThis.__duetExternalOpenCalls.push({ method: "openExternal", url });
    };
    shell.showItemInFolder = (targetPath) => {
      globalThis.__duetExternalOpenCalls.push({ method: "showItemInFolder", path: targetPath });
    };
  });
}

async function readExternalOpenCalls(electronApp) {
  return electronApp.evaluate(() => globalThis.__duetExternalOpenCalls ?? []);
}

function readReports(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, ".duet", "runtime-report.json"))
    .filter((reportPath) => fs.existsSync(reportPath))
    .map((reportPath) => JSON.parse(fs.readFileSync(reportPath, "utf8")));
}
