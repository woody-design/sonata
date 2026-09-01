// Layer-2a verification — the claude ≥2.1.17x structured panel parser,
// fed with REAL terminal captures from the 2026-06-13 probes (fixtures are
// untouched cleanTerminal output, spinner noise and cursor-diff garbling
// included). Asserts kind, grammar, option semantics, key encodings, and
// the two regressions the probes exposed:
//  - command/edit/create panels were invisible to the legacy hint detector
//    ("enter to confirm" footer is gone in 2.1.176);
//  - an edit panel with a ⏺ Read(…) line in the recent stream was
//    misclassified as file-read (anywhere-substring history bleed).
// Plus: legacy-grammar panels still detect via the hint fallback.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { detectApprovalCandidateForProvider, parseClaudeTrustDialogRows } = require("../../dist/runtime");

const fixturesDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../fixtures/approval-panels",
);

function fixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

const checks = [];
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ label, pass, actual, expected });
  return pass;
}

function summarize(candidate) {
  if (!candidate) {
    return null;
  }
  return {
    kind: candidate.kind,
    grammar: candidate.grammar,
    decisions: candidate.choices.map((choice) => `${choice.decision}:${choice.encodedAs}`),
    keys: candidate.optionKeys ?? null,
    walk: candidate.optionWalk ?? null,
  };
}

// --- Real 2.1.176 captures ---
// The trust screen carries NO approve key on either grammar: its approve is a
// grid-verified cursor walk (upstream sync 2026-09-01). At 2.1.176 the affirm
// row was already first AND focused, so the walk confirms on its first read —
// the same code, one layout earlier.
check("trust panel", summarize(detectApprovalCandidateForProvider(fixture("trust-2.1.176.txt"), "claude")), {
  kind: "workspace-trust",
  grammar: "v2",
  decisions: ["approve:grid-verified Arrow + CR", "deny:Esc"],
  keys: {},
  walk: "claude-workspace-trust",
});

// --- Real 2.1.252 capture (MEASURED: spikes/upstream-sync-2026-09/claude/
// q4-trust-fix-live.mjs, grid frame straight off the production screen model).
// The rows lost their `1.`/`2.` digits here, which used to drop the panel out of
// the structured parser and into the legacy hint path — whose generic approve
// encoding is a CSI-u Enter, MEASURED exiting the CLI with status 1 from this
// screen's default row. So the parse must hold, and the approve must be the
// walk with NO key behind it. ---
check(
  "trust panel 2.1.252 (digit-less rows) still parses structurally",
  summarize(detectApprovalCandidateForProvider(fixture("trust-2.1.252.txt"), "claude")),
  {
    kind: "workspace-trust",
    grammar: "v2",
    decisions: ["approve:grid-verified Arrow + CR", "deny:Esc"],
    keys: {},
    walk: "claude-workspace-trust",
  },
);

// The row reader the walk steers by. 2.1.252 paints the DECLINE row first and
// focused; the affirm row is below it, so the walk's direction is Down here and
// Up on the 2.1.176 layout — read from the grid, never assumed.
check("2.1.252 rows: decline focused, affirm below", parseClaudeTrustDialogRows(fixture("trust-2.1.252.txt")), {
  affirmIndex: 14,
  declineIndex: 13,
  focused: "decline",
});
check(
  "2.1.252 rows after the walk's arrow: affirm focused",
  parseClaudeTrustDialogRows(fixture("trust-2.1.252-affirm-focused.txt")),
  { affirmIndex: 14, declineIndex: 13, focused: "affirm" },
);
check("2.1.176 rows: affirm FIRST and focused (the layout that moved)", parseClaudeTrustDialogRows(fixture("trust-2.1.176.txt")), {
  affirmIndex: 26,
  declineIndex: 28,
  focused: "affirm",
});
// Half a dialog is not a dialog: a screen missing either row must read null so
// the walk aborts rather than pressing at something it cannot see.
check(
  "affirm row alone does not parse as the trust dialog",
  parseClaudeTrustDialogRows(" ❯ Yes, I trust this folder\n Enter to confirm · Esc to cancel"),
  null,
);
check(
  "decline row alone does not parse as the trust dialog",
  parseClaudeTrustDialogRows(" ❯ No, exit\n Enter to confirm · Esc to cancel"),
  null,
);
// A mid-repaint frame where neither row carries the cursor: rows known, focus
// null — the walk WAITS on this, it does not press.
check(
  "no cursor on either row → focused null",
  parseClaudeTrustDialogRows("   No, exit\n   Yes, I trust this folder"),
  { affirmIndex: 1, declineIndex: 0, focused: null },
);

check(
  "command panel, in-project mutation (session grant)",
  summarize(detectApprovalCandidateForProvider(fixture("command-mkdir-session-2.1.176.txt"), "claude")),
  {
    kind: "command",
    grammar: "v2",
    decisions: ["approve:digit 1", "approve-for-session:digit 2", "deny:Esc"],
    keys: { approve: "1", "approve-for-session": "2" },
    walk: null,
  },
);

check(
  "command panel, don't-ask-again (persist class)",
  summarize(detectApprovalCandidateForProvider(fixture("command-md5-persist-2.1.176.txt"), "claude")),
  {
    kind: "command",
    grammar: "v2",
    decisions: ["approve:digit 1", "approve-always:digit 2", "deny:Esc"],
    keys: { approve: "1", "approve-always": "2" },
    walk: null,
  },
);

