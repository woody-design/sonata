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
 * The modes Sonata OFFERS — and therefore the only modes it launches into.
 * Deliberately narrower than `CodexPermissionMode`, which also names
 * `read-only` (codex's cycle-only fourth mode, SL-17): Read Only has no spawn
 * projection in `CODEX_PERMISSION_MODE_FLAGS`, so every launch/spawn signature
 * takes THIS type and the omission is a compile error rather than a
 * convention. The claude twin is
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
  // The fresh-install launch default, mirrored by state.ts createInitialState.
  // Moved gpt-5.6-sol → gpt-6-astra on 2026-09-10 (codex 0.154.0 promoted
  // Astra to the picker's `(default)` row — MEASURED, q36). Effort stays High:
  // Astra's own default is Low, and Sonata's standing choice is to inject the
  // effort it means rather than inherit the model's.
  defaultModel: "gpt-6-astra",
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
 * launch/spawn seam wants: a standing default and a create/open request's
 * override are things Sonata chose, so `read-only` reaching one of them is a
 * caller bug, not a state.
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
 * Map a live rollout `turn_context`'s permission axes — (`sandbox_policy.type`,
 * `approval_policy`, `approvals_reviewer`) — to the CodexPermissionMode the turn
 * ran under (item E). This is the SSOT for a codex session's permission mode
 * after spawn: the badge AND the persisted task value (the one a reopen spawns
 * from) follow the latest live observation; the stored launch setting only
 * stands until the first turn_context arrives. This is NOT
 * `migrateCodexPermissionMode` — that reverse-maps a legacy MANIFEST's (sandbox,
 * approval) and treats `approval === "never"` as approve-for-me, which is WRONG
 * for a live turn_context.
 *
 * The four measured projections (spawn table `CODEX_PERMISSION_MODE_FLAGS` in
 * terminal-host.ts for the offered three):
 *   full-access      → (danger-full-access, never)
 *   read-only        → (read-only, *)
 *   approve-for-me   → (workspace-write, on-request, reviewer=auto_review)
 *   ask-for-approval → (workspace-write, on-request, reviewer=user | absent)
 *
 * THE REVIEWER AXIS IS LIVE. The earlier reading — "it persists to config.toml
 * at spawn and reflects the spawn value, not the live-switched mode" — is
 * FALSIFIED by measurement: after a `/permissions` switch to Approve for me the
 * NEXT turn's turn_context carries `approvals_reviewer: "auto_review"`
 * (0.152.1 SL-17 q35 turn 3, after a drive-made switch; 0.156.1 q42, after a
 * switch made in the Terminal), and `"user"` under Ask for approval (q35 turn 1).
 * Nothing is written at switch time — the new mode surfaces with the next turn,
 * which is the accepted latency (the chip says "as of the last turn").
 * An ABSENT reviewer reads as ask-for-approval: the prompting mode, and the
 * shape a rollout from before the field existed carries.
 *
 * READ ONLY reconciles on the SANDBOX ALONE: no offered mode produces a
 * `read-only` sandbox, and codex's own cycle labels that preset "Read Only"
 * (MEASURED 0.152.1, SL-17 q35: `(read-only, on-request)` with reviewer `user`).
 * The approval axis is the ask-frequency knob, not the access level — SL-8/r4's
 * corpus carries `read-only` against both `never` (×186) and `on-request` (×61).
 *
 * Anything else (an unmeasured sandbox/approval pairing, an unknown reviewer
 * value, missing axes) returns null and the caller keeps the current value —
 * never a guess.
 *
 * SUPERSEDED ADJUDICATION. On 2026-09-02 the orchestrator ACCEPTED residual
 * staleness for three cases the old two-axis map could not see — (a) ask↔approve,
 * (b) a downgrade out of full-access, (c) a cycle out of Read Only — resting on
 * direction, symmetry, and a remedy ("any menu switch corrects it") that the
 * Subtraction program removed with the mid-session drives (2026-09-23). The
 * acceptance is superseded, not re-argued: with the reviewer axis all three
 * cases now reconcile from the file, so none of them is a residual any more
 * (orchestrator ruling, Subtraction X1 fix round F1, 2026-09-23).
 */
export function codexPermissionModeFromTurnContext(
  sandboxPolicy: string | null,
  approvalPolicy: string | null,
  approvalsReviewer: string | null,
): CodexPermissionMode | null {
  if (sandboxPolicy === "danger-full-access" && approvalPolicy === "never") {
    return "full-access";
  }
  if (sandboxPolicy === "read-only") {
    return "read-only";
  }
  if (sandboxPolicy === "workspace-write" && approvalPolicy === "on-request") {
    if (approvalsReviewer === "auto_review") {
      return "approve-for-me";
    }
    if (approvalsReviewer === "user" || approvalsReviewer === null) {
      return "ask-for-approval";
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
