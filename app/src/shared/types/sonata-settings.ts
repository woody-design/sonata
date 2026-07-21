import type { RuntimeProvider } from "./domain";

/**
 * App-level Sonata preferences — NOT provider-scoped. The first setting that
 * belongs to Sonata as a whole rather than to one CLI, so it earns its own
 * store (`sonata-settings.json`) instead of squatting in a provider file
 * (semantic misfit: `defaultProvider` chooses BETWEEN providers, so it cannot
 * live inside either provider's settings). The seed file for future app-level
 * settings.
 *
 * `defaultProvider` is the agent new sessions start on (copy-at-entry: seeded
 * into the New Chat draft at boot and at each new-chat reset, never
 * retro-applied to an already-open draft). New installs start on Codex; an
 * explicit stored choice still wins through the normalizer.
 */
export interface SonataSettings {
  defaultProvider: RuntimeProvider;
}

export const DEFAULT_SONATA_SETTINGS: SonataSettings = {
  defaultProvider: "codex",
};

export function isRuntimeProvider(value: unknown): value is RuntimeProvider {
  return value === "claude" || value === "codex";
}

export function normalizeSonataSettings(value: unknown): SonataSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_SONATA_SETTINGS };
  }
  return {
    defaultProvider: isRuntimeProvider(value.defaultProvider)
      ? value.defaultProvider
      : DEFAULT_SONATA_SETTINGS.defaultProvider,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