check("edit panel", summarize(detectApprovalCandidateForProvider(fixture("edit-2.1.176.txt"), "claude")), {
  kind: "file-edit",
  grammar: "v2",
  decisions: ["approve:digit 1", "approve-for-session:digit 2", "deny:Esc"],
  keys: { approve: "1", "approve-for-session": "2" },
  walk: null,
});

check("create panel", summarize(detectApprovalCandidateForProvider(fixture("create-2.1.176.txt"), "claude")), {
  kind: "file-edit",
  grammar: "v2",
  decisions: ["approve:digit 1", "approve-for-session:digit 2", "deny:Esc"],
  keys: { approve: "1", "approve-for-session": "2" },
  walk: null,
});

check("read panel", summarize(detectApprovalCandidateForProvider(fixture("read-2.1.176.txt"), "claude")), {
  kind: "file-read",
  grammar: "v2",
  decisions: ["approve:digit 1", "approve-for-session:digit 2", "deny:Esc"],
  keys: { approve: "1", "approve-for-session": "2" },
  walk: null,
});

// Bypass interstitial (Layer 2b): deny listed FIRST (safe default mirrors
// native's "No, exit"); accept is the deliberate digit-2 opt-in. Detected
// as its own kind so the card can warn rather than read as a tool approval.
check(
  "bypass interstitial",
  summarize(detectApprovalCandidateForProvider(fixture("dangerous-bypass-2.1.176.txt"), "claude")),
  {
    kind: "dangerous-bypass",
    grammar: "v2",
    decisions: ["deny:Esc", "approve:digit 2"],
    keys: { approve: "2" },
    walk: null,
  },
);

// --- History-bleed regression: a completed ⏺ Read(…) tool line in the
// stream must NOT drag an edit panel into file-read. ---
const editWithReadHistory = `⏺ Read(probe-edit.txt)\n  ⎿  Read 1 line\n${fixture("edit-2.1.176.txt")}`;
const bleed = detectApprovalCandidateForProvider(editWithReadHistory, "claude");
check("edit panel with Read( history stays file-edit", bleed?.kind, "file-edit");

// --- Live panel blocks readiness: promptAfterApproval must be false while
// the panel is the last thing painted. ---
const live = detectApprovalCandidateForProvider(fixture("command-md5-persist-2.1.176.txt"), "claude");
check("live v2 panel not read as answered", live?.promptAfterApproval, false);

// --- Old-grammar panels (pre-2.1.17x: "Enter to confirm" footer) carry
// the same question/options/footer structure, so the v2 parser handles
// them too — digits select on Ink option lists across versions. ---
const oldStylePanel = [
  "Thinking…",
  "Read(/tmp/sample.txt)",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "2. Yes, allow reading from tmp/ during this session",
  "3. No",
  "",
  "Enter to confirm · Esc to cancel",
].join("\n");
check("old-grammar panel parses structurally", summarize(detectApprovalCandidateForProvider(oldStylePanel, "claude")), {
  kind: "file-read",
  grammar: "v2",
  decisions: ["approve:digit 1", "approve-for-session:digit 2", "deny:Esc"],
  keys: { approve: "1", "approve-for-session": "2" },
  walk: null,
});

// --- True hint fallback: a degenerate paint with no numbered option lines
// cannot parse structurally; the legacy hints still see it and keep the
// historically verified encodings (CSI-u Enter). ---
const degeneratePanel = [
  "Do you want to make this edit to notes.txt?",
  "",
  "Enter to confirm · Esc to cancel",
].join("\n");
const fallback = detectApprovalCandidateForProvider(degeneratePanel, "claude");
check("degenerate panel falls back to hints", summarize(fallback), {
  kind: "file-edit",
  grammar: "legacy",
  decisions: ["approve:CSI-u Enter", "deny:Esc"],
  keys: null,
  walk: null,
});

// --- The TRUST screen's legacy BACKSTOP. Fixture COMPOSED: a constructed
// degradation (trust anchor + footer, affirm row missing), not a capture — the
// shape a future upstream reword would produce if it broke the structured parse
// the way 2.1.252's digit-less rows already did once.
//
// That is exactly the state this slice was born in: the panel drops to the
// legacy hint path, whose GENERIC approve encoding is a CSI-u Enter — measured
// exiting claude 2.1.252 with status 1 from this screen's default row. So the
// backstop must hold here: `workspace-trust` on the legacy route still yields
// the walk and the trust choices, never the generic ones above. Without this
// case the backstop is untested — approval-grammar's other trust checks and the
// trust-trail fake CLI both parse as v2 and never reach this branch. ---
const degenerateTrust = [
  "Quick safety check: Is this a project you created or one you trust?",
  "",
  "Enter to confirm · Esc to cancel",
].join("\n");
check(
  "degenerate TRUST paint keeps the walk on the legacy route (backstop)",
  summarize(detectApprovalCandidateForProvider(degenerateTrust, "claude")),
  {
    kind: "workspace-trust",
    grammar: "legacy",
    decisions: ["approve:grid-verified Arrow + CR", "deny:Esc"],
    keys: null,
    walk: "claude-workspace-trust",
  },
);
// The walk is claude-only: codex's trust dialog is the hook broker's, and
// sendApprovalDecision refuses non-claude outright.
check(
  "the trust walk is never declared for codex",
  detectApprovalCandidateForProvider(degenerateTrust, "codex")?.optionWalk ?? null,
  null,
);

const failures = checks.filter((entry) => !entry.pass);
console.log(
  JSON.stringify(
    {
      success: failures.length === 0,
      total: checks.length,
      failures,
    },
    null,
    2,
  ),
);
process.exit(failures.length === 0 ? 0 : 1);
