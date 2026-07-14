/**
 * Reading-window configuration tables and caps. Plain data + the two
 * table-lookup labels that live with their tables. Same layer rules as the
 * rest of reading-core: no DOM, no Electron, no renderer state.
 */
import type { LaunchSpeedMode, ReasoningEffort, RuntimeProvider } from "../shared/types";

export const USAGE_CONTEXT_HIGH_USED_PERCENT = 80;

export const MAX_TRANSCRIPT_CHARS = 120_000;
export const MAX_TRANSCRIPT_RAW_CHARS = 260_000;

export const AUTO_TITLE_PLACEHOLDERS = new Set(["New task", "New Task", "Walking Skeleton Task"]);

export const MODEL_OPTIONS: Record<
  RuntimeProvider,
  Array<{ label: string; value: string | null }>
> = {
  codex: [
    { label: "5.6 Sol", value: "gpt-5.6-sol" },
    { label: "5.6 Terra", value: "gpt-5.6-terra" },
    { label: "5.6 Luna", value: "gpt-5.6-luna" },
    { label: "5.5", value: "gpt-5.5" },
    { label: "5.4", value: "gpt-5.4" },
    { label: "5.4 Mini", value: "gpt-5.4-mini" },
    { label: "5.3 Codex Spark", value: "gpt-5.3-codex-spark" },
    { label: "Native Default", value: null },
  ],
  claude: [
    { label: "Fable 5", value: "fable" },
    { label: "Opus 4.8", value: "opus" },
    { label: "Sonnet 5", value: "sonnet" },
    { label: "Haiku 4.5", value: "haiku" },
    { label: "Native Default", value: null },
  ],
};

export const REASONING_OPTIONS: Record<
  RuntimeProvider,
  Array<{ label: string; value: ReasoningEffort | null }>
> = {
  codex: [
    { label: "Light", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "Extra High", value: "xhigh" },
    { label: "Ultra", value: "ultra" },
    { label: "Native Default", value: null },
  ],
  claude: [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "Extra High", value: "xhigh" },
    { label: "Max", value: "max" },
    { label: "Native Default", value: null },
  ],
};

export const SPEED_OPTIONS: Array<{ label: string; value: LaunchSpeedMode }> = [
  { label: "Standard", value: "default" },
  { label: "Fast", value: "fast" },
];

const CODEX_ULTRA_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra"]);

/**
 * Codex publishes effort support per model. Keep the old Duet menu shape, but
 * do not offer a launch combination the selected model cannot accept.
 *
 * Max remains Claude-only in Duet: the Codex app exposes it only behind a
 * separate user setting, while Ultra is part of the current default picker.
 */
export function reasoningOptionsForModel(
  provider: RuntimeProvider,
  model: string | null,
): Array<{ label: string; value: ReasoningEffort | null }> {
  const options = REASONING_OPTIONS[provider];
  if (provider !== "codex" || CODEX_ULTRA_MODELS.has(model ?? "")) {
    return options;
  }
  return options.filter((option) => option.value !== "ultra");
}

export function modelValueLabel(provider: RuntimeProvider, value: string | null): string | null {
  if (!value) {
    return null;
  }
  return MODEL_OPTIONS[provider].find((option) => option.value === value)?.label ?? value;
}

export function reasoningValueLabel(
  provider: RuntimeProvider,
  value: ReasoningEffort | null,
): string | null {
  if (!value) {
    return null;
  }
  return (
    REASONING_OPTIONS[provider].find((option) => option.value === value)?.label ??
    Object.values(REASONING_OPTIONS)
      .flat()
      .find((option) => option.value === value)?.label ??
    value
  );
}
