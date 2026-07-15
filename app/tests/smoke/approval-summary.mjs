// Approval-card SUMMARY unit (Upstream Sync S5). Pins the one-line "what the
// agent wants to do" copy that `approvalSummary` derives from a hook payload,
// with the Codex 0.144.4 apply_patch drift as its anchor case.
//
// Ground truth for the drift case is the REAL captured PermissionRequest from
// live codex 0.144.4 (spikes/codex-hooks-probe/probe-0144/
// verified-payloads-0.144.4.json) — a write approval now arrives as
// `tool_name: "apply_patch"` with NO `tool_input.description`, only the raw
// patch envelope in `tool_input.command`. The pre-S5 code rendered a bare
// "apply_patch"; this suite locks the file-named summary and, critically, that
// the Claude tool-derived path is byte-identical (the regression the extra
// branch could have introduced).
//
// Also asserts the choices sanity-check: an apply_patch (codex) ask offers only
// Approve/Deny — never an "Always allow" button, because Codex honors only
// one-shot allow/deny via the broker (codex-approvals.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { approvalSummary, brokerApprovalChoices, classifyApprovalKind } = require(
  "../../dist/main/runtime-controller",
);

const here = path.dirname(new URL(import.meta.url).pathname);
// The real captured payload — read the apply_patch envelope VERBATIM so the
// fixture tracks the live CLI, not a hand-copied approximation.
const capturedPayloads = JSON.parse(
  fs.readFileSync(
    path.resolve(
      here,
      "../../../spikes/codex-hooks-probe/probe-0144/verified-payloads-0.144.4.json",
    ),
    "utf8",
  ),
);
const realApplyPatch = capturedPayloads.PermissionRequest;

const checks = [];
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ label, pass, actual, expected });
}

// 1. The real captured 0.144.4 write approval → file-named summary (was a bare
//    "apply_patch" before S5). Sanity-guard the fixture's shape first.
assert.equal(realApplyPatch.tool_name, "apply_patch", "fixture drifted: expected apply_patch");
assert.equal(
  realApplyPatch.tool_input.description,
  undefined,
  "fixture drifted: 0.144.4 payload should carry NO description",
);
check("real 0.144.4 apply_patch (Add)", approvalSummary(realApplyPatch, "codex"), "Add  probe-write.txt");

// 2. Update File → the "Edit" voice (matches the Claude Edit/Write branch).
check(
  "apply_patch Update → Edit",
  approvalSummary(
    codexApplyPatch("*** Begin Patch\n*** Update File: src/main.ts\n@@\n-old\n+new\n*** End Patch"),
    "codex",
  ),
  "Edit  src/main.ts",
);

// 3. Delete File → Delete.
check(
  "apply_patch Delete → Delete",
  approvalSummary(
    codexApplyPatch("*** Begin Patch\n*** Delete File: dead.txt\n*** End Patch"),
    "codex",
  ),
  "Delete  dead.txt",
);

// 4. Multiple file ops → first op + "(+N more)".
check(
  "apply_patch multi-file → first + (+N more)",
  approvalSummary(
    codexApplyPatch(
      [
        "*** Begin Patch",
        "*** Add File: a.txt",
        "+one",
        "*** Update File: b.txt",
        "@@",
        "-x",
        "+y",
        "*** Delete File: c.txt",
        "*** End Patch",
      ].join("\n"),
    ),
    "codex",
  ),
  "Add  a.txt (+2 more)",
);

// 5. An Update+Move renames — the summary names the file being changed (the
//    Move-to target is not surfaced), still in the Edit voice.
check(
  "apply_patch Update+Move → Edit of the original path",
  approvalSummary(
    codexApplyPatch(
      "*** Begin Patch\n*** Update File: old/name.ts\n*** Move to: new/name.ts\n@@\n-a\n+b\n*** End Patch",
    ),
    "codex",
  ),
  "Edit  old/name.ts",
);

// 5b. A hunk BODY context line (single-space prefix) that literally reads
//     `*** Update File: decoy.ts` must NOT count as an op — headers anchor at
//     column 0, so the self-referential patch stays a single-file summary.
check(
  "apply_patch hunk context line is not counted as a header",
  approvalSummary(
    codexApplyPatch(
      [
        "*** Begin Patch",
        "*** Update File: real.ts",
        "@@",
        " *** Update File: decoy.ts",
        "+added",
        "*** End Patch",
      ].join("\n"),
    ),
    "codex",
  ),
  "Edit  real.ts",
);

// 6. Malformed / unparseable envelope → honest fallback, never a throw.
check(
  "apply_patch malformed → Apply patch",
  approvalSummary(codexApplyPatch("not a patch at all"), "codex"),
  "Apply patch",
);
check(
  "apply_patch empty command → Apply patch",
  approvalSummary(codexApplyPatch(""), "codex"),
  "Apply patch",
);

// 7. Legacy codex payload WITH description → description STILL wins (older codex
//    builds send ready-made copy; the description preference is unchanged).
check(
  "legacy codex description still wins over tool branches",
  approvalSummary(
    {
      hook_event_name: "PermissionRequest",
      tool_name: "apply_patch",
      tool_input: {
        description: "Do you want to allow writing probe-write.txt?",
        command: "*** Begin Patch\n*** Add File: probe-write.txt\n+hi\n*** End Patch",
      },
    },
    "codex",
  ),
  "Do you want to allow writing probe-write.txt?",
);

// 8. BYTE-IDENTICAL Claude path — the S5 branch must not perturb any Claude
//    tool's summary. A Claude Edit renders exactly as before.
check(
  "claude Edit unchanged (byte-identical)",
  approvalSummary(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/repo/src/app.ts" },
    },
    "claude",
  ),
  "Edit  /repo/src/app.ts",
);
// A Claude Bash command likewise unchanged.
check(
  "claude Bash unchanged (byte-identical)",
  approvalSummary(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } },
    "claude",
  ),
  "Run  git status",
);

// 9. Choices sanity-check: a codex apply_patch ask offers ONLY Approve/Deny —
//    no "Always allow" button (codex honors only one-shot allow/deny). The
//    kind classifies to "unknown" (apply_patch is not in Duet's Claude tool
//    grammar), but the codex choice path is kind-agnostic, so this holds.
const applyKind = classifyApprovalKind(realApplyPatch);
const codexChoices = brokerApprovalChoices(applyKind, realApplyPatch, "codex");
check(
  "codex apply_patch choices = approve/deny only",
  codexChoices.map((c) => c.decision),
  ["approve", "deny"],
);
check(
  "codex apply_patch never offers approve-always",
  codexChoices.some((c) => c.decision === "approve-always"),
  false,
);

function codexApplyPatch(command) {
  return {
    hook_event_name: "PermissionRequest",
    tool_name: "apply_patch",
    tool_input: { command },
  };
}

let failed = 0;
for (const c of checks) {
  if (!c.pass) {
    failed += 1;
    console.error(`FAIL ${c.label}\n  actual:   ${JSON.stringify(c.actual)}\n  expected: ${JSON.stringify(c.expected)}`);
  } else {
    console.log(`ok   ${c.label}`);
  }
}
console.log(JSON.stringify({ total: checks.length, failed }, null, 2));
process.exitCode = failed === 0 ? 0 : 1;
