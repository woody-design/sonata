import type { RuntimeProvider } from "./domain";

/**
 * App-level Sonata state — NOT provider-scoped. The first thing that belongs to
 * Sonata as a whole rather than to one CLI, so it earns its own store
 * (`sonata-settings.json`) instead of squatting in a provider file (semantic
 * misfit: a value that chooses BETWEEN providers cannot live inside either
 * provider's settings). The seed file for future app-level settings.
 *
 * `lastUsedProvider` is a RECORD, not a preference (CLI readiness D5/L3): the
 * provider the last session actually STARTED on, written by the main process at
 * that moment (`SonataSettingsStore.noteProviderUsed`, from `createTask`) and
 * read back to preselect the next New Chat draft. It replaces the "default
 * provider" setting the user used to pick in Settings — that picker's only real
 * job was remembering an answer the app can observe for itself.
 *
 * `null` means "no session has started on this machine yet". The draft then
 * falls back to a runtime seed that is deliberately NEVER written here (see
 * `reading-core/transitions/session.ts`): a machine with only Codex installed
 * must not inherit a persisted "claude" it never chose.
 */
export interface SonataSettings {
  lastUsedProvider: RuntimeProvider | null;
}

/** Knowing nothing — a fresh install, and what an unreadable file degrades to.
 *  Not "claude": the absent state is what lets the draft seed from the machine
 *  instead of from a guess. */
export const DEFAULT_SONATA_SETTINGS: SonataSettings = {
  lastUsedProvider: null,
};

export function isRuntimeProvider(value: unknown): value is RuntimeProvider {
  return value === "claude" || value === "codex";
}

export function normalizeSonataSettings(value: unknown): SonataSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_SONATA_SETTINGS };
  }
  return {
    lastUsedProvider: storedProvider(value),
  };
}

/**
 * The stored provider, with the L4 migration folded in: an existing install's
 * retired `defaultProvider` becomes the initial `lastUsedProvider`, so the
 * first New Chat after the upgrade preselects exactly what it preselected
 * before. The normalized shape has no `defaultProvider` key, so the next write
 * drops it from disk — read-side migration, one direction, and no version stamp
 * needed: the KEY NAMES already say which generation wrote the file.
 *
 * Precedence is by VALIDITY, not by presence: the first key holding a real
 * provider wins. A hand-corrupted `lastUsedProvider` therefore falls back to a
 * still-valid `defaultProvider` rather than to absent — last known good beats
 * silently moving an install's preselection to the seed.
 */
function storedProvider(value: Record<string, unknown>): RuntimeProvider | null {
  if (isRuntimeProvider(value.lastUsedProvider)) {
    return value.lastUsedProvider;
  }
  if (isRuntimeProvider(value.defaultProvider)) {
    return value.defaultProvider;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
