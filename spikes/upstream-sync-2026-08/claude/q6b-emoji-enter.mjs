// Q6b (F4 severity) — with the emoji popup OPEN, does the submit key select an
// emoji instead of submitting? Sonata's prompt path is bracketed paste followed
// by CSI-u Enter (`\x1b[13u`, terminal-host.ts:63). Both submit encodings are
// measured. Worst case burns one trivial turn.
import fs from "node:fs";
import { Capture, bootTrusted, sleep } from "./driver.mjs";

const CWD = process.argv[2];
const OUT = process.argv[3];
fs.mkdirSync(CWD, { recursive: true });

const CSI_U_ENTER = "\x1b[13u";
const cap = new Capture(OUT, "Q6b — claude 2.1.220 submit key while the emoji popup is open");
const p = await bootTrusted(CWD, cap);

// Leg 1 — CSI-u Enter (Sonata's paste-path submit byte).
p.paste("say ok :hea");
await sleep(2000);
cap.frame(p, "1a — pasted `say ok :hea`, popup state", { attrs: true });
p.write(CSI_U_ENTER);
await sleep(3000);
cap.frame(p, "1b — after CSI-u Enter (\\x1b[13u)", { attrs: true });

// Leg 2 — raw CR, from whatever state leg 1 left behind.
await sleep(2000);
cap.frame(p, "2a — settled state before raw CR leg");
p.write("\x7f".repeat(60));
await sleep(800);
p.paste("say ok :hea");
await sleep(2000);
cap.frame(p, "2b — pasted again, popup state", { attrs: true });
p.write("\r");
await sleep(3000);
cap.frame(p, "2c — after raw CR", { attrs: true });

await sleep(20_000);
cap.frame(p, "3 — final state (any turn allowed to finish)");

cap.addRaw("RAW pty stream (whole session)", p.raw);
cap.save();
p.kill();
process.exit(0);
