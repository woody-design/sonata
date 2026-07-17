/**
 * Native option prompts (Slice 5) — Claude's `AskUserQuestion` tool surfaced as
 * an in-view card. Phase 0 (real claude 2.1.178 under duet's spawn) established:
 *  - The `PreToolUse` hook fires for `AskUserQuestion` and carries the full
 *    `tool_input` ({ questions: [...] }) — the structured detection signal.
 *  - The `PostToolUse` hook fires after submit with
 *    `tool_response.answers` = { "<question text>": "<label>" | ["<label>"...] }
 *    (verbatim option labels) — the receipt signal.
 *  - A single-select answer = the option's 1-based digit (instant select +
 *    auto-advance); a multi-question call then needs a trailing Enter (Submit).
 *
 * These provider-neutral types are the contract the renderer card binds to.
 */

export interface OptionPromptOption {
  /** 1–5 word option label (verbatim — also the receipt value). */
  label: string;
  /** One-line explanation of the option. May be empty. */
  description: string;
}

export interface OptionPromptQuestion {
  /** Full question text — also the key the answer is reconciled by. */
  question: string;
  /** Short tab/badge label (≤12 chars per the tool's schema). */
  header: string;
  /** True = pick many. Slice 5 ships single-select; multiSelect is deferred. */
  multiSelect: boolean;
  options: OptionPromptOption[];
}

export interface OptionPrompt {
  /** The `tool_use_id` from the PreToolUse hook — identity across detect/answer. */
  toolUseId: string;
  questions: OptionPromptQuestion[];
}

/** Reconciled answers: full question text → selected option label(s), verbatim. */
export type OptionPromptAnswers = Record<string, string[]>;

/**
 * One question's answer as the user composed it in the card (drawer S1).
 * Provider-neutral; the cli-signal layer maps it to the verified key grammar.
 *  - "option":  single-select pick (one option index)
 *  - "options": multi-select picks (one or more option indices, any order)
 *  - "text":    the synthetic free-text row ("Type something." — the TUI
 *               appends it after the real options; harness-guaranteed)
 */
export type OptionPromptSelection =
  | { kind: "option"; index: number }
  | { kind: "options"; indices: number[] }
  | { kind: "text"; text: string };
