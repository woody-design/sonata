import type { CodexPermissionMode, ReasoningEffort } from "./domain";
import { isReasoningEffort } from "./domain";

/**
 * Sonata-owned launch policy for Codex sessions (the Sonata mirror of
 * `ClaudeSettings` — this is Sonata's standing default, not Codex's own config).
 * `defaultPermissionMode` is the permission preset new Codex sessions launch
 * with, so a user who trusts the direction can set it once instead of answering
 * every command.
 *
 * The vocabulary is Codex 0.144's own `/permissions` picker: "Ask for approval"
 * (workspace-write, ask on escalation), "Approve for me" (auto-review), "Full
 * Access" (danger-full-access). Sonata threads this ONE value everywhere above
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
  /**
   * Pre-trust user-chosen project folders so `codex -p sonata` boots without its
   * directory-trust dialog. Default false: the dialog is codex's prompt-injection
   * defense, and Sonata leaves it in place for folders the user opens unless they
   * opt in here. Sonata-created chat folders are ALWAYS pre-trusted regardless of
   * this flag (the trust question is vacuous for an empty dir Sonata just made) —
   * that policy lives in the controller, not this setting.
   */
  autoTrustProjectFolders: boolean;
  /** The model new Codex sessions start on (copy-at-entry, the Codex twin of
   *  `ClaudeSettings.defaultModel`). A CONCRETE alias, never null. Validated by
   *  string presence only; the settings menu clamps which effort a model can
   *  accept. */
  defaultModel: string;
  /** The reasoning effort new Codex sessions start on. Validated by
   *  `ReasoningEffort` union membership only; per-model gating (Sol/Terra offer
   *  Ultra, Luna does not, etc.) is clamped at the UI and at draft seeding via
   *  `reasoningOptionsForModel`, not here (layer fence). */
  defaultReasoningEffort: ReasoningEffort;
  /**
   * Let Sonata keep the Codex CLI current. Default TRUE, and the only setting
   * here that defaults on — because the status quo it replaces is a failure,
   * not a neutral: Codex has no background self-updater, only a boot prompt,
   * and inside Sonata's pty that prompt is one nobody resolves, so installs go
   * stale indefinitely. (Claude Code has no twin setting: it self-updates.)
   *
   * When on, Sonata runs `codex update` in the background while no Codex
   * session is live, and suppresses Codex's boot prompt for the spawn it owns.
   * When off, Sonata does nothing at all — no background check, no suppression
   * — and Codex's own prompt comes back. The ownership that follows from this
   * flag is DERIVED per spawn, never stored (see main/cli-updater/policy.ts).
   */
  keepCodexUpToDate: boolean;
}

export const DEFAULT_CODEX_SETTINGS: CodexSettings = {
  // Codex's own default (workspace-write, ask on escalation).
  defaultPermissionMode: "ask-for-approval",
  // Preserve codex's directory-trust prompt for user-chosen folders by default.
  autoTrustProjectFolders: false,
  // Today's hardcoded launch defaults (state.ts createInitialState) — zero
  // behavior drift for an install that never touches the new setting.
  defaultModel: "gpt-5.6-sol",
  defaultReasoningEffort: "high",
  // On: a stale Codex is the failure mode, and the boot prompt Sonata replaces
  // was already going unanswered.
  keepCodexUpToDate: true,
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
  return {
    defaultPermissionMode: normalizeCodexPermissionDefault(value),
    // Absent (a pre-toggle file) or non-boolean → the safe default (prompt on).
    autoTrustProjectFolders:
      typeof value.autoTrustProjectFolders === "boolean"
        ? value.autoTrustProjectFolders
        : DEFAULT_CODEX_SETTINGS.autoTrustProjectFolders,
    // A non-empty string is a concrete model alias; anything else falls back.
    defaultModel:
      typeof value.defaultModel === "string" && value.defaultModel
        ? value.defaultModel
        : DEFAULT_CODEX_SETTINGS.defaultModel,
    defaultReasoningEffort: isReasoningEffort(value.defaultReasoningEffort)
      ? value.defaultReasoningEffort
      : DEFAULT_CODEX_SETTINGS.defaultReasoningEffort,
    // Absent (a pre-toggle file) or non-boolean → the default, which here is ON.
    // Note this is the one key whose fallback ENABLES behaviour: an existing
    // install picks the feature up on upgrade, which is the intent (their Codex
    // is exactly the one most likely to be stale).
    keepCodexUpToDate:
      typeof value.keepCodexUpToDate === "boolean"
        ? value.keepCodexUpToDate
        : DEFAULT_CODEX_SETTINGS.keepCodexUpToDate,
  };
}

/**
 * New key wins; a stored pre-vocabulary-swap file carries `defaultApprovalMode`
 * instead — migrate it (never escalating). An unrecognizable value falls back to
 * Codex's own default.
 */
function normalizeCodexPermissionDefault(value: Record<string, unknown>): CodexPermissionMode {
  if (isCodexPermissionMode(value.defaultPermissionMode)) {
    return value.defaultPermissionMode;
  }
  if ("defaultApprovalMode" in value) {
    return migrateLegacyApprovalDefault(value.defaultApprovalMode);
  }
  return DEFAULT_CODEX_SETTINGS.defaultPermissionMode;
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
 *    against real ~/.sonata manifests — so the null/undefined guard alone is not
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

/**
 * Reconcile a CodexPermissionMode from a live rollout `turn_context`'s
 * (`sandbox_policy.type`, `approval_policy`) pair — the only permission axes the
 * rollout exposes per turn (item E — mid-session switch S5). Deliberately NARROW:
 * returns a mode ONLY when the pair UNIQUELY identifies one triad member, else
 * null (caller keeps the current mirror). This is NOT `migrateCodexPermissionMode`
 * — that reverse-maps a legacy MANIFEST's (sandbox, approval) and treats
 * `approval === "never"` as approve-for-me, which is WRONG for a live turn_context.
 *
 * Why it must be narrow — the reviewer-axis blind spot (measured, see the spawn
 * projection table `CODEX_PERMISSION_SPAWN` in terminal-host.ts):
 *   ask-for-approval → (workspace-write, on-request, reviewer=user)
 *   approve-for-me   → (workspace-write, on-request, reviewer=auto_review)
 *   full-access      → (danger-full-access, never,   reviewer=user)
 * ask and approve share the SAME (sandbox, approval) projection — they diverge
 * ONLY on `approvals_reviewer`. That axis persists to config.toml at spawn; even
 * where it appears in a turn_context it reflects the spawn/config value, not the
 * live-switched mode, so it cannot be trusted to tell a native ask↔approve switch
 * apart. Guessing would MISLABEL access, so the shared pair (and any
 * non-representable pair — e.g. a native read-only sandbox) NEVER overwrites; only
 * full-access's unique `(danger-full-access, never)` projection reconciles.
 *
 * Accepted residual staleness (documented in plan S5(ii) + coupling inventory): a
 * NATIVE ask↔approve switch is not reconciled from the rollout, and a native
 * DOWNGRADE out of full-access keeps the stale full-access mirror (the pair it
 * lands on is the ambiguous ask/approve one, so we decline rather than guess).
 * Both stay on S3's picker-receipt fast path — Sonata-driven switches are always
 * correct; only pure-native mid-session toggles carry this staleness.
 */
export function codexPermissionModeFromTurnContext(
  sandboxPolicy: string | null,
  approvalPolicy: string | null,
): CodexPermissionMode | null {
  if (sandboxPolicy === "danger-full-access" && approvalPolicy === "never") {
    return "full-access";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
