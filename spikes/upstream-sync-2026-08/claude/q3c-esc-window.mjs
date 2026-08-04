// Q3c (F7) — narrow the Esc-pair window. Q3b bracketed it between 500ms (fires)
// and 1200ms (does not). Sonata's PARKED_CONFIRM_CANCEL_VERIFY_MS is 900ms, so
// the exact threshold matters. No history needed — the rewind panel opens either
// way ("Nothing to rewind to yet"), so this run costs no tokens.
import fs from "node:fs";
import { Capture, bootTrusted, KEYS, sleep } from "./driver.mjs";

const CWD = process.argv[2];
const OUT = process.argv[3];
fs.mkdirSync(CWD, { recursive: true });

const cap = new Capture(OUT, "Q3c — claude 2.1.220 Esc-pair timing window");
const p = await bootTrusted(CWD, cap);

const results = [];
for (const gap of [600, 700, 800, 900, 1000, 1100]) {
  p.write(KEYS.esc);
  await sleep(gap);
  p.write(KEYS.esc);
  await sleep(1400);
  const opened = /Rewind/.test(p.screen());
  results.push(`  gap=${String(gap).padStart(5)}ms  rewind panel: ${opened ? "OPENED" : "not opened"}`);
  cap.frame(p, `gap ${gap}ms — ${opened ? "OPENED" : "not opened"}`);
  if (opened) {
    p.write(KEYS.esc);
    await sleep(1200);
  }
  await sleep(1600); // let any double-Esc timer lapse before the next trial
}
cap.add("Q3c — verdict table", results.join("\n"));
console.log(results.join("\n"));

cap.addRaw("RAW pty stream (whole session)", p.raw);
cap.save();
p.kill();
process.exit(0);
