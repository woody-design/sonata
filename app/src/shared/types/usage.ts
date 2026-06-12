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
}
