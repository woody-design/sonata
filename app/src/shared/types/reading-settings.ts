export const READING_THEME_IDS = ["default", "paper", "calm", "focus"] as const;
export type ReadingThemeId = (typeof READING_THEME_IDS)[number];

export const READING_MODE_IDS = ["light", "dark", "auto"] as const;
export type ReadingModeSetting = (typeof READING_MODE_IDS)[number];

export const RESOLVED_READING_MODE_IDS = ["light", "dark"] as const;
export type ResolvedReadingMode = (typeof RESOLVED_READING_MODE_IDS)[number];

export const READING_TEXT_STEPS = [14, 15, 16, 18, 20] as const;
export type ReadingTextStep = (typeof READING_TEXT_STEPS)[number];

export interface ReadingSettings {
  theme: ReadingThemeId;
  mode: ReadingModeSetting;
  textStep: ReadingTextStep;
}

export const DEFAULT_READING_SETTINGS: ReadingSettings = {
  theme: "default",
  mode: "auto",
  textStep: 16,
};

export function normalizeReadingSettings(value: unknown): ReadingSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_READING_SETTINGS };
  }

  return {
    theme: isReadingThemeId(value.theme) ? value.theme : DEFAULT_READING_SETTINGS.theme,
    mode: isReadingModeSetting(value.mode) ? value.mode : DEFAULT_READING_SETTINGS.mode,
    textStep: isReadingTextStep(value.textStep) ? value.textStep : DEFAULT_READING_SETTINGS.textStep,
  };
}

export function isReadingThemeId(value: unknown): value is ReadingThemeId {
  return READING_THEME_IDS.includes(value as ReadingThemeId);
}

export function isReadingModeSetting(value: unknown): value is ReadingModeSetting {
  return READING_MODE_IDS.includes(value as ReadingModeSetting);
}

export function isResolvedReadingMode(value: unknown): value is ResolvedReadingMode {
  return RESOLVED_READING_MODE_IDS.includes(value as ResolvedReadingMode);
}

export function isReadingTextStep(value: unknown): value is ReadingTextStep {
  return READING_TEXT_STEPS.includes(value as ReadingTextStep);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
