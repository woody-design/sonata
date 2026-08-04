// Runs the PRODUCTION parsers (dist/runtime, built from app/src) against a raw
// pty stream captured by this spike's driver. Usage:
//   node check-needles.mjs <capture.txt> [<capture.txt> ...]
import fs from "node:fs";
import { createRequire } from "node:module";

const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const R = require(APP_DIR + "dist/runtime");

/** Pull the JSON-encoded RAW stream back out of a capture file. */
function rawOf(file) {
  const text = fs.readFileSync(file, "utf8");
  const i = text.indexOf("===== RAW pty stream");
  if (i < 0) return null;
  const body = text.slice(text.indexOf("\n", i) + 1).trim();
  return JSON.parse(body);
}

// Mirrors terminal-host.ts compactText + includesApprovalHints (not exported).
const compactText = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");
const cleanTerminal = (t) =>
  t.replace(/[][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]/g, "")
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const HINTS = {
  workspaceTrust: [
    "quick safety check",
    "is this a project you created or one you trust",
    "yes, i trust this folder",
    "enter to confirm",
  ],
  fileEdit: ["do you want to make this edit", "do you want to make these edits", "allow this edit", "allow edits", "enter to confirm"],
  fileRead: ["read(", "allow reading from", "during this session"],
  command: ["do you want to proceed", "allow command", "allow this command", "run this command", "enter to confirm"],
};

for (const file of process.argv.slice(2)) {
  const raw = rawOf(file);
  console.log(`\n######## ${file.split("/").pop()} ########`);
  if (!raw) { console.log("  (no RAW section)"); continue; }
  const compact = compactText(cleanTerminal(raw).toLowerCase());

  console.log("-- CLAUDE_*_APPROVAL_HINTS per-needle membership --");
  for (const [group, hints] of Object.entries(HINTS)) {
    const hits = hints.map((h) => `${compact.includes(compactText(h)) ? "HIT " : "MISS"} ${JSON.stringify(h)}`);
    const endNeedle = compactText(hints[hints.length - 1]);
    const triggers = hints.slice(0, -1).map(compactText);
    const fires = compact.includes(endNeedle) && triggers.some((h) => compact.includes(h));
    console.log(`  ${group}: includesApprovalHints => ${fires}`);
    for (const h of hits) console.log(`      ${h}`);
  }

  console.log("-- parseClaudeApprovalPanel --");
  console.log("  " + JSON.stringify(R.parseClaudeApprovalPanel(raw)));

  console.log("-- detectApprovalCandidateForProvider('claude') --");
  console.log("  " + JSON.stringify(R.detectApprovalCandidateForProvider(raw, "claude")));

  console.log("-- detectIdlePromptForProvider('claude') --");
  console.log("  " + JSON.stringify(R.detectIdlePromptForProvider(raw, "claude")));

  console.log("-- detectIdleComposerForProvider('claude') --");
  try { console.log("  " + JSON.stringify(R.detectIdleComposerForProvider(raw, "claude"))); }
  catch (e) { console.log("  ERR " + e.message); }

  console.log("-- parseClaudeControlReceipt --");
  console.log(`  model: ${R.parseClaudeControlReceipt(raw, "model")}   effort: ${R.parseClaudeControlReceipt(raw, "effort")}`);

  console.log("-- cache-miss dialog --");
  console.log(`  open=${R.claudeCacheMissDialogOpen(raw)} cursor=${R.parseClaudeCacheMissCursor(raw)} cancelledModel=${R.claudeCacheMissCancelled ? R.claudeCacheMissCancelled(raw, "model") : "n/a"}`);
}
