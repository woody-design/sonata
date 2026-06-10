import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { claudeArgs, codexArgs } = require("../../dist/runtime");

const codexFast = codexArgs({
  cwd: "/tmp/duet launch settings",
  sandbox: "read-only",
  approval: "on-request",
  model: "gpt-5.5",
  reasoningEffort: "xhigh",
  speedMode: "fast",
});
const codexDefaultSpeed = codexArgs({
  cwd: "/tmp/duet launch settings",
  sandbox: "workspace-write",
  approval: "never",
  model: "gpt-5.5",
  reasoningEffort: "medium",
  speedMode: "default",
});
const claude = claudeArgs({
  permissionMode: "default",
  model: "opus",
  reasoningEffort: "xhigh",
});
const claudeWithSettings = claudeArgs({
  permissionMode: "dontAsk",
  model: "fable",
  reasoningEffort: "high",
  settingsPath: "/tmp/duet usage/claude-statusline-settings.json",
});

const success =
  includesSequence(codexFast, ["-m", "gpt-5.5"]) &&
  includesSequence(codexFast, ["-c", 'model_reasoning_effort="xhigh"']) &&
  includesSequence(codexFast, ["-c", 'service_tier="priority"']) &&
  includesSequence(codexFast, ["-C", "/tmp/duet launch settings"]) &&
  includesSequence(codexFast, ["-s", "read-only"]) &&
  includesSequence(codexFast, ["-a", "on-request"]) &&
  includesSequence(codexDefaultSpeed, ["-c", 'model_reasoning_effort="medium"']) &&
  !codexDefaultSpeed.includes('service_tier="priority"') &&
  includesSequence(claude, ["--permission-mode", "default"]) &&
  includesSequence(claude, ["--model", "opus"]) &&
  includesSequence(claude, ["--effort", "xhigh"]) &&
  includesSequence(claudeWithSettings, ["--permission-mode", "dontAsk"]) &&
  includesSequence(claudeWithSettings, [
    "--settings",
    "/tmp/duet usage/claude-statusline-settings.json",
  ]) &&
  includesSequence(claudeWithSettings, ["--model", "fable"]) &&
  !claude.includes("service_tier");

console.log(
  JSON.stringify(
    {
      codexFast,
      codexDefaultSpeed,
      claude,
      claudeWithSettings,
      success,
    },
    null,
    2,
  ),
);

process.exitCode = success ? 0 : 1;

function includesSequence(values, sequence) {
  return values.some((value, index) =>
    sequence.every((expected, offset) => values[index + offset] === expected),
  );
}
