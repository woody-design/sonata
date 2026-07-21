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

check("fresh app default provider is Codex", DEFAULT_SONATA_SETTINGS.defaultProvider === "codex");
check("fresh Sonata settings normalize to Codex", freshSonata.defaultProvider === "codex");
check("fresh main surface defaults to Light", DEFAULT_READING_SETTINGS.mode === "light");
check("initial default-provider mirror is Codex", initialState.defaultProvider === "codex");
check("initial New Chat draft is Codex", initialState.taskDraft.provider === "codex");
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
  "stored Claude choice still wins",
  normalizeSonataSettings({ defaultProvider: "claude" }).defaultProvider === "claude",
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
