import type { CodexPermissionMode } from "./domain";

/**
 * Duet-owned launch policy for Codex sessions (the Duet mirror of
 * `ClaudeSettings` — this is Duet's standing default, not Codex's own config).
 * `defaultPermissionMode` is the permission preset new Codex sessions launch
 * with, so a user who trusts the direction can set it once instead of answering
 * every command.
 *
 * The vocabulary is Codex 0.144's own `/permissions` picker: "Ask for approval"
 * (workspace-write, ask on escalation), "Approve for me" (auto-review), "Full
 * Access" (danger-full-access). Duet threads this ONE value everywhere above
 * the spawn seam; terminal-host is the only place it fans back out to the
 * legacy (sandbox × approval × reviewer) flags.
 */
export const CODEX_PERMISSION_MODE_OPTIONS = [
  "ask-for-approval",
  "approve-for-me",
  "full-access",
] as const satisfies readonly CodexPermissionMode[];

export interface CodexSettings {
  defaultPermissionMode: CodexPermissionMode;
}

export const DEFAULT_CODEX_SETTINGS: CodexSettings = {
  // Codex's own default (workspace-write, ask on escalation).
  defaultPermissionMode: "ask-for-approval",
};

/** True for one of the three offered Codex permission modes. */
export function isCodexPermissionMode(value: unknown): value is CodexPermissionMode {
  return CODEX_PERMISSION_MODE_OPTIONS.includes(value as CodexPermissionMode);
}

/**
 * Migrate a legacy Codex approval-policy default (`-a` value: untrusted /
 * on-request / never / on-failure — the pre-0.144 axis) to a permission mode,
 * BY ASK-FREQUENCY INTENT and NEVER ESCALATING. `never` (Codex approves
 * everything itself) maps to "Approve for me"; everything that asked before
 * (untrusted, on-request) and the retired `on-failure` map to "Ask for
 * approval". Nothing legacy maps to "Full Access": widening the sandbox is a
 * security escalation that requires an explicit human act.
 */
function migrateLegacyApprovalDefault(value: unknown): CodexPermissionMode {
  return value === "never" ? "approve-for-me" : "ask-for-approval";
}

export function normalizeCodexSettings(value: unknown): CodexSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_CODEX_SETTINGS };
  }
  // New key wins; a stored pre-vocabulary-swap file carries `defaultApprovalMode`
  // instead — migrate it (never escalating). An unrecognizable value falls back
  // to Codex's own default.
  if (isCodexPermissionMode(value.defaultPermissionMode)) {
    return { defaultPermissionMode: value.defaultPermissionMode };
  }
  if ("defaultApprovalMode" in value) {
    return { defaultPermissionMode: migrateLegacyApprovalDefault(value.defaultApprovalMode) };
  }
  return { ...DEFAULT_CODEX_SETTINGS };
}

/**
 * Migrate a persisted task/session record's Codex permission to a mode. A
 * record written since the vocabulary swap carries `codexPermissionMode`
 * directly; a legacy record carries the old (sandbox, approval) pair. Mapping
 * (never escalating): a `danger-full-access` sandbox ⇒ "Full Access"; else a
 * `never` approval ⇒ "Approve for me"; else "Ask for approval".
 *
 * Returns null when the record carries no Codex permission. Only a Codex task
 * has one, so:
 *  - a record whose `provider` is present and not "codex" ⇒ null (a Claude
 *    manifest persisted explicit `sandbox: null` / `approval: null` — verified
 *    against real ~/.duet manifests — so the null/undefined guard alone is not
 *    enough; the provider check makes the Claude-null invariant robust);
 *  - a record with neither axis field set (null OR undefined) ⇒ null.
 */
export function migrateCodexPermissionMode(record: {
  provider?: unknown;
  codexPermissionMode?: unknown;
  sandbox?: unknown;
  approval?: unknown;
}): CodexPermissionMode | null {
  if (isCodexPermissionMode(record.codexPermissionMode)) {
    return record.codexPermissionMode;
  }
  if (record.provider !== undefined && record.provider !== "codex") {
    return null;
  }
  // `== null` catches both null (old Claude manifests) and undefined (absent).
  if (record.sandbox == null && record.approval == null) {
    return null;
  }
  if (record.sandbox === "danger-full-access") {
    return "full-access";
  }
  if (record.approval === "never") {
    return "approve-for-me";
  }
  return "ask-for-approval";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
