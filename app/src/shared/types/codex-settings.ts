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

/**
 * The modes Sonata OFFERS — and therefore the only modes it launches into or
 * drives to. Deliberately narrower than `CodexPermissionMode`, which also names
 * `read-only` (codex's cycle-only fourth mode, SL-17): Read Only has no picker
 * row to walk to and no spawn projection in `CODEX_PERMISSION_MODE_FLAGS`, so
 * every launch/spawn/drive signature takes THIS type and the omission is a
 * compile error rather than a convention. The claude twin is
 * `ClaudeDefaultPermissionMode`.
 */
export type CodexOfferedPermissionMode = (typeof CODEX_PERMISSION_MODE_OPTIONS)[number];

export interface CodexSettings {
  /** A standing launch default, so only an OFFERED mode can be stored here. */
  defaultPermissionMode: CodexOfferedPermissionMode;
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
  // Today's hardcoded launch defaults (state.ts createInitialState) — zero
  // behavior drift for an install that never touches the new setting.
  defaultModel: "gpt-5.6-sol",
  defaultReasoningEffort: "high",
  // On: a stale Codex is the failure mode, and the boot prompt Sonata replaces
  // was already going unanswered.
  keepCodexUpToDate: true,
};

/**
 * The full nameable vocabulary, as a value. `satisfies` rejects a STRAY member;
 * the `_AssertExhaustive` below rejects a MISSING one — the same compile-time
 * pair `REASONING_EFFORTS` uses in domain.ts, and for the same stake: a union
 * member absent from this tuple makes `isCodexPermissionMode` silently reject a
 * legitimately-persisted mirror, which is data loss through a normalize
 * fallback.
 */
const CODEX_PERMISSION_MODES = [
  "ask-for-approval",
  "approve-for-me",
  "full-access",
  "read-only",
] as const satisfies readonly CodexPermissionMode[];
type _AssertExhaustive<T extends never> = T;
type _CodexPermissionModesCoverUnion = _AssertExhaustive<
  Exclude<CodexPermissionMode, (typeof CODEX_PERMISSION_MODES)[number]>
>;

/**
 * True for one of the three modes Sonata OFFERS. This is the guard every
 * launch/spawn/persist seam wants: a standing default, a create/open request's
 * override, and the value a settled picker switch confirms are all things Sonata
 * chose, so `read-only` reaching one of them is a caller bug, not a state.
 */
export function isCodexOfferedPermissionMode(
  value: unknown,
): value is CodexOfferedPermissionMode {
  return CODEX_PERMISSION_MODE_OPTIONS.includes(value as CodexOfferedPermissionMode);
}

/**
 * True for any mode Sonata can NAME, `read-only` included. This is the guard a
 * MIRROR wants — a value Sonata observed rather than chose. The two must stay
 * apart: reading a persisted `read-only` back through the offered guard would
 * silently relabel a session that ran read-only as "Ask for approval", claiming
 * more access than it had.
 */
