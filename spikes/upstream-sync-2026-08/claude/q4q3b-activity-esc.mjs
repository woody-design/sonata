// Q4 — activity hint during a live turn at claude 2.1.220: does the literal
//      "esc to interrupt" render? do the spinner glyphs ✢✳✶✻✽· still appear?
// Q3b — Esc/Esc at an idle composer WITH conversation history (the rewind picker
//      now has rows), plus the Esc-pair timing window.
// One trivial prompt; nothing else costs tokens.
import fs from "node:fs";
import { Capture, bootTrusted, KEYS, sleep } from "./driver.mjs";

const CWD = process.argv[2];
const OUT = process.argv[3];
fs.mkdirSync(CWD, { recursive: true });

const cap = new Capture(OUT, "Q4/Q3b — claude 2.1.220 activity hint + Esc/Esc with history");
cap.add("cwd", CWD.replace(process.env.HOME, "$HOME"));

const p = await bootTrusted(CWD, cap);

// ── Q4: one trivial prompt, sampled hard during the working state ───────────
const submitMark = p.raw.length;
await p.type("reply with the single word: ok", 20);
await sleep(200);
cap.frame(p, "Q4 A — composer with prompt, pre-submit");
p.write("\r");

const samples = [];
const start = Date.now();
let sawIdleAgain = false;
while (Date.now() - start < 90_000) {
  await sleep(200);
  const scr = p.screen();
  const lines = scr.split("\n").filter((l) => l.trim());
  // The activity region is whatever sits between the last transcript line and
  // the composer rule; capture the last 6 non-empty lines each tick.
  samples.push({ t: Date.now() - start, cursor: p.cursor(), tail: lines.slice(-6) });
  if (/for shortcuts/.test(scr) && Date.now() - start > 2500 && !/interrupt|esc to/i.test(scr)) {
    // Two consecutive idle-looking ticks ⇒ turn over.
    if (sawIdleAgain) break;
    sawIdleAgain = true;
  } else {
    sawIdleAgain = false;
  }
}
const activityRaw = p.raw.slice(submitMark);
cap.add(
  "Q4 B — sampled frames during the turn (200ms cadence, tail 6 lines)",
  samples.map((s) => `t=${String(s.t).padStart(6)}ms cur=(${s.cursor.x},${s.cursor.y})\n` + s.tail.map((l) => `    | ${l}`).join("\n")).join("\n"),
);

const GLYPHS = ["✢", "✳", "✶", "✻", "✽", "·"];
const HINTS = ["esc to interrupt", "esctointerrupt", "thinking with", "cerebrating", "accomplishing", "interrupt", "to interrupt", "ctrl+c"];
const clean = activityRaw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const compact = clean.toLowerCase().replace(/[^a-z0-9]+/g, "");
cap.add(
  "Q4 C — literal search over the turn's RAW stream",
  [
    ...GLYPHS.map((g) => `  glyph ${JSON.stringify(g)}: ${clean.includes(g) ? "PRESENT" : "absent"}  (count ${clean.split(g).length - 1})`),
    ...HINTS.map((h) => `  hint  ${JSON.stringify(h)}: raw=${clean.toLowerCase().includes(h) ? "PRESENT" : "absent"} compact=${compact.includes(h.replace(/[^a-z0-9]+/g, "")) ? "PRESENT" : "absent"}`),
  ].join("\n"),
);
cap.addRaw("Q4 D — RAW stream of the whole turn", activityRaw);
cap.frame(p, "Q4 E — composer after the turn settled");

// ── Q3b: Esc/Esc at idle, now WITH history ──────────────────────────────────
await sleep(1500);
for (const [label, gapMs] of [["50ms", 50], ["500ms", 500], ["1200ms", 1200], ["2500ms", 2500]]) {
  p.write(KEYS.esc);
  await sleep(gapMs);
  p.write(KEYS.esc);
  await sleep(1600);
  cap.frame(p, `Q3b — Esc, ${label}, Esc (with history)`, { attrs: true });
  p.write(KEYS.esc);
  await sleep(1200);
  cap.frame(p, `Q3b — dismiss after ${label} pair`);
}

cap.addRaw("RAW pty stream (whole session)", p.raw);
cap.save();
p.kill();
process.exit(0);
