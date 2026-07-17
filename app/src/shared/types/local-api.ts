/**
 * Local API: a unix-socket ndjson surface that mirrors runtime events
 * and accepts a few commands, so local companion processes (e.g. inkAI,
 * the e-ink reading companion) can follow sessions and submit input
 * without Sonata ever listening on a network.
 *
 * Message shape is a JSON-RPC 2.0 subset: a frame with `id` is a
 * request expecting one response; a frame without `id` is a
 * notification. The normative protocol spec is the frozen contract:
 * Product/sonata-eink/docs/contracts-v2.md, Part A (FROZEN 2026-07-07).
 */

export const LOCAL_API_PROTOCOL_VERSION = 1;

export interface LocalApiSettings {
  enabled: boolean;
}

export const DEFAULT_LOCAL_API_SETTINGS: LocalApiSettings = {
  enabled: false,
};

export function normalizeLocalApiSettings(input: unknown): LocalApiSettings {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_LOCAL_API_SETTINGS };
  }
  const enabled = (input as Record<string, unknown>).enabled;
  return { enabled: enabled === true };
}

export interface LocalApiRequestFrame {
  id: number;
  method: string;
  params?: unknown;
}

export interface LocalApiResponseFrame {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface LocalApiNotificationFrame {
  method: string;
  params?: unknown;
}

export const LOCAL_API_ERRORS = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  taskNotFound: -32001,
  // Additive under protocolVersion 1 (no version bump): submitPrompt on a
  // session that exists on disk but has no live PTY now answers taskNotLive
  // instead of taskNotFound, so a companion can offer "open it first". This
  // is the one approved code change to an existing request — a
  // dormant-submitPrompt caller sees -32002 where it saw -32001; every other
  // request is byte-identical.
  taskNotLive: -32002,
  internal: -32000,
} as const;
