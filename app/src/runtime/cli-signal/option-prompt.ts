import type {
  OptionPrompt,
  OptionPromptAnswers,
  OptionPromptOption,
  OptionPromptQuestion,
  OptionPromptSelection,
} from "../../shared/types/option-prompt";

/**
 * Pure parsing/encoding for native option prompts (Slice 5; grammar re-verified
 * and extended on claude 2.1.212 — drawer S1, spikes/drawer-option-prompt-probe
 * P1/P2b/P3/P7/P9a-d). No I/O — the controller feeds it the hook payloads it
 * already receives, the renderer binds to its output, and the terminal-host
 * plays back its key sequence.
 *
 * Hook truths:
 *  - `tool_input` for AskUserQuestion is `{ questions: OptionPromptQuestion[] }`.
 *  - `tool_response.answers` is `{ "<question>": "<label>" | ["<label>"...] }`
 *    (multi-select joins labels into ONE comma-separated string).
 *
 * Key grammar (the S1 contract — see findings.md "Verified sequence grammar"):
 *  - single-select answered by option: `digit(i+1)` — selects AND auto-advances;
 *    on a form with no Submit tab this last digit IS the submit.
 *  - multi-select: `digit` per chosen option toggles (any order), then RIGHT
 *    advances (auto-confirming the toggles).
 *  - free-text: `digit(options.length+1)` opens the synthetic "Type something."
 *    editor, the text, then CR saves AND advances (submits when last).
 *  - A Submit tab exists iff `questions.length > 1 || any multiSelect`; one
 *    final CR there submits the set. Appending a CR when NO Submit tab exists
 *    is the Enter-leak class (P1) — never do it.
 *  - Dismiss ("Chat about this", the synthetic last row at options.length+2):
 *    declines ALL questions instantly with a clean turn end (P7/P9d). Esc also
 *    declines but is hook-invisible (no PostToolUse, no Stop — P4); never used.
 */

const MIN_OPTIONS = 2;
const MAX_QUESTIONS = 4;

/** The verified submit key for the AskUserQuestion form's Submit tab (plain CR). */
export const OPTION_PROMPT_SUBMIT_KEY = "\r";
/** RIGHT arrow — advances off a multi-select question, auto-confirming toggles. */
export const OPTION_PROMPT_ADVANCE_KEY = "\x1b[C";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseOption(value: unknown): OptionPromptOption | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!label) {
    return null;
  }
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return { label, description };
}

function parseQuestion(value: unknown): OptionPromptQuestion | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const question = typeof record.question === "string" ? record.question.trim() : "";
  if (!question) {
    return null;
  }
  const rawOptions = Array.isArray(record.options) ? record.options : [];
  const options: OptionPromptOption[] = [];
  for (const option of rawOptions) {
    const parsed = parseOption(option);
    if (parsed) {
      options.push(parsed);
    }
  }
  if (options.length < MIN_OPTIONS) {
    return null;
  }
  return {
    question,
    header: typeof record.header === "string" && record.header.trim() ? record.header.trim() : question,
    multiSelect: record.multiSelect === true,
    options,
  };
}

/**
 * Parse a PreToolUse(AskUserQuestion) `tool_input` into an OptionPrompt, or null
 * when it is malformed (→ caller falls through to the floor, never a broken
 * card). `toolUseId` is the hook's `tool_use_id`.
 */
export function parseOptionPrompt(toolUseId: string | null, toolInput: unknown): OptionPrompt | null {
  if (typeof toolUseId !== "string" || !toolUseId) {
    return null;
  }
  const record = asRecord(toolInput);
  const rawQuestions = record && Array.isArray(record.questions) ? record.questions : null;
  if (!rawQuestions || rawQuestions.length === 0) {
    return null;
  }
  const questions: OptionPromptQuestion[] = [];
  for (const question of rawQuestions.slice(0, MAX_QUESTIONS)) {
    const parsed = parseQuestion(question);
    if (!parsed) {
      return null; // all-or-nothing: a partial card would mis-map digits
    }
    questions.push(parsed);
  }
  return { toolUseId, questions };
}

/**
 * Reconcile a PostToolUse(AskUserQuestion) `tool_response` into the verbatim
 * answers (question text → selected labels). Returns null when no answers object
 * is present (e.g. a cancellation). Normalizes string values to single-item
 * arrays so single- and multi-select share one shape.
 */
