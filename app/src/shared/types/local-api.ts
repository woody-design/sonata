/**
 * Local API: a unix-socket ndjson surface that mirrors runtime events
 * and accepts a few commands, so local companion processes (e.g. inkAI,
 * the e-ink reading companion) can follow sessions and submit input
 * without Duet ever listening on a network.
 *
 * Message shape is a JSON-RPC 2.0 subset: a frame with `id` is a
 * request expecting one response; a frame without `id` is a
 * notification. The normative protocol spec lives with the first
 * consumer: inkAI's docs/protocol.md.
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
  internal: -32000,
} as const;
