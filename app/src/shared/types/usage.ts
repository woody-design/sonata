import type { RuntimeProvider } from "./domain";

export interface UsageContextSnapshot {
  usedTokens: number;
  windowTokens: number;
  remainingPercent: number;
}

export interface UsageLimitSnapshot {
  windowMinutes: number;
  label: "5h" | "daily" | "weekly" | "monthly" | string;
  remainingPercent: number;
  resetsAt: number;
}

export interface UsageSnapshot {
  provider: RuntimeProvider;
  capturedAt: number;
  context: UsageContextSnapshot | null;
  limits: UsageLimitSnapshot[];
  /** Provider-generated session title (claude statusline `session_name`). */
  sessionName?: string | null;
  /** Session cost (claude statusline `cost.total_cost_usd`); codex has none. */
  costUsd?: number | null;
  /** Live model (claude statusline `model.display_name`) — the mid-session
   *  /model switch surface (contract §2); spawn settings are the fallback. */
  modelDisplayName?: string | null;
  /** Live reasoning effort (claude statusline `effort`), same contract row. */
  reasoningEffort?: string | null;
}
