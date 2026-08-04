// Runs the REAL production parsers from
// app/src/runtime/terminal-host/tui-parsers-codex.ts (esbuild-bundled,
// unmodified) against the raw PTY streams captured in this directory.
//
// This is the whole point of the probe: not "does the string look right to me",
// but "does Sonata's own code, unchanged, read the real 0.146.0 stream".
//
// Each raw log is fed in TWO ways, because the difference between them is itself
// a finding:
//   WHOLE   — the entire session stream, as if Sonata's rolling scan window had
//             retained everything since boot.
//   WINDOW  — the last 4000 chars only, approximating the bounded tail the
//             production scan actually keys on right after an action.
//
// Usage: SONATA_PARSERS=<abs path to bundle> node check-needles.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundle = process.env.SONATA_PARSERS;
if (!bundle) {
  console.error("set SONATA_PARSERS to the esbuild bundle of tui-parsers-codex.ts");
  process.exit(1);
}
const P = await import(bundle);

const cases = [
  {
    file: "out-q1-consent.raw.log",
    label: "Q1 — /permissions picker + Full Access consent",
    checks: [
      ["codexPermissionPickerOpen", (s) => P.codexPermissionPickerOpen(s), true],
      ["codexPermissionPickerFooterVisible", (s) => P.codexPermissionPickerFooterVisible(s), true],
      ["parseCodexPermissionPickerCursor", (s) => P.parseCodexPermissionPickerCursor(s), "full-access"],
      ["codexPermissionConsentDialogOpen", (s) => P.codexPermissionConsentDialogOpen(s), true],
      ["parseCodexConsentCursor", (s) => P.parseCodexConsentCursor(s), 1],
    ],
  },
  {
    file: "out-q2a-model-plain.raw.log",
    label: "Q2a — bare `codex`, /model level 1",
    checks: [
      ["codexModelPickerLevel1Open", (s) => P.codexModelPickerLevel1Open(s), true],
      ["codexModelPickerFooterVisible", (s) => P.codexModelPickerFooterVisible(s), true],
      ["parseCodexModelLevel1.cursor", (s) => P.parseCodexModelLevel1(s).cursor, "gpt-5.6-sol"],
      ["parseCodexModelLevel1.current", (s) => P.parseCodexModelLevel1(s).current, "gpt-5.6-sol"],
      ["parseCodexModelLevel1.rowCount", (s) => P.parseCodexModelLevel1(s).order.size, 7],
    ],
  },
  {
    file: "out-q2b-model-walk.raw.log",
    label: "Q2b — production shape, full walk + Ultra switch",
    checks: [
      ["codexModelPickerLevel2Open", (s) => P.codexModelPickerLevel2Open(s), true],
      ["codexModelPickerLevel2Open('gpt-5.6-sol')", (s) => P.codexModelPickerLevel2Open(s, "gpt-5.6-sol"), true],
      ["parseCodexModelLevel2.current", (s) => P.parseCodexModelLevel2(s).current, "high"],
      ["parseCodexModelLevel2.rowCount", (s) => P.parseCodexModelLevel2(s).order.size, 5],
      ["parseCodexModelLevel2.hasMoreRow", (s) => P.parseCodexModelLevel2(s).order.has("more"), true],
      ["parseCodexModelReceipt (ULTRA switch)", (s) => JSON.stringify(P.parseCodexModelReceipt(s)), "non-null"],
    ],
  },
  {
    file: "out-q2c-receipt-medium.raw.log",
    label: "Q2c — same switch to a v1-set effort (Medium), to isolate the receipt failure",
    checks: [
      ["parseCodexModelReceipt (MEDIUM switch)", (s) => JSON.stringify(P.parseCodexModelReceipt(s)), "non-null"],
    ],
  },
  {
    file: "out-q4-status-timing.raw.log",
    label: "Q4 — activity hints on a real turn",
    optional: true,
    checks: [
      [
        "activityHints ['working','esc to interrupt'] on the CLEANED tail",
        (s) => {
          const lowered = s
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
            .toLowerCase();
          return JSON.stringify({
            working: lowered.includes("working"),
            escToInterrupt: lowered.includes("esc to interrupt"),
          });
        },
        'both true',
      ],
    ],
  },
];

let failures = 0;
for (const c of cases) {
  const file = path.join(HERE, c.file);
  if (!fs.existsSync(file)) {
    if (c.optional) {
      console.log(`\n### ${c.label}\n  (capture missing: ${c.file})`);
      continue;
    }
    throw new Error(`missing capture ${c.file}`);
  }
  const whole = fs.readFileSync(file, "utf8");
  const window = whole.slice(-4000);
  console.log(`\n### ${c.label}   [${c.file}]`);
  for (const [name, fn, expected] of c.checks) {
    const w = fn(whole);
    const t = fn(window);
    const bad = w === false || w === null || w === undefined || w === "null";
    if (bad) failures += 1;
    console.log(
      `  ${bad ? "FAIL" : "ok  "}  ${name}\n` +
        `          whole-stream: ${JSON.stringify(w)}   last-4000: ${JSON.stringify(t)}   expected: ${expected}`,
    );
  }
}
console.log(`\n=== ${failures} failing production parser(s) against real codex 0.146.0 output ===`);
