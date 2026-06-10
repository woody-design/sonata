import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalHost, cleanTerminal } = require("../../dist/runtime");

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-native-control-smoke-"));
const codexConfigPath = path.join(os.homedir(), ".codex", "config.toml");
const claudeSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
const codexConfigBefore = readText(codexConfigPath);
const claudeSettingsBefore = readText(claudeSettingsPath);
const results = [];

try {
  results.push(await runCodexPermissions());
  results.push(await runCodexModelEffort());
  results.push(await runClaudePermissionCycle());
  results.push(await runClaudeModelEffort());

  const success = results.every((result) => result.verified);
  console.log(JSON.stringify({ workspaceRoot, success, results }, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  if (codexConfigBefore !== null) {
    fs.writeFileSync(codexConfigPath, codexConfigBefore);
  }
  if (claudeSettingsBefore !== null) {
    fs.writeFileSync(claudeSettingsPath, claudeSettingsBefore);
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

async function runCodexPermissions() {
  const controller = await startHost("codex", "codex-permission", {
    sandbox: "read-only",
    approval: "on-request",
  });
  try {
    const result = await controller.host.applyControlChange({
      kind: "permission",
      label: "Full Access",
      codex: {
        preset: "fullAccess",
        sandbox: "danger-full-access",
        approval: "never",
      },
      claude: null,
    });
    return {
      name: "codex permission switch",
      verified: /Permissions updated to\s+Full Access/i.test(result.evidence),
      evidenceTail: redact(result.evidence.slice(-1200)),
    };
  } finally {
    controller.dispose();
  }
}

async function runCodexModelEffort() {
  const controller = await startHost("codex", "codex-model", {
    sandbox: "read-only",
    approval: "on-request",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
  });
  try {
    const result = await controller.host.applyControlChange({
      kind: "model",
      label: "5.5 Extra High",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
    });
    return {
      name: "codex model and effort switch",
      verified: /gpt-5\.5|model|effort|reasoning/i.test(result.evidence),
      evidenceTail: redact(result.evidence.slice(-1200)),
    };
  } finally {
    controller.dispose();
  }
}

async function runClaudePermissionCycle() {
  const controller = await startHost("claude", "claude-permission", {
    permissionMode: "default",
    model: "opus",
    reasoningEffort: "xhigh",
  });
  try {
    const result = await controller.host.applyControlChange({
      kind: "permission",
      label: "plan",
      codex: null,
      claude: {
        permissionMode: "plan",
      },
    });
    return {
      name: "claude shift-tab permission landing",
      verified: /plan/i.test(result.evidence),
      evidenceTail: redact(result.evidence.slice(-1200)),
    };
  } finally {
    controller.dispose();
  }
}

async function runClaudeModelEffort() {
  const controller = await startHost("claude", "claude-model", {
    permissionMode: "default",
    model: "opus",
    reasoningEffort: "xhigh",
  });
  try {
    const result = await controller.host.applyControlChange({
      kind: "model",
      label: "Sonnet Low",
      model: "sonnet",
      reasoningEffort: "low",
    });
    const settingsAfter = readJson(claudeSettingsPath);
    return {
      name: "claude model and effort commands",
      verified:
        /sonnet|model/i.test(result.evidence) &&
        /low|effort/i.test(result.evidence) &&
        JSON.stringify(settingsAfter).includes("sonnet") &&
        JSON.stringify(settingsAfter).includes("low"),
      evidenceTail: redact(result.evidence.slice(-1200)),
    };
  } finally {
    controller.dispose();
  }
}

async function startHost(provider, name, options) {
  const workspace = path.join(workspaceRoot, name);
  fs.mkdirSync(workspace, { recursive: true });
  let ready = false;
  let exited = false;
  let raw = "";
  let workspaceTrustApproved = false;
  const host = new TerminalHost({
    taskId: `native-control-${name}`,
    provider,
    defaultWorkspace: workspace,
    eventSink: (event) => {
      if (event.type === "pty:data") {
        raw = `${raw}${event.payload.data}`.slice(-64_000);
      }
      if (event.type === "task:ready") {
        ready = true;
      }
      if (event.type === "pty:exit") {
        exited = true;
      }
      if (
        event.type === "approval:detected" &&
        event.payload.kind === "workspace-trust" &&
        !workspaceTrustApproved
      ) {
        workspaceTrustApproved = true;
        host.sendApprove();
      }
    },
  });
  host.startTask({
    cwd: workspace,
    rows: 42,
    cols: 140,
    ...options,
  });
  await waitUntil(() => ready || exited, 180000, () => cleanTerminal(raw).slice(-3000));
  if (exited) {
    throw new Error(`${provider} exited before ready.\n\n${redact(cleanTerminal(raw).slice(-3000))}`);
  }
  await delay(1000);
  return {
    host,
    dispose: () => host.dispose(),
  };
}

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function readJson(filePath) {
  const text = readText(filePath);
  return text ? JSON.parse(text) : null;
}

async function waitUntil(predicate, timeoutMs, context) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for native control smoke readiness.\n\n${redact(context())}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(value) {
  return value
    .replaceAll(os.homedir(), "~")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
}
