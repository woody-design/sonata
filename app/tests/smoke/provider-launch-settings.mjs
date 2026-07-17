import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { claudeArgs, codexArgs, ensureClaudeRuntimeSettings } = require("../../dist/runtime");

const codexFast = codexArgs({
  cwd: "/tmp/sonata launch settings",
  permissionMode: "ask-for-approval",
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
  speedMode: "fast",
});
const codexDefaultSpeed = codexArgs({
  cwd: "/tmp/sonata launch settings",
  permissionMode: "full-access",
  model: "gpt-5.5",
  reasoningEffort: "medium",
  speedMode: "default",
});
// With the Sonata hook profile injected, the spawn MUST carry
// `--dangerously-bypass-hook-trust` — codex can't persist hook trust through a
// profile layer, so without it every session re-prompts for hook review (D4
// overturn 2026-07-06; spikes/codex-hook-trust-research). Gated on `profile`:
// a bare spawn (no hooks) must NOT carry the dangerous flag.
const codexWithProfile = codexArgs({
  cwd: "/tmp/sonata launch settings",
  permissionMode: "ask-for-approval",
  profile: "sonata",
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
  settingsPath: "/tmp/sonata usage/claude-statusline-settings.json",
});

// Claude native fast mode has NO claudeArgs flag — it rides in the injected
// `--settings` file as `"fastMode": true` (probe: spikes/claude-fastmode-inject/,
// the `↯` glyph flips on iff this key is present). Assert both directions: fast
// writes the key; standard omits it entirely (not `false`) so a standard-speed
// spawn's settings file stays byte-identical to the pre-feature shape.
const fastRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-launch-fast-"));
const standardRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-launch-standard-"));
const fastSettings = JSON.parse(
  fs.readFileSync(
    ensureClaudeRuntimeSettings(fastRuntimeDir, { approvalBroker: false, fastMode: true }),
    "utf8",
  ),
);
const standardSettings = JSON.parse(
  fs.readFileSync(
    ensureClaudeRuntimeSettings(standardRuntimeDir, { approvalBroker: false, fastMode: false }),
    "utf8",
  ),
);
fs.rmSync(fastRuntimeDir, { recursive: true, force: true });
fs.rmSync(standardRuntimeDir, { recursive: true, force: true });

const success =
  includesSequence(codexFast, ["-m", "gpt-5.6-sol"]) &&
  includesSequence(codexFast, ["-c", 'model_reasoning_effort="ultra"']) &&
  includesSequence(codexFast, ["-c", 'service_tier="priority"']) &&
  includesSequence(codexFast, ["-C", "/tmp/sonata launch settings"]) &&
  // ask-for-approval fans out to the workspace-write / on-request / user row.
  includesSequence(codexFast, ["-s", "workspace-write"]) &&
  includesSequence(codexFast, ["-a", "on-request"]) &&
  includesSequence(codexFast, ["-c", 'approvals_reviewer="user"']) &&
  // full-access fans out to the danger-full-access / never / user row.
  includesSequence(codexDefaultSpeed, ["-s", "danger-full-access"]) &&
  includesSequence(codexDefaultSpeed, ["-a", "never"]) &&
  includesSequence(codexDefaultSpeed, ["-c", 'approvals_reviewer="user"']) &&
  includesSequence(codexDefaultSpeed, ["-c", 'model_reasoning_effort="medium"']) &&
  !codexDefaultSpeed.includes('service_tier="priority"') &&
  // profile → bypass flag present, right after `-p sonata`
  includesSequence(codexWithProfile, ["-p", "sonata"]) &&
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
    "/tmp/sonata usage/claude-statusline-settings.json",
  ]) &&
  includesSequence(claudeWithSettings, ["--model", "fable"]) &&
  !claude.includes("service_tier") &&
  // Fast injection: the key is present and true, and the file still carries the
  // statusLine + hooks sinks (fastMode UNIONs, it does not replace them).
  fastSettings.fastMode === true &&
  Boolean(fastSettings.statusLine) &&
  Boolean(fastSettings.hooks) &&
  // Standard: no fastMode key at all (byte-identical to the pre-feature file).
  !("fastMode" in standardSettings) &&
  Boolean(standardSettings.statusLine) &&
  Boolean(standardSettings.hooks);

console.log(
  JSON.stringify(
    {
      codexFast,
      codexDefaultSpeed,
      codexWithProfile,
      claude,
      claudeWithSettings,
      fastSettingsKeys: Object.keys(fastSettings),
      standardSettingsKeys: Object.keys(standardSettings),
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
