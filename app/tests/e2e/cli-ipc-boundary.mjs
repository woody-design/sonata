import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "duet-cli-ipc-"));
let app;

try {
  app = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: root,
      DUET_WORKSPACES_DIR: root,
      DUET_NOTIFICATIONS: "0",
    },
  });
  const main = await app.firstWindow();
  const terminal = await waitForWindow(app, (page) => page.url().endsWith("/terminal.html"));
  await main.locator("#prompt-input").waitFor({ state: "visible" });

  await main.evaluate(() => {
    window.__cliActions = [];
    window.duetRuntime.onCliAction((request) => window.__cliActions.push(request));
  });
  await terminal.evaluate(() => {
    window.__cliActions = [];
    window.duetRuntime.onCliAction((request) => window.__cliActions.push(request));
  });

  const binding = await terminal.evaluate(() => window.duetRuntime.readActiveTerminalTask());
  const terminalCannotSetBinding = await rejects(() =>
    terminal.evaluate((value) => window.duetRuntime.setActiveTerminalTask(value), binding),
  );
  const mainCanSetBinding = await main.evaluate((value) =>
    window.duetRuntime.setActiveTerminalTask(value).then(() => true),
    binding,
  );
  const mainCannotRequestAction = await rejects(() =>
    main.evaluate(() =>
      window.duetRuntime.requestCliAction({ action: "resume", expectedTaskId: "ghost" }),
    ),
  );
  const malformedRejected = await rejects(() =>
    terminal.evaluate(() =>
      window.duetRuntime.setActiveTerminalTask({
        taskId: null,
        live: true,
        openTaskIds: [],
        projectName: "Tasks",
        sessionTitle: "New task",
        emptySurface: { kind: "none" },
      }),
    ),
  );

  await terminal.evaluate(() =>
    window.duetRuntime.requestCliAction({ action: "resume", expectedTaskId: "ghost" }),
  );
  await main.waitForFunction(() => window.__cliActions.length === 1);
  const mainActions = await main.evaluate(() => window.__cliActions);
  const terminalActions = await terminal.evaluate(() => window.__cliActions);

  // A session can stay open in Reading while its PTY is retired. The CLI must
  // drop that PTY's xterm, show the resumable dormant surface, then build a new
  // xterm when the same task becomes live again (never reuse the dead buffer).
  const lifecycleTaskId = "ipc-lifecycle-task";
  const liveBinding = {
    taskId: lifecycleTaskId,
    live: true,
    openTaskIds: [lifecycleTaskId],
    projectName: "IPC project",
    sessionTitle: "Lifecycle task",
    emptySurface: { kind: "none" },
  };
  await main.evaluate((value) => window.duetRuntime.setActiveTerminalTask(value), liveBinding);
  const firstTerminal = terminal.locator(".task-terminal");
  await firstTerminal.waitFor({ state: "attached" });
  await firstTerminal.evaluate((element) => {
    element.dataset.lifecycleInstance = "first";
  });

  await main.evaluate(
    ({ value, taskId }) =>
      window.duetRuntime.setActiveTerminalTask({
        ...value,
        live: false,
        emptySurface: { kind: "dormant", phase: "ready", taskId },
      }),
    { value: liveBinding, taskId: lifecycleTaskId },
  );
  await terminal.locator("#terminal-empty-action", { hasText: "Resume task" }).waitFor({
    state: "visible",
  });
  const dormantDisposedXterm = (await terminal.locator(".task-terminal").count()) === 0;

  await main.evaluate((value) => window.duetRuntime.setActiveTerminalTask(value), liveBinding);
  const resumedTerminal = terminal.locator(".task-terminal");
  await resumedTerminal.waitFor({ state: "attached" });
  const resumedWithFreshXterm = await resumedTerminal.evaluate(
    (element) => element.dataset.lifecycleInstance !== "first",
  );

  const checks = {
    terminalCannotSetBinding,
    mainCanSetBinding,
    mainCannotRequestAction,
    malformedRejected,
    actionRelayedOnlyToMain:
      mainActions.length === 1 &&
      mainActions[0]?.action === "resume" &&
      mainActions[0]?.expectedTaskId === "ghost" &&
      terminalActions.length === 0,
    dormantDisposedXterm,
    resumedWithFreshXterm,
  };
  const success = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ success, checks }, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
}

async function waitForWindow(electronApp, predicate) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const page of electronApp.windows()) {
      if (predicate(page)) {
        return page;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for CLI window.");
}

async function rejects(run) {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}
