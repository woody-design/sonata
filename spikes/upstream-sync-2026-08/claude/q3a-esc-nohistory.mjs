// Q3a (F7) — double-ESC at an idle composer with NO conversation history.
// 2.1.216 changelog: "Esc-Esc at idle now opens the rewind picker".
// Sonata's screen-blind rollback Escs (control-switch-engine.ts:1869/1979/2032/
// 2051) can land on an idle composer, so this measures what a bare Esc pair does.
import fs from "node:fs";
import { Capture, bootTrusted, KEYS, sleep } from "./driver.mjs";

const CWD = process.argv[2];
const OUT = process.argv[3];
fs.mkdirSync(CWD, { recursive: true });

const cap = new Capture(OUT, "Q3a — claude 2.1.220 Esc/Esc at idle, NO history");
cap.add("cwd", CWD.replace(process.env.HOME, "$HOME"));

const p = await bootTrusted(CWD, cap);
cap.frame(p, "baseline — idle composer");

// Single Esc.
p.write(KEYS.esc);
await sleep(900);
cap.frame(p, "A — single Esc");

// Esc pair, 50ms apart (Sonata's ESC.repeat() writes them in ONE pty write —
// tighter than 50ms; both forms are measured).
p.write(KEYS.esc);
await sleep(50);
p.write(KEYS.esc);
await sleep(1500);
cap.frame(p, "B — Esc, 50ms, Esc", { attrs: true });

p.write(KEYS.esc);
await sleep(1200);
cap.frame(p, "B-dismiss — one Esc after the pair");

// Esc pair delivered as a SINGLE write (exactly `ESC.repeat(2)`).
p.write(KEYS.esc + KEYS.esc);
await sleep(1500);
cap.frame(p, "C — `\\x1b\\x1b` in one write (ESC.repeat(2) shape)", { attrs: true });

p.write(KEYS.esc);
await sleep(1200);
cap.frame(p, "C-dismiss — one Esc after the pair");

// Esc pair, 500ms apart.
p.write(KEYS.esc);
await sleep(500);
p.write(KEYS.esc);
await sleep(1500);
cap.frame(p, "D — Esc, 500ms, Esc", { attrs: true });

p.write(KEYS.esc);
await sleep(1200);
cap.frame(p, "D-dismiss — one Esc after the pair");

cap.addRaw("RAW pty stream (whole session)", p.raw);
cap.save();
p.kill();
process.exit(0);
