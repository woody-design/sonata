import type {
  OptionPrompt,
  OptionPromptAnswers,
  OptionPromptOption,
  OptionPromptQuestion,
} from "../../shared/types/option-prompt";

/**
 * Pure parsing/encoding for native option prompts (Slice 5). No I/O — the
 * controller feeds it the hook payloads it already receives, the renderer binds
 * to its output, and the terminal-host plays back its key sequence.
 *
 * Phase-0 truths (real claude 2.1.178, see slice-5 findings):
 *  - `tool_input` for AskUserQuestion is `{ questions: OptionPromptQuestion[] }`.
 *  - `tool_response.answers` is `{ "<question>": "<label>" | ["<label>"...] }`.
 *  - Answering = the option's 1-based digit per question, in order, then a CR.
 */

const MIN_OPTIONS = 2;
const MAX_QUESTIONS = 4;

/** The verified submit key for the AskUserQuestion form's Submit tab (plain CR). */
export const OPTION_PROMPT_SUBMIT_KEY = "\r";

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

/**
 * Map a single-select selection (the chosen option index per question, in
 * question order) to the verified PTY key sequence: each option's 1-based digit,
 * then a CR to confirm the Submit tab. `questions` bounds-checks each index so a
 * selection can never address a synthetic ("Type something") option.
 *
 * Throws on an out-of-range / wrong-length selection — a bug, not a user error.
 */
export function optionPromptAnswerSequence(
  questions: OptionPromptQuestion[],
  optionIndices: number[],
): string[] {
  if (optionIndices.length !== questions.length) {
    throw new Error(
      `Option-prompt answer expected ${questions.length} selection(s), got ${optionIndices.length}.`,
    );
  }
  const keys: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const index = optionIndices[i];
    const optionCount = questions[i]?.options.length ?? 0;
    if (index === undefined || !Number.isInteger(index) || index < 0 || index >= optionCount) {
      throw new Error(
        `Option-prompt selection ${index} is out of range for question ${i + 1} (${optionCount} options).`,
      );
    }
    keys.push(String(index + 1)); // 1-based digit selects + auto-advances
  }
  keys.push(OPTION_PROMPT_SUBMIT_KEY); // Submit tab (always required, N≥1)
  return keys;
}
