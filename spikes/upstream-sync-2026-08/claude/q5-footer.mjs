// Q5 — idle composer footer at claude 2.1.220; byte-check of the readiness
// needle `idlePromptModelHints` (the "? for shortcuts" token).
// Also performs the ONE trust grant for the shared trusted scratch dir.
import fs from "node:fs";
import { Capture, bootTrusted, sleep } from "./driver.mjs";

const CWD = process.argv[2];
const OUT = process.argv[3];
fs.mkdirSync(CWD, { recursive: true });

const cap = new Capture(OUT, "Q5 — claude 2.1.220 idle composer footer (--permission-mode default)");
cap.add("cwd", CWD.replace(process.env.HOME, "$HOME"));

const p = await bootTrusted(CWD, cap);
cap.frame(p, "frame A — idle composer, ~2.5s after boot", { attrs: true });
await sleep(4000);
cap.frame(p, "frame B — idle composer, ~7s after boot", { attrs: true });

// Byte-level footer line extraction (exact codepoints, no normalization).
const lines = p.screen().split("\n");
const footer = lines.filter((l) => /shortcuts|agents|mode/i.test(l));
cap.add(
  "footer lines — byte view",
  footer
    .map((l) => `${JSON.stringify(l)}\n    codepoints: ${[...l].map((c) => (c.codePointAt(0) > 126 ? `U+${c.codePointAt(0).toString(16).toUpperCase()}` : c)).join("")}`)
    .join("\n"),
);

cap.addRaw("RAW pty stream (whole session)", p.raw);
cap.save();
p.kill();
process.exit(0);
