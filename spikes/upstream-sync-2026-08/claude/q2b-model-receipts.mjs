// Q2b (F6) — `/model <alias>` ARG-FORM receipts at claude 2.1.220, injected the
// EXACT way Sonata injects them (writeClaudeValueCommand: typed chars, then a
// deferred raw `\r` 120ms later — control-switch-engine.ts).
// Also probes the new picker footer affordance `s to use this session only`.
// Global default is switched away and back; the caller restores + hash-verifies
// ~/.claude/settings.json around this run.
import fs from "node:fs";
import { Capture, bootTrusted, KEYS, sleep } from "./driver.mjs";

const CWD = process.argv[2];
const OUT = process.argv[3];
fs.mkdirSync(CWD, { recursive: true });

const cap = new Capture(OUT, "Q2b — claude 2.1.220 /model receipts (Sonata inject shape)");
cap.add("cwd", CWD.replace(process.env.HOME, "$HOME"));

const p = await bootTrusted(CWD, cap);

/** Sonata's writeClaudeValueCommand shape. */
async function inject(command) {
  p.write(command);
  await sleep(120);
  p.write("\r");
}

async function step(command, label, settleMs = 6000) {
  const mark = p.raw.length;
  await inject(command);
  await sleep(settleMs);
  cap.frame(p, label, { attrs: true });
  cap.addRaw(`${label} — RAW slice since inject`, p.raw.slice(mark));
}

await step("/model sonnet", "step 1 — `/model sonnet` (arg form)");
await step("/model fable", "step 2 — `/model fable` (arg form, restores default)");
await step("/model bogus-model-xyz", "step 3 — `/model bogus-model-xyz` (failure receipt)");

// Picker + `s` (session only) — does it emit a receipt, and does it avoid the
// global default write?
const mark = p.raw.length;
await p.type("/model", 40);
await sleep(1000);
p.write(KEYS.enter);
await sleep(2000);
cap.frame(p, "step 4a — picker open", { attrs: true });
p.write(KEYS.down);
await sleep(500);
p.write(KEYS.down);
await sleep(500);
cap.frame(p, "step 4b — focus moved down twice", { attrs: true });
p.write("s");
await sleep(4000);
cap.frame(p, "step 4c — after `s` (use this session only)", { attrs: true });
cap.addRaw("step 4 — RAW slice since picker open", p.raw.slice(mark));

cap.addRaw("RAW pty stream (whole session)", p.raw);
cap.save();
p.kill();
process.exit(0);
