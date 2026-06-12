import fs from "node:fs";

/**
 * Pre-spawn resume cost context, read from the Claude transcript JSONL —
 * the same numbers the native resume interstitial would show (P1 evidence
 * 2026-06-12: panel said "2h 15m old and 105.9k tokens", this parser said
 * 105.8k from the identical clone). Duet can therefore offer the
 * summary-vs-full choice BEFORE spawning, which no scraping host can.
 */
export interface ClaudeResumeStats {
  /** Timestamp (ms) of the last timestamped transcript entry. */
  lastActivityMs: number | null;
  /** Total tokens of the last usage-bearing entry: input + cache read +
   *  cache creation + output — matches the panel's estimate. */
  totalTokens: number | null;
}

export function readClaudeResumeStats(transcriptPath: string): ClaudeResumeStats {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return { lastActivityMs: null, totalTokens: null };
  }

  let lastActivityMs: number | null = null;
  let totalTokens: number | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(timestamp)) {
      lastActivityMs = timestamp;
    }
    const message = isRecord(entry.message) ? entry.message : null;
    const usage = message && isRecord(message.usage) ? message.usage : null;
    if (usage && typeof usage.input_tokens === "number") {
      totalTokens =
        usage.input_tokens +
        numberOrZero(usage.cache_read_input_tokens) +
        numberOrZero(usage.cache_creation_input_tokens) +
        numberOrZero(usage.output_tokens);
    }
  }
  return { lastActivityMs, totalTokens };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