export function isCodexPermissionMode(value: unknown): value is CodexPermissionMode {
  return (CODEX_PERMISSION_MODES as readonly string[]).includes(value as string);
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
function migrateLegacyApprovalDefault(value: unknown): CodexOfferedPermissionMode {
  return value === "never" ? "approve-for-me" : "ask-for-approval";
}

export function normalizeCodexSettings(value: unknown): CodexSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_CODEX_SETTINGS };
  }
  return {
    defaultPermissionMode: normalizeCodexPermissionDefault(value),
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
function normalizeCodexPermissionDefault(
  value: Record<string, unknown>,
): CodexOfferedPermissionMode {
  if (isCodexOfferedPermissionMode(value.defaultPermissionMode)) {
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
 * The direct branch validates against the FULL nameable vocabulary, not the
 * offered one: a task record's mode is a MIRROR of what the CLI was last
 * observed in, so a session that ended in `read-only` must read back as
 * `read-only` and keep saying so on its card. (Reopening it is a separate
 * question with a separate answer — a reopen is a fresh spawn, and the spawn
 * seam's offered guard lands it in `ask-for-approval`, which is an access
 * ESCALATION made honest by the record being rewritten with it. See
 * `normalizePermissionSettings`.)
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
 * projection table `CODEX_PERMISSION_MODE_FLAGS` in terminal-host.ts):
 *   ask-for-approval → (workspace-write, on-request, reviewer=user)
 *   approve-for-me   → (workspace-write, on-request, reviewer=auto_review)
 *   full-access      → (danger-full-access, never,   reviewer=user)
 * ask and approve share the SAME (sandbox, approval) projection — they diverge
 * ONLY on `approvals_reviewer`. That axis persists to config.toml at spawn; even
 * where it appears in a turn_context it reflects the spawn/config value, not the
 * live-switched mode, so it cannot be trusted to tell a native ask↔approve switch
 * apart. Guessing would MISLABEL access, so the shared pair NEVER overwrites; only
 * full-access's unique `(danger-full-access, never)` projection reconciles.
 *
 * READ ONLY reconciles on the SANDBOX ALONE, and that is not a weakening of the
 * never-guess rule — it is the rule applied to an axis that happens to be
 * decisive. Every mode Sonata offers rides one of two sandboxes
 * (`workspace-write` for ask/approve, `danger-full-access` for full access), so
 * NO offered mode can produce a `read-only` sandbox; codex's own cycle labels
 * that preset "Read Only" (`chatwidget/permission_shortcuts.rs`: the two labels
 * Sonata can name both ride the `auto` preset, and "Read Only" is the
 * `read-only` preset). MEASURED at 0.152.1 through one live session driven into
 * the mode via #39873 (SL-17 q35): the Read Only turn wrote
 * `(read-only, on-request)` with `approvals_reviewer: user`, between a control
 * turn at `(workspace-write, on-request)` and a post-switch turn that stayed on
 * `workspace-write`. The approval axis is deliberately NOT part of the test:
 * SL-8/r4's corpus carries `read-only` against BOTH `never` (×186) and
 * `on-request` (×61), which is the ask-frequency knob, not the access level —
 * a session that cannot write is Read Only either way, and pinning the pair
 * would decline the half of the shape that was never measured here.
 *
 * ACCEPTED RESIDUAL STALENESS — three cases, one shape, one adjudication.
 * (a) a NATIVE ask↔approve switch is not reconciled; (b) a native DOWNGRADE out
 * of full-access keeps the stale full-access mirror; (c) since SL-17, a native
 * cycle OUT of Read Only keeps the stale read-only mirror. All three land on the
 * ambiguous `(workspace-write, on-request)` pair, so all three decline rather
 * than guess, and all three stay on S3's picker-receipt fast path — Sonata-driven
 * switches are always correct; only pure-native mid-session toggles carry this.
 *
 * Case (c) was reviewed and **ACCEPTED BY THE ORCHESTRATOR on 2026-09-02**, not
 * merely by the slice that introduced it. Three reasons, in order of weight:
 *   1. DIRECTION. The stale badge claims LESS access than the session has, which
 *      is this codebase's safe direction everywhere it appears — the same reason
 *      the label table replaced an if-chain whose fallthrough erred the other way.
 *   2. SYMMETRY. It is the same trade already accepted for (b): a native move out
 *      of a distinctly-projected mode cannot be seen, because the mode it moves
 *      TO is the one the rollout cannot name. Refusing (c) while keeping (b) would
 *      be inconsistent, and closing it would mean guessing on exactly the axis
 *      that mislabels access.
 *   3. REMEDY. Any menu switch corrects it immediately (the drive works from Read
 *      Only — MEASURED end-to-end, SL-17 q35), so the user is never stuck.
 * The honest fix is not a better heuristic here: it is the registered permission-
 * mirror redesign on `thread_settings_applied` (SL-8 r4/r5), which carries live
 * permission state directly instead of being inferred from a projection.
 */
export function codexPermissionModeFromTurnContext(
  sandboxPolicy: string | null,
  approvalPolicy: string | null,
): CodexPermissionMode | null {
  if (sandboxPolicy === "danger-full-access" && approvalPolicy === "never") {
    return "full-access";
  }
  if (sandboxPolicy === "read-only") {
    return "read-only";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
