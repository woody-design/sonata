import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Pure logic — require it directly (no node-pty via the runtime barrel).
const require = createRequire(import.meta.url);
const { parseOptionPrompt, reconcileOptionPromptAnswers, optionPromptAnswerSequence } = require(
  "../../dist/runtime/cli-signal/option-prompt",
);

// Real Phase-0 shape (claude 2.1.178 PreToolUse tool_input), 3 single-select Qs.
const TOOL_INPUT = {
  questions: [
    {
      question: "Which fruit?",
      header: "Fruit",
      multiSelect: false,
      options: [
        { label: "Banana", description: "a tropical fruit" },
        { label: "Cherry", description: "a stone fruit" },
        { label: "Apple", description: "a pome fruit" },
      ],
    },
    {
      question: "Which number?",
      header: "Number",
      multiSelect: false,
      options: [
        { label: "One", description: "the first" },
        { label: "Two", description: "the second" },
      ],
    },
    {
      question: "Which animal?",
      header: "Animal",
      multiSelect: false,
      options: [
        { label: "Ant", description: "an insect" },
        { label: "Bee", description: "a flying insect" },
        { label: "Cat", description: "a mammal" },
      ],
    },
  ],
};

// 1) parseOptionPrompt — well-formed input → structured prompt.
{
  const prompt = parseOptionPrompt("toolu_abc", TOOL_INPUT);
  assert.ok(prompt, "valid input parses");
  assert.equal(prompt.toolUseId, "toolu_abc");
  assert.equal(prompt.questions.length, 3, "all questions kept");
  assert.equal(prompt.questions[0].header, "Fruit");
  assert.equal(prompt.questions[0].options.length, 3);
  assert.equal(prompt.questions[0].options[0].label, "Banana");
  assert.equal(prompt.questions[1].options[1].label, "Two");
}

// 2) parseOptionPrompt — guards (malformed → null, never a broken card).
{
  assert.equal(parseOptionPrompt(null, TOOL_INPUT), null, "no toolUseId → null");
  assert.equal(parseOptionPrompt("id", {}), null, "no questions → null");
  assert.equal(parseOptionPrompt("id", { questions: [] }), null, "empty questions → null");
  assert.equal(
    parseOptionPrompt("id", { questions: [{ question: "Q?", options: [{ label: "only one" }] }] }),
    null,
    "fewer than 2 options → null (all-or-nothing)",
  );
  // header defaults to the question text when missing.
  const p = parseOptionPrompt("id", {
    questions: [{ question: "Pick?", options: [{ label: "A" }, { label: "B" }] }],
  });
  assert.ok(p, "missing header/description still parses");
  assert.equal(p.questions[0].header, "Pick?", "header falls back to question text");
  assert.equal(p.questions[0].options[0].description, "", "missing description → empty string");
  assert.equal(p.questions[0].multiSelect, false, "missing multiSelect → false");
}

// 3) reconcileOptionPromptAnswers — PostToolUse tool_response.answers → string[].
{
  const toolResponse = {
    questions: TOOL_INPUT.questions,
    answers: { "Which fruit?": "Banana", "Which number?": "Two", "Which animal?": "Cat" },
  };
  const answers = reconcileOptionPromptAnswers(toolResponse);
  assert.deepEqual(answers["Which fruit?"], ["Banana"], "string answer normalized to array");
  assert.deepEqual(answers["Which animal?"], ["Cat"]);
  // multiSelect-shaped array answers pass through.
  const multi = reconcileOptionPromptAnswers({ answers: { "Pick many?": ["A", "B"] } });
  assert.deepEqual(multi["Pick many?"], ["A", "B"]);
  // no answers object (e.g. cancellation) → null.
  assert.equal(reconcileOptionPromptAnswers({}), null, "no answers → null");
  assert.equal(reconcileOptionPromptAnswers(null), null, "non-object → null");
}

// 4) optionPromptAnswerSequence — selection → verified key sequence (digits + CR).
{
  const prompt = parseOptionPrompt("id", TOOL_INPUT);
  // Q1=Banana(idx0→"1"), Q2=Two(idx1→"2"), Q3=Cat(idx2→"3"), then CR submit.
  assert.deepEqual(
    optionPromptAnswerSequence(prompt.questions, [0, 1, 2]),
    ["1", "2", "3", "\r"],
    "1-based digits per question + trailing CR (the Submit tab)",
  );
  // single-question call still needs the trailing CR.
  const single = parseOptionPrompt("id", { questions: [TOOL_INPUT.questions[1]] });
  assert.deepEqual(optionPromptAnswerSequence(single.questions, [1]), ["2", "\r"]);
  // bounds + arity are bugs, not user errors → throw (never address a synthetic option).
  assert.throws(() => optionPromptAnswerSequence(prompt.questions, [0, 1]), /expected 3/);
  assert.throws(() => optionPromptAnswerSequence(prompt.questions, [0, 1, 9]), /out of range/);
  assert.throws(() => optionPromptAnswerSequence(prompt.questions, [0, 1, -1]), /out of range/);
}

console.log("option-prompt-parse smoke: OK");
