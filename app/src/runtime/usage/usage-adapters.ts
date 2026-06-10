import type { UsageLimitSnapshot, UsageSnapshot } from "../../shared/types/usage";

export const CODEX_CONTEXT_BASELINE_TOKENS = 12_000;

interface ClaudeStatuslineResult {
  providerSessionId: string;
  snapshot: UsageSnapshot;
}

export function usageWindowLabel(windowMinutes: number): UsageLimitSnapshot["label"] {
  if (approximately(windowMinutes, 300, 15)) {
    return "5h";
  }
  if (approximately(windowMinutes, 1_440, 60)) {
    return "daily";
  }
  if (approximately(windowMinutes, 10_080, 240)) {
    return "weekly";
  }
  if (approximately(windowMinutes, 43_200, 1_440)) {
    return "monthly";
  }
  if (windowMinutes > 0 && windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`;
  }
  return `${windowMinutes}m`;
}

export function parseCodexUsageLine(line: string): UsageSnapshot | null {
  const record = parseObject(line);
  if (!record || record.type !== "event_msg") {
    return null;
  }
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  return parseCodexTokenCountPayload(record.payload, {
    capturedAt: Number.isNaN(timestamp) ? Date.now() : timestamp,
  });
}

export function parseCodexTokenCountPayload(
  payload: unknown,
  options: { capturedAt?: number } = {},
): UsageSnapshot | null {
  const record = asRecord(payload);
  if (!record || record.type !== "token_count") {
    return null;
  }

  const context = codexContextSnapshot(record.info);
  const limits = codexLimitSnapshots(record.rate_limits);
  if (!context && limits.length === 0) {
    return null;
  }

  return {
    provider: "codex",
    capturedAt: options.capturedAt ?? Date.now(),
    context,
    limits,
  };
}

export function parseClaudeStatuslinePayload(
  payload: unknown,
  options: { capturedAt?: number } = {},
): ClaudeStatuslineResult | null {
  const record = asRecord(payload);
  const providerSessionId = typeof record?.session_id === "string" ? record.session_id : null;
  if (!record || !providerSessionId) {
    return null;
  }

  const context = claudeContextSnapshot(record.context_window);
  const limits = claudeLimitSnapshots(record.rate_limits);
  if (!context && limits.length === 0) {
    return null;
  }

  return {
    providerSessionId,
    snapshot: {
      provider: "claude",
      capturedAt: options.capturedAt ?? Date.now(),
      context,
      limits,
    },
  };
}

export function parseClaudeStatuslineJson(
  raw: string,
  options: { capturedAt?: number } = {},
): ClaudeStatuslineResult | null {
  const record = parseObject(raw);
  return record ? parseClaudeStatuslinePayload(record, options) : null;
}

function codexContextSnapshot(info: unknown): UsageSnapshot["context"] {
  const record = asRecord(info);
  const lastUsage = asRecord(record?.last_token_usage);
  const totalTokens = finiteNumber(lastUsage?.total_tokens);
  const windowTokens = finiteNumber(record?.model_context_window);
  if (totalTokens === null || windowTokens === null || windowTokens <= CODEX_CONTEXT_BASELINE_TOKENS) {
    return null;
  }

  const effectiveWindow = windowTokens - CODEX_CONTEXT_BASELINE_TOKENS;
  const used = Math.max(totalTokens - CODEX_CONTEXT_BASELINE_TOKENS, 0);
  const remainingPercent = clampPercent(((effectiveWindow - used) / effectiveWindow) * 100);
  return {
    usedTokens: Math.round(totalTokens),
    windowTokens: Math.round(windowTokens),
    remainingPercent,
  };
}

function codexLimitSnapshots(rateLimits: unknown): UsageLimitSnapshot[] {
  const record = asRecord(rateLimits);
  if (!record) {
    return [];
  }
  return [record.primary, record.secondary]
    .map(codexLimitSnapshot)
    .filter((limit): limit is UsageLimitSnapshot => Boolean(limit));
}

function codexLimitSnapshot(value: unknown): UsageLimitSnapshot | null {
  const record = asRecord(value);
  const usedPercent = finiteNumber(record?.used_percent);
  const windowMinutes = finiteNumber(record?.window_minutes);
  const resetsAt = finiteNumber(record?.resets_at);
  if (usedPercent === null || windowMinutes === null || resetsAt === null) {
    return null;
  }
  return {
    windowMinutes: Math.round(windowMinutes),
    label: usageWindowLabel(windowMinutes),
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt: Math.round(resetsAt),
  };
}

function claudeContextSnapshot(contextWindow: unknown): UsageSnapshot["context"] {
  const record = asRecord(contextWindow);
  if (!record) {
    return null;
  }
  const usedPercent = finiteNumber(record?.used_percentage);
  const windowTokens = finiteNumber(record?.context_window_size);
  if (usedPercent === null || windowTokens === null) {
    return null;
  }

  const usedTokens = claudeCurrentUsageTokens(record);
  if (usedTokens === null) {
    return null;
  }

  return {
    usedTokens: Math.round(usedTokens),
    windowTokens: Math.round(windowTokens),
    remainingPercent: clampPercent(100 - usedPercent),
  };
}

function claudeCurrentUsageTokens(contextWindow: Record<string, unknown>): number | null {
  const currentUsage = asRecord(contextWindow.current_usage);
  if (currentUsage) {
    const parts = [
      currentUsage.input_tokens,
      currentUsage.output_tokens,
      currentUsage.cache_creation_input_tokens,
      currentUsage.cache_read_input_tokens,
    ].map(finiteNumber);
    if (parts.every((part): part is number => part !== null)) {
      return parts.reduce((sum, part) => sum + part, 0);
    }
  }

  const totalInput = finiteNumber(contextWindow.total_input_tokens);
  const totalOutput = finiteNumber(contextWindow.total_output_tokens);
  if (totalInput === null || totalOutput === null) {
    return null;
  }
  return totalInput + totalOutput;
}

function claudeLimitSnapshots(rateLimits: unknown): UsageLimitSnapshot[] {
  const record = asRecord(rateLimits);
  if (!record) {
    return [];
  }
  return [
    claudeLimitSnapshot(record.five_hour, 300, "5h"),
    claudeLimitSnapshot(record.seven_day, 10_080, "weekly"),
  ].filter((limit): limit is UsageLimitSnapshot => Boolean(limit));
}

function claudeLimitSnapshot(
  value: unknown,
  windowMinutes: number,
  label: UsageLimitSnapshot["label"],
): UsageLimitSnapshot | null {
  const record = asRecord(value);
  const usedPercent = finiteNumber(record?.used_percentage);
  const resetsAt = finiteNumber(record?.resets_at);
  if (usedPercent === null || resetsAt === null) {
    return null;
  }
  return {
    windowMinutes,
    label,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt: Math.round(resetsAt),
  };
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function approximately(value: number, target: number, tolerance: number): boolean {
  return Math.abs(value - target) <= tolerance;
}
