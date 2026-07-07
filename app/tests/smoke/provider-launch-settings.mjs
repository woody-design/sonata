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
// With the Duet hook profile injected, the spawn MUST carry
// `--dangerously-bypass-hook-trust` — codex can't persist hook trust through a
// profile layer, so without it every session re-prompts for hook review (D4
// overturn 2026-07-06; spikes/codex-hook-trust-research). Gated on `profile`:
// a bare spawn (no hooks) must NOT carry the dangerous flag.
const codexWithProfile = codexArgs({
  cwd: "/tmp/duet launch settings",
  sandbox: "read-only",
  approval: "on-request",
  profile: "duet",
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
  // profile → bypass flag present, right after `-p duet`
  includesSequence(codexWithProfile, ["-p", "duet"]) &&
  codexWithProfile.includes("--dangerously-bypass-hook-trust") &&
  // no profile → NO bypass flag (gating: bare spawn stays clean)
  !codexFast.includes("--dangerously-bypass-hook-trust") &&
  !codexDefaultSpeed.includes("--dangerously-bypass-hook-trust") &&
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
      codexWithProfile,
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
