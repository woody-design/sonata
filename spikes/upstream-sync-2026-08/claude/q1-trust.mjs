// Q1 (F5) — workspace-trust dialog wording at claude 2.1.220.
// Spawns claude in a FRESH (never-trusted) scratch dir, captures the dialog
// verbatim + cell attributes + terminal cursor, walks the rows, then answers
// the DECLINE row so no trust grant is created.
import fs from "node:fs";
import path from "node:path";
import { Probe, Capture, KEYS, sleep } from "./driver.mjs";

const SCRATCH = process.argv[2];
const OUT = process.argv[3];
fs.mkdirSync(SCRATCH, { recursive: true });
fs.writeFileSync(path.join(SCRATCH, "note.txt"), "probe scratch\n");

const cap = new Capture(OUT, "Q1 — claude 2.1.220 workspace-trust dialog (fresh untrusted dir)");
cap.add("cwd", SCRATCH.replace(process.env.HOME, "$HOME"));

const p = new Probe({ cwd: SCRATCH, rawPath: null });

const seen = await p.waitFor(/trust|safety|Do you (trust|want)/i, 45_000);
cap.add("waitFor trust-ish text", seen ? "MATCHED" : "TIMEOUT");
await sleep(1500);
cap.frame(p, "frame A — dialog as first rendered", { attrs: true });

// Row walk: does ↓ move the terminal cursor to the focused row (2.1.218)?
p.write(KEYS.down);
await sleep(600);
cap.frame(p, "frame B — after ArrowDown", { attrs: true });
p.write(KEYS.up);
await sleep(600);
cap.frame(p, "frame C — after ArrowUp (back to row 1)", { attrs: true });

// Decline: move to the last row and confirm. Captured frames above tell us what
// that row says; recorded verbatim either way.
p.write(KEYS.down);
await sleep(400);
cap.frame(p, "frame D — pre-confirm (focus on row 2)", { attrs: true });
p.write(KEYS.enter);
await sleep(2500);
cap.frame(p, "frame E — after confirming row 2", { attrs: true });
cap.add("exited?", `${p.exited} ${JSON.stringify(p.exitInfo)}`);

cap.addRaw("RAW pty stream (whole session)", p.raw);
cap.save();
p.kill();
process.exit(0);
