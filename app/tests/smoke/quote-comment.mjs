import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Fixture table for the pure Quote & Comment core (plan §Serialization
// contract). Pure string-in/string-out — no DOM, so it runs in plain node
// against the built module.
const require = createRequire(import.meta.url);
const Q = require("../../dist/reading-core/quote-comment");

// 1) normalizeQuote — collapse whitespace runs and trim.
{
  assert.equal(Q.normalizeQuote("  hello   world  "), "hello world", "collapse + trim");
  assert.equal(
    Q.normalizeQuote("line one\n\n  line two\tindented"),
    "line one line two indented",
    "newlines, tabs, and indentation collapse to single spaces",
  );
  assert.equal(Q.normalizeQuote("   "), "", "all-whitespace → empty");
  assert.equal(Q.normalizeQuote("单 行　中文"), "单 行 中文", "ideographic space collapses too");
}

// 2) truncateQuote — the >180 boundary, exact head/tail, and code-point safety.
{
  assert.equal(Q.QUOTE_MAX_LENGTH, 180);
  assert.equal(Q.QUOTE_HEAD_LENGTH, 100);
  assert.equal(Q.QUOTE_TAIL_LENGTH, 60);
  assert.equal(Q.QUOTE_TRUNCATION_SEPARATOR, " … ");

  const atLimit = "a".repeat(180);
  assert.equal(Q.truncateQuote(atLimit), atLimit, "exactly 180 is NOT truncated");

  const under = "b".repeat(179);
  assert.equal(Q.truncateQuote(under), under, "179 untouched");

  // 181 chars: distinct head and tail markers so we can assert the exact cut.
  const head = "H".repeat(100);
  const middle = "M".repeat(21); // 100 + 21 + 60 = 181
  const tail = "T".repeat(60);
  const long = head + middle + tail;
  assert.equal(Array.from(long).length, 181, "fixture is 181 chars");
  assert.equal(
    Q.truncateQuote(long),
    `${head} … ${tail}`,
    "181 → first 100 + ' … ' + last 60 (middle dropped)",
  );

  // Code-point safety: a run of emoji (surrogate pairs) must never split.
  const emoji = "😀".repeat(200);
  const truncated = Q.truncateQuote(emoji);
  assert.ok(!truncated.includes("�"), "no replacement char from a split surrogate");
  assert.equal(
    Array.from(truncated).length,
    100 + 3 + 60,
    "truncated emoji quote keeps 100 head + separator + 60 tail code points",
  );
}

// 3) formatQuoteComment — exact wording, with normalize+truncate on the quote
//    and a trimmed comment.
{
  assert.equal(
    Q.formatQuoteComment("the  quoted\ntext", "  my thought  "),
    'About "the quoted text", My comments "my thought"',
    "exact paragraph wording; quote normalized, comment trimmed",
  );

  const head = "H".repeat(100);
  const tail = "T".repeat(60);
  const long = head + "X".repeat(50) + tail; // 210 chars
  assert.equal(
    Q.formatQuoteComment(long, "note"),
    `About "${head} … ${tail}", My comments "note"`,
    "a long quote is truncated inside the paragraph",
  );
}

// 4) appendToDraft — blank-line separation, trimEnd on existing, empty draft.
{
  assert.equal(Q.appendToDraft("", "P"), "P", "empty draft → just the paragraph");
  assert.equal(Q.appendToDraft("   \n  ", "P"), "P", "whitespace-only draft → just the paragraph");
  assert.equal(
    Q.appendToDraft("existing", "P"),
    "existing\n\nP",
    "non-empty draft → blank-line separated",
  );
  assert.equal(
    Q.appendToDraft("existing\n\n  ", "P"),
    "existing\n\nP",
    "trailing whitespace/newlines on the draft are trimmed before separation",
  );
  assert.equal(
    Q.appendToDraft("first\n\nsecond", "third"),
    "first\n\nsecond\n\nthird",
    "chained appends read in creation order",
  );
  // Purity: the input string is not mutated (it can't be — strings are
  // immutable — but assert the return is a fresh value, not the argument).
  const existing = "keep";
  assert.equal(Q.appendToDraft(existing, "P"), "keep\n\nP");
  assert.equal(existing, "keep", "argument untouched");
}

console.log("quote-comment core: normalize, truncate, format, and append tables hold");
