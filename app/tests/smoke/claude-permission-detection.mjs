// Layer-1 regression — detectClaudePermissionMode must read the CURRENT
// mode from a Shift+Tab cycling stream, where every mode's banner has been
// appended in turn. The original substring-anywhere test misread auto as
// acceptEdits (the first-checked mode whose banner appears earlier in the
// accumulated tail). Fixtures are taken verbatim from real cycling evidence
// (Temp/probes auto-mode-switch). Pure function, no CLI — environment-free.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { detectClaudePermissionMode } = require("../../dist/runtime");

// A status line always ends in the "← for agents" hint; the mode banner (if
// any) sits just before it. After cycling, ALL prior banners linger in the
// stream — only the last status line reflects the current mode.
const CYCLE_PREFIX =
  "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents\n" +
  "⏸ plan mode on (shift+tab to cycle) · ← for agents\n" +
  "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n";

const cases = [
  { name: "auto current after full cycle", text: CYCLE_PREFIX + "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents", expect: "auto" },
  { name: "plan current after cycle", text: CYCLE_PREFIX + "⏸ plan mode on (shift+tab to cycle) · ← for agents", expect: "plan" },
  { name: "acceptEdits current after cycle", text: CYCLE_PREFIX + "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents", expect: "acceptEdits" },
  { name: "default current after cycle (bare hint, no banner)", text: CYCLE_PREFIX + "← for agents ● high · /effort", expect: "default" },
  { name: "fresh default launch", text: "❯ Try \"how do I log an error?\"\n← for agents ● high · /effort", expect: "default" },
  { name: "collapsed spaces (cleanTerminal drift)", text: "⏵⏵automodeon(shift+tabtocycle)·←foragents", expect: "auto" },
  { name: "no composer yet", text: "Welcome back Woody! starting up…", expect: null },
];

const failures = [];
for (const c of cases) {
  const got = detectClaudePermissionMode(c.text);
  if (got !== c.expect) {
    failures.push(`${c.name}: expected ${c.expect}, got ${got}`);
  }
}

const success = failures.length === 0;
console.log(JSON.stringify({ success, failures, total: cases.length }, null, 2));
process.exitCode = success ? 0 : 1;
