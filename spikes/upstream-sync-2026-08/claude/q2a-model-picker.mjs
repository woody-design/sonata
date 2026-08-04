// Q2a (F6) — `/model` picker frame at claude 2.1.220: rows, labels, highlight
// mechanism (cell attributes), terminal-cursor position per focused row
// (2.1.218 "panels now move the terminal cursor to the focused row"), footer.
// NO confirm here — the picker is dismissed with Esc, so this run writes nothing.
import fs from "node:fs";
import { Capture, bootTrusted, KEYS, sleep } from "./driver.mjs";

const CWD = process.argv[2];
const OUT = process.argv[3];
fs.mkdirSync(CWD, { recursive: true });

const cap = new Capture(OUT, "Q2a — claude 2.1.220 /model picker frames (no confirm)");
cap.add("cwd", CWD.replace(process.env.HOME, "$HOME"));

const p = await bootTrusted(CWD, cap);
cap.frame(p, "frame 0 — idle composer before /model");

await p.type("/model", 40);
await sleep(1200);
cap.frame(p, "frame 1 — after typing `/model` (slash-command menu state)", { attrs: true });

p.write(KEYS.enter);
await sleep(2000);
cap.frame(p, "frame 2 — picker as opened (Enter on `/model`)", { attrs: true });

for (const [i, key] of [KEYS.down, KEYS.down, KEYS.down, KEYS.up].entries()) {
  p.write(key);
  await sleep(700);
  cap.frame(p, `frame ${3 + i} — after ${key === KEYS.down ? "ArrowDown" : "ArrowUp"} #${i + 1}`, { attrs: true });
}

p.write(KEYS.esc);
await sleep(1500);
cap.frame(p, "frame 7 — after Esc (picker dismissed?)", { attrs: true });

cap.addRaw("RAW pty stream (whole session)", p.raw);
cap.save();
p.kill();
process.exit(0);
