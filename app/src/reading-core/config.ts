/**
 * Reading-window configuration tables and caps. Plain data + the two
 * table-lookup labels that live with their tables. Same layer rules as the
 * rest of reading-core: no DOM, no Electron, no renderer state.
 */
import type { LaunchSpeedMode, ReasoningEffort, RuntimeProvider } from "../shared/types";

export const USAGE_CONTEXT_HIGH_USED_PERCENT = 80;

export const MAX_TRANSCRIPT_CHARS = 120_000;
export const MAX_TRANSCRIPT_RAW_CHARS = 260_000;

// Pre-latch carry for the live-transcript has-visible-text gate (PTY S1). Once a
// run's cleaned transcript has ANY visible text, the gate latches and never
// cleans again (per-run monotonic). BEFORE that first visible text, the gate
// must still answer "is there visible text yet?" without re-cleaning the whole
// (up to 260 KB) buffer on every chunk — a long noise-only prelude (spinner /
// status repaints the cleaner filters out) would otherwise reintroduce the
// per-chunk O(buffer) cost this slice removes. So the pre-latch emptiness probe
// cleans only the freshly-arrived chunk plus this many bytes of preceding
// context (enough to catch a line or escape sequence straddling the chunk
// boundary). The whole new chunk is always inside the window, so the first
// visible bytes are seen on the chunk that delivers them.
export const LIVE_TRANSCRIPT_PRELATCH_WINDOW = 16_384;

export const MODEL_OPTIONS: Record<
  RuntimeProvider,
  Array<{ label: string; value: string | null }>
> = {
  // Codex's list mirrors the CLI's own `/model` picker — the rows THIS account
  // is served, in the picker's order. RE-WALKED at codex 0.156.1 (2026-09-23,
  // spikes/upstream-sync-2026-09/codex/q39 + q39b, a live `/model` open through
  // the production TerminalHost): SEVEN rows — GPT-6-Astra `(default)` /
  // GPT-6-Sol / GPT-6-Luna / GPT-5.6-Sol / GPT-5.6-Terra / GPT-5.6-Luna /
  // GPT-5.5 (the picker now paints display names; the slugs here are the ones
  // each row's receipt `Model changed to <slug> …` reported). Sonata offers six:
  // `gpt-5.5` is PRUNED on measurement, not on age — its catalog entry carries
  // an `upgrade` to gpt-5.6-sol with `retirement_at 2026-10-14`, and a
  // `-m gpt-5.5` spawn at 0.156.1 boots the migration prompt instead of the
  // model (q41 arm M), where an Esc CONFIRMS `Try new model` and the session
  // comes up on `GPT-5.6-Sol low` — neither the model nor the effort asked for.
  // The rows 0.152.1 served (gpt-5.4, gpt-5.4-mini) and gpt-5.3-codex-spark
  // left the catalog at 0.154.0. NOTE a persisted task on a pruned slug still
  // renders: `modelValueLabel` falls back to the bare slug, so the card keeps
  // naming what the session actually ran on (reopening it passes that slug to
  // `-m`, and the CLI answers as it would at a terminal). The catalog is
  // SERVER-mutable — it moved twice in 13 days; re-walk every sync.
  //
  // Labels are cosmetic on this side: the launch passes the SLUG (`-m`), and the
  // session chip reads the rollout's `turn_context` slug back through
  // `modelValueLabel`.
  codex: [
    { label: "6 Astra", value: "gpt-6-astra" },
    { label: "6 Sol", value: "gpt-6-sol" },
    { label: "6 Luna", value: "gpt-6-luna" },
    { label: "5.6 Sol", value: "gpt-5.6-sol" },
    { label: "5.6 Terra", value: "gpt-5.6-terra" },
    { label: "5.6 Luna", value: "gpt-5.6-luna" },
    { label: "Native Default", value: null },
  ],
  // Claude's list is re-walked against the CLI each sync. The LABELS are
  // user-facing rather than cosmetic: `modelValueLabel()` renders a stored alias
  // anywhere a chip shows a model (the New Chat chip, and the session chip
  // before its first statusline tick, which then shows the CLI's own
  // `model.display_name` verbatim) — so a label that is not the CLI's display
  // name makes the chip change its mind mid-session.
  //
  // MEASURED alias → display name at 2.1.280 (2026-09-23, probe q38 —
  // spikes/upstream-sync-2026-09/claude/; each alias spawned with `--model`
  // through the production TerminalHost and read on TWO channels, the boot
  // banner and the statusline payload the CLI wrote):
  //    fable    → "Fable 5.1"               id claude-fable-5-1
  //    opus[1m] → "Opus 5.5 (1M context)"   id claude-opus-5-5[1m]
  //    opus     → "Opus 5.5"                id claude-opus-5-5
  //    sonnet   → "Sonnet 5"                id claude-sonnet-5
  //    haiku    → "Haiku 4.5"               id claude-haiku-4-5-20251001
  //
  // The Opus aliases FLOAT with the server: at 2.1.258 the same two aliases
  // resolved to "Opus 5 (1M context)" / "Opus 5" (`claude-opus-5[1m]` /
  // `claude-opus-5`, q13). A user who picked an Opus row was already running
  // Opus 5.5; only this table still named the old model. Plain `opus` STAYS
  // although the picker offers it as a row only while the session is already
  // on it (q38 arm h): it is Sonata's seeded default (`DEFAULT_CLAUDE_SETTINGS`,
  // `createInitialState`), a genuinely different model id with a 200K window,
  // and `--model opus` resolves.
  //
  // NOT ADDED: the picker's `Default (recommended)` row — that is Sonata's own
  // `Native Default` (null), and choosing it in the CLI CLEARS the user's pinned
  // default (measured at 2.1.258: `settings.json` `model` key removed). Mythos
  // is trusted-access-only and does not appear on this account.
  claude: [
    { label: "Fable 5.1", value: "fable" },
    { label: "Opus 5.5 (1M context)", value: "opus[1m]" },
    { label: "Opus 5.5", value: "opus" },
    { label: "Sonnet 5", value: "sonnet" },
    { label: "Haiku 4.5", value: "haiku" },
    { label: "Native Default", value: null },
  ],
};