export function reconcileOptionPromptAnswers(toolResponse: unknown): OptionPromptAnswers | null {
  const record = asRecord(toolResponse);
  const answers = record ? asRecord(record.answers) : null;
  if (!answers) {
    return null;
  }
  const out: OptionPromptAnswers = {};
  for (const [question, value] of Object.entries(answers)) {
    if (typeof value === "string") {
      out[question] = [value];
    } else if (Array.isArray(value)) {
      out[question] = value.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return out;
}

/** True iff the form renders a final Submit tab (P2b/P9a: multi-question forms
 *  and any form containing a multiSelect question review before submitting;
 *  a lone single-select/free-text question submits on its own last key). */
export function optionPromptHasSubmitTab(questions: OptionPromptQuestion[]): boolean {
  return questions.length > 1 || questions.some((question) => question.multiSelect);
}

function assertOptionIndex(index: number, question: OptionPromptQuestion, qNumber: number): void {
  const optionCount = question.options.length;
  if (!Number.isInteger(index) || index < 0 || index >= optionCount) {
    throw new Error(
      `Option-prompt selection ${index} is out of range for question ${qNumber} (${optionCount} options).`,
    );
  }
}

/**
 * Map the per-question selections to the verified PTY key sequence (grammar in
 * the module header). `questions` bounds-checks every index so a selection can
 * never address a synthetic row by accident; free-text/dismiss rows are reached
 * only through their dedicated encodings.
 *
 * Throws on a wrong-length / out-of-range / kind-mismatched selection — a bug,
 * not a user error.
 */
export function optionPromptAnswerSequence(
  questions: OptionPromptQuestion[],
  selections: OptionPromptSelection[],
): string[] {
  if (selections.length !== questions.length) {
    throw new Error(
      `Option-prompt answer expected ${questions.length} selection(s), got ${selections.length}.`,
    );
  }
  const keys: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const selection = selections[i];
    if (!question || !selection) {
      throw new Error(`Option-prompt selection ${i + 1} is missing.`);
    }
    if (selection.kind === "option") {
      if (question.multiSelect) {
        throw new Error(`Question ${i + 1} is multi-select; got a single-select answer.`);
      }
      assertOptionIndex(selection.index, question, i + 1);
      keys.push(String(selection.index + 1)); // selects + auto-advances
    } else if (selection.kind === "options") {
      if (!question.multiSelect) {
        throw new Error(`Question ${i + 1} is single-select; got a multi-select answer.`);
      }
      if (selection.indices.length === 0) {
        throw new Error(`Question ${i + 1} needs at least one selected option.`);
      }
      const seen = new Set<number>();
      for (const index of selection.indices) {
        assertOptionIndex(index, question, i + 1);
        if (seen.has(index)) {
          throw new Error(`Question ${i + 1} toggles option ${index} twice (would untoggle).`);
        }
        seen.add(index);
        keys.push(String(index + 1)); // toggles
      }
      keys.push(OPTION_PROMPT_ADVANCE_KEY); // advance; auto-confirms toggles
    } else {
      if (question.multiSelect) {
        // PROBED BROKEN (P9f): on a multi-select list the digit path toggles
        // instead of opening the editor — the typed text never lands and the
        // cursor row gets submitted as the answer. Until a dedicated probe
        // establishes a working editor entry on multi lists, this is a bug wall.
        throw new Error(`Question ${i + 1} is multi-select; free-text injection is not supported.`);
      }
      const text = selection.text.trim();
      if (!text) {
        throw new Error(`Question ${i + 1} has an empty free-text answer.`);
      }
      if (/[\r\n]/.test(selection.text)) {
        // CR/LF inside the editor text would save early / leak an Enter.
        throw new Error(`Question ${i + 1} free-text answer must be a single line.`);
      }
      keys.push(String(question.options.length + 1)); // open "Type something."
      keys.push(text); // one chunk — terminal-host writes it atomically
      keys.push(OPTION_PROMPT_SUBMIT_KEY); // save + advance (submits when last)
    }
  }
  if (optionPromptHasSubmitTab(questions)) {
    // Multi-select questions land the cursor on the Submit tab via RIGHT; pure
    // single-select/free-text multi-question forms auto-advance onto it. Either
    // way one CR confirms. NEVER emitted for a lone single-select question —
    // its digit already submitted (P1: the Enter-leak class).
    keys.push(OPTION_PROMPT_SUBMIT_KEY);
  }
  return keys;
}

/**
 * The dismiss sequence (the drawer's ✕): the synthetic "Chat about this" row —
 * `options.length + 2` on the CURRENT (first) question tab. Declines ALL
 * questions instantly; the turn ends cleanly and the next composer message
 * flows as normal steering (P7/P9d). Only valid on a fresh, un-navigated form —
 * callers inject it INSTEAD of an answer sequence, never after one.
 */
export function optionPromptDismissSequence(questions: OptionPromptQuestion[]): string[] {
  const first = questions[0];
  if (!first) {
    throw new Error("Option-prompt dismiss needs at least one question.");
  }
  return [String(first.options.length + 2)];
}
