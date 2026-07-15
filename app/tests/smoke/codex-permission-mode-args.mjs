// Layer-1 fence — the CodexPermissionMode → spawn-args mapping at the codexArgs
// seam. This is the ONE place Duet's user-facing permission vocabulary fans
// back out to Codex's legacy (sandbox × approval × reviewer) flags, so it is
// pinned EXACTLY. Every row was live-verified against codex 0.144.4 to show the
// matching "(current)" in the TUI `/permissions` picker
// (spikes/codex-perm-profile-probe/probe-modes.mjs + probe-realargs.mjs).
//
// "Exactly" means the full ordered permission tail after the `-C <cwd>` anchor
// must equal the expected row AND no extra/duplicate permission-relevant token
// may appear anywhere in argv — a stray `-a on-failure` or a duplicate `-s`
// must fail this fence, which a mere subsequence check would let pass.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { codexArgs } = require("../../dist/runtime");

const failures = [];
const assert = (cond, label) => {
  if (!cond) failures.push(label);
};

const arrayEqual = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
const count = (argv, pred) => argv.filter(pred).length;

const CWD = "/tmp/duet perm fence";

// The exact ordered permission tail each mode must emit (order within the row
// is fixed: `-s <sandbox> -a <approval> -c approvals_reviewer="<reviewer>"`).
const EXPECTED_TAIL = {
  "ask-for-approval": ["-s", "workspace-write", "-a", "on-request", "-c", 'approvals_reviewer="user"'],
  "approve-for-me": [
    "-s",
    "workspace-write",
    "-a",
    "on-request",
    "-c",
    'approvals_reviewer="auto_review"',
  ],
  "full-access": ["-s", "danger-full-access", "-a", "never", "-c", 'approvals_reviewer="user"'],
};

const argvByMode = {};
for (const [mode, expectedTail] of Object.entries(EXPECTED_TAIL)) {
  // Bare call (no model/effort/speed/profile) → fully deterministic argv, so
  // the permission tail is the entire argv after `-C <cwd>`.
  const argv = codexArgs({ cwd: CWD, permissionMode: mode });
  argvByMode[mode] = argv;

  // Anchor on `-C <cwd>`; everything after it is the permission tail.
  const anchor = argv.indexOf("-C");
  assert(anchor !== -1 && argv[anchor + 1] === CWD, `${mode} carries the -C <cwd> anchor`);
  const tail = argv.slice(anchor + 2);
  assert(
    arrayEqual(tail, expectedTail),
    `${mode} emits EXACTLY its permission tail (got ${JSON.stringify(tail)})`,
  );

  // No extra/duplicate permission-relevant token anywhere in argv.
  assert(count(argv, (a) => a === "-s") === 1, `${mode} has exactly one -s`);
  assert(count(argv, (a) => a === "-a") === 1, `${mode} has exactly one -a`);
  assert(
    count(argv, (a) => typeof a === "string" && a.startsWith("approvals_reviewer=")) === 1,
    `${mode} has exactly one approvals_reviewer=`,
  );
}

const success = failures.length === 0;
console.log(JSON.stringify({ success, failures, argvByMode }, null, 2));
process.exitCode = success ? 0 : 1;
