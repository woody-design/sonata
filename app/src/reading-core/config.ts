/**
 * Reading-window configuration tables and caps. Plain data + the two
 * table-lookup labels that live with their tables. Same layer rules as the
 * rest of reading-core: no DOM, no Electron, no renderer state.
 */
import type { LaunchSpeedMode, ReasoningEffort, RuntimeProvider } from "../shared/types";

export const USAGE_CONTEXT_HIGH_USED_PERCENT = 80;

export const MAX_TRANSCRIPT_CHARS = 120_000;
export const MAX_TRANSCRIPT_RAW_CHARS = 260_000;

export const AUTO_TITLE_PLACEHOLDERS = new Set(["New Task", "Walking Skeleton Task"]);

export const MODEL_OPTIONS: Record<RuntimeProvider, Array<{ label: string; value: string | null }>> = {
  codex: [
    { label: "GPT-5.5", value: "gpt-5.5" },
    { label: "GPT-5.4", value: "gpt-5.4" },
    { label: "GPT-5.4-Mini", value: "gpt-5.4-mini" },
    { label: "GPT-5.3-Codex-Spark", value: "gpt-5.3-codex-spark" },
    { label: "Native Default", value: null },
  ],
  claude: [
    { label: "Fable 5", value: "fable" },
    { label: "Opus 4.8", value: "opus" },
    { label: "Sonnet 4.6", value: "sonnet" },
    { label: "Haiku 4.5", value: "haiku" },
    { label: "Native Default", value: null },
  ],
};

export const REASONING_OPTIONS: Record<RuntimeProvider, Array<{ label: string; value: ReasoningEffort | null }>> = {
  codex: [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "Extra High", value: "xhigh" },
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
  { label: "Default", value: "default" },
  { label: "Fast", value: "fast" },
];

export function modelValueLabel(provider: RuntimeProvider, value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (provider === "codex") {
    if (value === "gpt-5.5") {
      return "5.5";
    }
    if (value === "gpt-5.4") {
      return "5.4";
    }
    if (value === "gpt-5.4-mini") {
      return "5.4 Mini";
    }
    if (value === "gpt-5.3-codex-spark") {
      return "5.3 Spark";
    }
  }
  return MODEL_OPTIONS[provider].find((option) => option.value === value)?.label ?? value;
}

export function reasoningValueLabel(value: ReasoningEffort | null): string | null {
  if (!value) {
    return null;
  }
  return (
    [...REASONING_OPTIONS.codex, ...REASONING_OPTIONS.claude].find(
      (option) => option.value === value,
    )?.label ?? value
  );
}