export const REASONING_OPTIONS: Record<
  RuntimeProvider,
  Array<{ label: string; value: ReasoningEffort | null }>
> = {
  codex: [
    { label: "Light", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "Extra High", value: "xhigh" },
    { label: "Max", value: "max" },
    { label: "Ultra", value: "ultra" },
    { label: "Native Default", value: null },
  ],
  // Claude's five tiers are UNCHANGED at 2.1.258 and all five are re-measured
  // live (SL-4 probe q16, findings F17): `/effort <tier>` printed a success
  // receipt and the statusline mirror reported the tier back, for every one of
  // low / medium / high / xhigh / max.
  //
  // The CLI enumerates TWO MORE that Sonata deliberately does not offer. Both
  // are excluded on measurement, not on taste — the CLI's own rejection line is
  // `Invalid argument: <x>. Valid options are: low, medium, high, xhigh, max,
  // ultracode, auto`:
  //
  //  - `ultracode` — accepted, receipt `Set effort level to ultracode (this
  //    session only): xhigh + dynamic workflow orchestration`, but the banner
  //    and the statusline mirror BOTH report it back as `xhigh`, so the session
  //    chip could never show the tier the user picked. Offering a tier the
  //    mirror cannot express is a design fork, not a table entry.
  //  - `auto` — accepted with a DIFFERENT receipt shape (`Effort level set to
  //    auto`), and it removes the effort segment from the banner while the
  //    mirror reports the level the CLI resolved for that turn. A per-turn value
  //    has no stable "current" for the session chip to show.
  //
  // Both are registered as post-sync questions rather than modelled here.
  claude: [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "Extra High", value: "xhigh" },
    { label: "Max", value: "max" },
    { label: "Native Default", value: null },
  ],
};

export const SPEED_OPTIONS: Array<{ label: string; value: LaunchSpeedMode }> = [
  { label: "Standard", value: "default" },
  { label: "Fast", value: "fast" },
];

