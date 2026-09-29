import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_CODEX_SETTINGS,
  normalizeCodexSettings,
} = require("../../dist/shared/types/codex-settings");
const {
  DEFAULT_SONATA_SETTINGS,
  normalizeSonataSettings,
} = require("../../dist/shared/types/sonata-settings");
const {
  DEFAULT_CLAUDE_SETTINGS,
  normalizeClaudeSettings,
} = require("../../dist/shared/types/claude-settings");
const { DEFAULT_RESUME_SETTINGS } = require("../../dist/shared/types/resume-settings");
const { DEFAULT_READING_SETTINGS } = require("../../dist/shared/types/reading-settings");
const { createInitialState } = require("../../dist/reading-core/state");

const failures = [];
function check(name, condition) {
  if (!condition) failures.push(name);
}

const freshSonata = normalizeSonataSettings(null);
const freshCodex = normalizeCodexSettings(null);
const initialState = createInitialState({ ...DEFAULT_READING_SETTINGS });

// Provider is a last-used RECORD, not a fresh-install default (S3/L3): a machine
// that has never started a session knows no provider, and the draft's own seed
// supplies Claude. The record's absent state must therefore stay ABSENT — a
// fresh install that pre-declared "claude" is exactly the sticky wrong answer
// the rule exists to avoid. Migration + the seed table: last-used-provider.mjs.
check("a fresh install records no provider", DEFAULT_SONATA_SETTINGS.lastUsedProvider === null);
check("fresh Sonata settings normalize to no record", freshSonata.lastUsedProvider === null);
check("fresh main surface defaults to Light", DEFAULT_READING_SETTINGS.mode === "light");
check("initial last-used mirror is absent", initialState.lastUsedProvider === null);
check("initial New Chat draft is Claude", initialState.taskDraft.provider === "claude");
// gpt-6-astra since 2026-09-10 (codex 0.154.0 promoted it to the picker's
// `(default)` row — MEASURED, spikes/codex-0.154-gpt-6-astra/q36; still the
// default at 0.156.1, q39). Effort stays High deliberately: Astra's own default
// tier is not Sonata's to inherit (Low at 0.154.0, Medium at 0.156.1 — q39b).
check("fresh Codex model is 6 Astra", DEFAULT_CODEX_SETTINGS.defaultModel === "gpt-6-astra");
check("fresh Codex effort is High", DEFAULT_CODEX_SETTINGS.defaultReasoningEffort === "high");
check(
  "normalized Codex defaults stay 6 Astra High",
  freshCodex.defaultModel === "gpt-6-astra" && freshCodex.defaultReasoningEffort === "high",
);
check(
  "initial draft stays 6 Astra High",
  initialState.taskDraft.model.codex === "gpt-6-astra" &&
    initialState.taskDraft.reasoningEffort.codex === "high",
);
// Fresh-install Claude defaults (reset 2026-09-29 to the standing daily-driver
// configuration): 1M-context Opus at High, Auto approvals; Codex Full Access;
// large-session resume = full. Mirrored by createInitialState.
const freshClaude = normalizeClaudeSettings(null);
check("fresh Claude model is Opus 5.5 (1M context)", DEFAULT_CLAUDE_SETTINGS.defaultModel === "opus[1m]");
check("fresh Claude effort is High", DEFAULT_CLAUDE_SETTINGS.defaultReasoningEffort === "high");
check("fresh Claude approvals are Auto", DEFAULT_CLAUDE_SETTINGS.defaultPermissionMode === "auto");
check("fresh Remote Control is off", DEFAULT_CLAUDE_SETTINGS.defaultRemoteControl === false);
check(
  "normalized Claude defaults stay 1M Opus High Auto",
  freshClaude.defaultModel === "opus[1m]" &&
    freshClaude.defaultReasoningEffort === "high" &&
    freshClaude.defaultPermissionMode === "auto",
);
check(
  "initial draft stays 1M Opus High",
  initialState.taskDraft.model.claude === "opus[1m]" &&
    initialState.taskDraft.reasoningEffort.claude === "high",
);
check(
  "initial permission mirrors are Auto / Full Access",
  initialState.claudeDefaultPermissionMode === "auto" &&
    initialState.codexDefaultPermissionMode === "full-access",
);
check("fresh Codex approvals are Full Access", DEFAULT_CODEX_SETTINGS.defaultPermissionMode === "full-access");
check("fresh Codex keeps itself up to date", DEFAULT_CODEX_SETTINGS.keepCodexUpToDate === true);
check("fresh large-session resume is full", DEFAULT_RESUME_SETTINGS.policy === "full");
check(
  "a stored Codex record still wins",
  normalizeSonataSettings({ lastUsedProvider: "codex" }).lastUsedProvider === "codex",
);
check(
  "stored Codex model and effort still win",
  normalizeCodexSettings({ defaultModel: "gpt-5.6-luna", defaultReasoningEffort: "xhigh" })
    .defaultModel === "gpt-5.6-luna" &&
    normalizeCodexSettings({ defaultModel: "gpt-5.6-luna", defaultReasoningEffort: "xhigh" })
      .defaultReasoningEffort === "xhigh",
);

if (failures.length) {
  console.error("launch-defaults smoke FAILED:");
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log("launch-defaults smoke passed");
}
