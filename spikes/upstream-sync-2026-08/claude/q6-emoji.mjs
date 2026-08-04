// Q6 (informs F4) — emoji autocomplete popup (2.1.217, `emojiCompletionEnabled`).
// (a) typed character-by-character, (b) delivered as a bracketed paste the way a
// GUI does, (c) the same two with Sonata's intended `emojiCompletionEnabled:false`
// injected via --settings, to confirm the kill-switch actually lands.
// Nothing is ever submitted — zero token cost.
import fs from "node:fs";
import path from "node:path";
import { Capture, bootTrusted, sleep } from "./driver.mjs";

const CWD = process.argv[2];
const OUT = process.argv[3];
const MODE = process.argv[4] ?? "default"; // "default" | "suppressed"
fs.mkdirSync(CWD, { recursive: true });

const cap = new Capture(OUT, `Q6 — claude 2.1.220 emoji completion popup (${MODE})`);

let extraArgs = [];
if (MODE === "suppressed") {
  const settingsPath = path.join(CWD, "emoji-off.settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ emojiCompletionEnabled: false }, null, 2));
  extraArgs = ["--settings", settingsPath];
  cap.add("injected --settings", fs.readFileSync(settingsPath, "utf8"));
}

const p = await bootTrusted(CWD, cap, { extraArgs });
cap.frame(p, "baseline — idle composer");

const TEXT = "I feel :hea";
const clear = async () => {
  p.write("\x7f".repeat(60));
  await sleep(900);
};

// (a) typed, character by character.
await p.type(TEXT, 90);
await sleep(1500);
cap.frame(p, "A — TYPED `I feel :hea` char-by-char", { attrs: true });
await p.type("r", 90);
await sleep(1200);
cap.frame(p, "A2 — one more char (`:hear`)", { attrs: true });
await clear();
cap.frame(p, "A3 — composer cleared");

// (b) bracketed paste, one write, the way a GUI paste arrives.
p.paste(TEXT);
await sleep(2000);
cap.frame(p, "B — PASTED `I feel :hea` (ESC[200~ … ESC[201~)", { attrs: true });

// (b2) paste, then type one more char — does the popup wake up mid-token?
await p.type("r", 90);
await sleep(1500);
cap.frame(p, "B2 — paste, then TYPE one more char (`:hear`)", { attrs: true });
await clear();

// (c) paste a longer body that merely CONTAINS a colon token, not at the end.
p.paste("fix the :hea header and then stop");
await sleep(2000);
cap.frame(p, "C — PASTED text with `:hea` mid-string", { attrs: true });
await clear();
cap.frame(p, "C2 — composer cleared (final)");

cap.addRaw("RAW pty stream (whole session)", p.raw);
cap.save();
p.kill();
process.exit(0);
