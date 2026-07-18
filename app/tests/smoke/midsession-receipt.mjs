import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Unit coverage for the mid-session switch receipt parser (S1). The pure
// parser is the seam the receipt watcher keys on: it turns the RAW pty tail
// (ANSI + word-positioned redraw + whitespace noise) into a settle / fail /
// keep-waiting verdict. Strings are the probe-verified verbatim receipts
// (claude 2.1.214 — spikes/midsession-switch-probe/findings.md).
const require = createRequire(import.meta.url);
const { parseClaudeControlReceipt } = require("../../dist/runtime");

// — Success: model —
assert.equal(
  parseClaudeControlReceipt(
    "⎿ Set model to Sonnet 5 and saved as your default for new sessions",
    "model",
  ),
  "settled",
  "the `Set model to …` receipt settles a model switch",
);

// The REAL rendered receipt is WORD-POSITIONED — claude lays it out with cursor
// moves, so once ANSI is stripped the words glue ("SetmodeltoSonnet 5andsaved").
// This is the exact string captured from the pty (spikes/midsession-switch-probe
// inject-probe) — the parser MUST still settle it (regression pin for the
// space-bearing-regex bug).
assert.equal(
  parseClaudeControlReceipt(
    "  ⎿  SetmodeltoSonnet 5andsavedasyourdefaultfornewsessions",
    "model",
  ),
  "settled",
  "the word-positioned (glued) model receipt still settles",
);
assert.equal(
  parseClaudeControlReceipt("  ⎿  SeteffortleveltolowsavedasyourdefaultfornewsessionsX", "effort"),
  "settled",
  "the word-positioned (glued) effort receipt still settles",
);

// — Success: effort —
assert.equal(
  parseClaudeControlReceipt(
    "⎿ Set effort level to low (saved as your default for new sessions)",
    "effort",
  ),
  "settled",
  "the `Set effort level to …` receipt settles an effort switch",
);

// — Failure: model —
assert.equal(
  parseClaudeControlReceipt("⎿ Model 'bogus-model-xyz' not found", "model"),
  "failed",
  "the `Model '<x>' not found` receipt fails a model switch",
);

// — Timeout paths: no receipt yet (parser returns null → the watcher waits,
//   then the timeout re-classifies the screen as needs-attention). —
assert.equal(
  parseClaudeControlReceipt("❯ /model sonnet", "model"),
  null,
  "the echoed command line is not a receipt",
);
assert.equal(
  parseClaudeControlReceipt("", "model"),
  null,
  "an empty scan keeps waiting",
);
assert.equal(
  parseClaudeControlReceipt(
    "· Thinking… (esc to interrupt · ctrl+t to hide todos)",
    "effort",
  ),
  null,
  "unrelated TUI chrome keeps waiting",
);

// — Cross-kind isolation: each kind matches only its own receipt line. —
assert.equal(
  parseClaudeControlReceipt("⎿ Set effort level to low", "model"),
  null,
  "an effort receipt must NOT settle a model switch",
);
assert.equal(
  parseClaudeControlReceipt("⎿ Set model to Sonnet 5", "effort"),
  null,
  "a model receipt must NOT settle an effort switch",
);
// `/effort` has no probed failure receipt — a `Model '…' not found` in the
// scan must not fail an effort switch (it times out to needs-attention).
assert.equal(
  parseClaudeControlReceipt("⎿ Model 'x' not found", "effort"),
  null,
  "the model-failure line does not fail an effort switch",
);

// — Robustness: ANSI escapes + word-positioned redraw + whitespace noise. The
//   parser strips ANSI and collapses whitespace, so a split/positioned receipt
//   still matches (the RAW tail is accumulated before parsing). —
assert.equal(
  parseClaudeControlReceipt(
    "\x1b[2m\x1b[38;5;244m⎿ Set model to\x1b[0m\x1b[32G Fable 5\x1b[0m",
    "model",
  ),
  "settled",
  "ANSI-decorated + cursor-positioned receipt still settles",
);
assert.equal(
  parseClaudeControlReceipt("⎿   Set    model\n   to   Opus 4.8", "model"),
  "settled",
  "collapsed whitespace bridges a wrapped receipt",
);

// — Failure wins over success in the same scan (safe ordering): a screen that
//   somehow shows both is treated as a failure, never a false settle. —
assert.equal(
  parseClaudeControlReceipt(
    "⎿ Model 'bogus' not found\n⎿ Set model to Sonnet 5",
    "model",
  ),
  "failed",
  "a failure line in the scan wins over a later success line",
);

console.log("midsession-receipt: OK");
