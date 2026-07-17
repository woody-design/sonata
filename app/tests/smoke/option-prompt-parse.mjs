import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Pure logic — require it directly (no node-pty via the runtime barrel).
const require = createRequire(import.meta.url);
const {
  parseOptionPrompt,
  reconcileOptionPromptAnswers,
  optionPromptAnswerSequence,
  optionPromptDismissSequence,
  optionPromptHasSubmitTab,
} = require("../../dist/runtime/cli-signal/option-prompt");

const RIGHT = "\x1b[C";

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

// 4) optionPromptAnswerSequence — the verified 2.1.212 grammar (probe P1/P2b/
//    P3/P9a-c: spikes/drawer-option-prompt-probe/findings.md). Each case below
//    mirrors a live-probed scenario.
const opt = (index) => ({ kind: "option", index });
const opts = (...indices) => ({ kind: "options", indices });
const text = (t) => ({ kind: "text", text: t });
{
  const prompt = parseOptionPrompt("id", TOOL_INPUT);
  // P9a shape (multi-question, all single-select): digits auto-advance, one
  // final CR on the Submit tab.
  assert.deepEqual(
    optionPromptAnswerSequence(prompt.questions, [opt(0), opt(1), opt(2)]),
    ["1", "2", "3", "\r"],
    "multi-question single-select: digits + one Submit CR",
  );
  // P1: a LONE single-select question — the digit itself submits; a trailing
  // CR is the Enter-leak class and must NOT be emitted.
  const single = parseOptionPrompt("id", { questions: [TOOL_INPUT.questions[1]] });
  assert.equal(optionPromptHasSubmitTab(single.questions), false, "lone single-select: no Submit tab");
  assert.deepEqual(
    optionPromptAnswerSequence(single.questions, [opt(1)]),
    ["2"],
    "lone single-select: digit only, NO trailing CR (P1)",
  );
  // bounds + arity are bugs, not user errors → throw (never address a synthetic option).
  assert.throws(() => optionPromptAnswerSequence(prompt.questions, [opt(0), opt(1)]), /expected 3/);
  assert.throws(
    () => optionPromptAnswerSequence(prompt.questions, [opt(0), opt(1), opt(9)]),
    /out of range/,
  );
  assert.throws(
    () => optionPromptAnswerSequence(prompt.questions, [opt(0), opt(1), opt(-1)]),
    /out of range/,
  );
}

// 5) Multi-select grammar (P2/P2b): digits TOGGLE, RIGHT advances (auto-confirm),
//    and the form always has a Submit tab → final CR.
{
  const multiQ = {
    question: "Which toppings?",
    header: "Toppings",
    multiSelect: true,
    options: [
      { label: "Cheese", description: "" },
      { label: "Mushroom", description: "" },
      { label: "Basil", description: "" },
      { label: "Olive", description: "" },
    ],
  };
  const lone = parseOptionPrompt("id", { questions: [multiQ] });
  assert.equal(optionPromptHasSubmitTab(lone.questions), true, "multiSelect forces a Submit tab");
  assert.deepEqual(
    optionPromptAnswerSequence(lone.questions, [opts(1, 3)]),
    ["2", "4", RIGHT, "\r"],
    "lone multi-select: toggles + RIGHT + Submit CR (P2b)",
  );
  // P9b shape: single-select then multi-select.
  const mixed = parseOptionPrompt("id", { questions: [TOOL_INPUT.questions[0], multiQ] });
  assert.deepEqual(
    optionPromptAnswerSequence(mixed.questions, [opt(0), opts(1, 3)]),
    ["1", "2", "4", RIGHT, "\r"],
    "mixed: digit auto-advance, toggles, RIGHT, Submit CR (P9b)",
  );
  // P9h: multiSelect at a NON-final position — RIGHT advances to the next
  // question (not Submit), the next digit auto-advances, one final Submit CR.
  const multiFirst = parseOptionPrompt("id", { questions: [multiQ, TOOL_INPUT.questions[0]] });
  assert.deepEqual(
    optionPromptAnswerSequence(multiFirst.questions, [opts(0, 2), opt(1)]),
    ["1", "3", RIGHT, "2", "\r"],
    "multi at non-final position: toggles + RIGHT to next Q + digit + Submit CR (P9h)",
  );
  // kind/emptiness mismatches are bugs → throw.
  assert.throws(() => optionPromptAnswerSequence(lone.questions, [opt(1)]), /multi-select/);
  assert.throws(() => optionPromptAnswerSequence(mixed.questions, [opts(0), opts(1)]), /single-select/);
  assert.throws(() => optionPromptAnswerSequence(lone.questions, [opts()]), /at least one/);
  assert.throws(() => optionPromptAnswerSequence(lone.questions, [opts(1, 1)]), /twice/);
  // P9f (PROBED BROKEN): free-text on a multi-select question mis-answers —
  // the builder must refuse it until a working editor entry is probed.
  assert.throws(
    () => optionPromptAnswerSequence(lone.questions, [text("Anchovies")]),
    /free-text injection is not supported/,
  );
}

// 6) Free-text grammar (P3/P9c): digit(options.length+1) opens the editor, the
//    text travels as ONE chunk, CR saves (and submits when no Submit tab).
{
  const single = parseOptionPrompt("id", { questions: [TOOL_INPUT.questions[0]] });
  assert.deepEqual(
    optionPromptAnswerSequence(single.questions, [text("Turquoise with teal")]),
    ["4", "Turquoise with teal", "\r"],
    "lone free-text: open row, text chunk, CR submits (P3) — no extra CR",
  );
  const two = parseOptionPrompt("id", {
    questions: [TOOL_INPUT.questions[0], TOOL_INPUT.questions[1]],
  });
  assert.deepEqual(
    optionPromptAnswerSequence(two.questions, [text("Sunset orange"), opt(0)]),
    ["4", "Sunset orange", "\r", "1", "\r"],
    "free-text mid-form saves+advances, then digit, then Submit CR (P9c)",
  );
  // P9g: free-text as the LAST question of a Submit-tab form — save-CR lands
  // on the Submit tab; the final CR submits (both verified live).
  assert.deepEqual(
    optionPromptAnswerSequence(two.questions, [opt(1), text("Extra large please")]),
    ["2", "3", "Extra large please", "\r", "\r"], // Q2 has 2 options → editor digit 3
    "free-text last: save-CR + Submit CR (P9g)",
  );
  assert.throws(() => optionPromptAnswerSequence(single.questions, [text("  ")]), /empty/);
  assert.throws(() => optionPromptAnswerSequence(single.questions, [text("a\nb")]), /single line/);
}

// 7) Dismiss (P7/P9d): the synthetic "Chat about this" digit on the FIRST
//    question — options.length+2. Never Esc (hook-invisible, P4).
{
  const prompt = parseOptionPrompt("id", TOOL_INPUT);
  assert.deepEqual(optionPromptDismissSequence(prompt.questions), ["5"], "3 options → digit 5");
  const two = parseOptionPrompt("id", { questions: [TOOL_INPUT.questions[1]] });
  assert.deepEqual(optionPromptDismissSequence(two.questions), ["4"], "2 options → digit 4");
}

console.log("option-prompt-parse smoke: OK");
