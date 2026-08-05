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
check("fresh Codex model is 5.6 Sol", DEFAULT_CODEX_SETTINGS.defaultModel === "gpt-5.6-sol");
check("fresh Codex effort is High", DEFAULT_CODEX_SETTINGS.defaultReasoningEffort === "high");
check(
  "normalized Codex defaults stay 5.6 Sol High",
  freshCodex.defaultModel === "gpt-5.6-sol" && freshCodex.defaultReasoningEffort === "high",
);
check(
  "initial draft stays 5.6 Sol High",
  initialState.taskDraft.model.codex === "gpt-5.6-sol" &&
    initialState.taskDraft.reasoningEffort.codex === "high",
);
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
