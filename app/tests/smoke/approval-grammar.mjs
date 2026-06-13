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
const { detectApprovalCandidateForProvider } = require("../../dist/runtime");

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
  };
}

// --- Real 2.1.176 captures ---
check("trust panel", summarize(detectApprovalCandidateForProvider(fixture("trust-2.1.176.txt"), "claude")), {
  kind: "workspace-trust",
  grammar: "v2",
  decisions: ["approve:CR", "deny:Esc"],
  keys: { approve: "\r" },
});

check(
  "command panel, in-project mutation (session grant)",
  summarize(detectApprovalCandidateForProvider(fixture("command-mkdir-session-2.1.176.txt"), "claude")),
  {
    kind: "command",
    grammar: "v2",
    decisions: ["approve:digit 1", "approve-for-session:digit 2", "deny:Esc"],
    keys: { approve: "1", "approve-for-session": "2" },
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
  },
);

check("edit panel", summarize(detectApprovalCandidateForProvider(fixture("edit-2.1.176.txt"), "claude")), {
  kind: "file-edit",
  grammar: "v2",
  decisions: ["approve:digit 1", "approve-for-session:digit 2", "deny:Esc"],
  keys: { approve: "1", "approve-for-session": "2" },
});

check("create panel", summarize(detectApprovalCandidateForProvider(fixture("create-2.1.176.txt"), "claude")), {
  kind: "file-edit",
  grammar: "v2",
  decisions: ["approve:digit 1", "approve-for-session:digit 2", "deny:Esc"],
  keys: { approve: "1", "approve-for-session": "2" },
});

check("read panel", summarize(detectApprovalCandidateForProvider(fixture("read-2.1.176.txt"), "claude")), {
  kind: "file-read",
  grammar: "v2",
  decisions: ["approve:digit 1", "approve-for-session:digit 2", "deny:Esc"],
  keys: { approve: "1", "approve-for-session": "2" },
});

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
});

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