// Codex gates its top reasoning tiers per model, surfaced in the CLI's own
// `/model` picker: a row offers Max and/or Ultra only through its level-2
// `More reasoning…` submenu. The CLI does not validate `-c model_reasoning_effort`
// at launch (it echoes any string), so this menu — not the launch — is where an
// unsupported combination must be kept off the table.
//
// RE-DERIVED at codex 0.156.1 (2026-09-23, q39b — every row's level 2 opened,
// and the `More reasoning…` submenu wherever it was offered):
//    gpt-6-astra    Max + Ultra   (own default tier Medium — was Low at 0.154.0)
//    gpt-6-sol      Max + Ultra   (Medium)
//    gpt-6-luna     Max only      (Medium; `Max consumes…`, no Ultra row)
//    gpt-5.6-sol    Max + Ultra   (Low)
//    gpt-5.6-terra  Max + Ultra   (Medium)
//    gpt-5.6-luna   Max only      (Medium)
// Every served row offers Max, so `CODEX_MAX_MODELS` is the whole list; the
// Sets stay explicit anyway, because a slug OUTSIDE them (Native Default, a
// persisted pruned model such as gpt-5.5, which offered neither) must see
// neither gated tier. Sonata's seeded default effort (High) is injected
// explicitly rather than left to the model's own default tier, which is
// per-row and has already moved once for astra.
const CODEX_MAX_MODELS = new Set([
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
const CODEX_ULTRA_MODELS = new Set(["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra"]);

// Claude fast mode (native since 2.1.205) is Opus-only per Anthropic's release
// notes; we therefore gate Fast to Opus and never inject fastMode onto another
// model. Codex has no such per-model gate — `-c service_tier=priority` applies
// to every model, so this set is Claude-only. Native Default (null model) offers
// no Fast either: we can't know the account's default model, so we can't promise
// it is Opus.
//
// `opus[1m]` was added on MEASUREMENT, not on the reasoning that "1M Opus is
// still Opus" (upstream sync 2026-09-01, SL-4 probe q15 — findings F18). Fast
// mode has no flag and prints no receipt, so the four arms were compared on the
// boot frame: `opus` + fastMode and `opus[1m]` + fastMode produce the SAME
// acknowledgement line (`Fast mode requires usage credits · /usage-credits to
// turn them on` — this account has none, which is an entitlement, not a model
// gate), `opus[1m]` WITHOUT fastMode produces no such line, and `haiku` +
// fastMode produces none either — the CLI silently ignores the setting there.
// So the 1M variant accepts the injection exactly as plain Opus does, and the
// negative control shows what "ignored" looks like, which is what makes the
// positive readable. This also retires the old comment's admission that the
// non-Opus behaviour was unverified: it is measured now, and it is a silent
// no-op, so the gate protects a promise (the UI offering Fast) rather than
// preventing an error. Re-measured at 2.1.280 (q38), after both Opus aliases
// moved to Opus 5.5: `opus` + fastMode and `opus[1m]` + fastMode still print the
// same line, so the gate is unchanged.
const CLAUDE_FAST_MODELS = new Set(["opus", "opus[1m]"]);

/**
 * The launch Speed options a given model can accept. Codex offers Fast for
 * every model; Claude offers it only for Opus. When Fast isn't offered the menu
 * collapses to Standard alone — the launch UI renders the section only when a
 * real choice exists, and the model-switch fallback (renderer/main.ts) unwinds
 * a stale `fast` to `default` the same way the effort menu unwinds a gated tier.
 */
export function speedOptionsForModel(
  provider: RuntimeProvider,
  model: string | null,
): Array<{ label: string; value: LaunchSpeedMode }> {
  if (provider !== "claude") {
    return SPEED_OPTIONS;
  }
  return CLAUDE_FAST_MODELS.has(model ?? "")
    ? SPEED_OPTIONS
    : SPEED_OPTIONS.filter((option) => option.value !== "fast");
}

/**
 * Keep the old Sonata menu shape, but do not offer a launch combination the
 * selected model cannot accept. Native Default (null model) shows neither
 * gated tier — the conservative menu until a model is chosen.
 */
export function reasoningOptionsForModel(
  provider: RuntimeProvider,
  model: string | null,
): Array<{ label: string; value: ReasoningEffort | null }> {
  const options = REASONING_OPTIONS[provider];
  if (provider !== "codex") {
    return options;
  }
  const key = model ?? "";
  const maxAllowed = CODEX_MAX_MODELS.has(key);
  const ultraAllowed = CODEX_ULTRA_MODELS.has(key);
  return options.filter((option) => {
    if (option.value === "max") {
      return maxAllowed;
    }
    if (option.value === "ultra") {
      return ultraAllowed;
    }
    return true;
  });
}

/**
 * Clamp a reasoning effort to what the given model can actually accept. The one
 * enforcement rule shared by the New Chat model-switch unwind (renderer/main.ts
 * setDraftModel), the Settings default-model menu, and default-seeding at boot /
 * new-chat reset: a now-gated tier (codex Max/Ultra on a model that lost them)
 * falls back to Extra High — the nearest universally supported level, preserving
 * the user's intent. A supported effort passes through unchanged.
 */
export function reasoningEffortForModel(
  provider: RuntimeProvider,
  model: string | null,
  effort: ReasoningEffort,
): ReasoningEffort {
  const supported = reasoningOptionsForModel(provider, model).some(
    (option) => option.value === effort,
  );
  return supported ? effort : "xhigh";
}

export function modelValueLabel(provider: RuntimeProvider, value: string | null): string | null {
  if (!value) {
    return null;
  }
  return MODEL_OPTIONS[provider].find((option) => option.value === value)?.label ?? value;
}

export function reasoningValueLabel(
  provider: RuntimeProvider,
  value: ReasoningEffort | null,
): string | null {
  if (!value) {
    return null;
  }
  return (
    REASONING_OPTIONS[provider].find((option) => option.value === value)?.label ??
    Object.values(REASONING_OPTIONS)
      .flat()
      .find((option) => option.value === value)?.label ??
    value
  );
}
