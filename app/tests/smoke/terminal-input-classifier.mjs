import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Regression guard for the terminal input classifier (fix 057eea6): it
// categorically excludes mouse + device-reply traffic from "the human is
// typing" (claude 2.1.191's animated TUI emits these constantly; counting them
// as typing wedged delivery on "Queued"), while still recognizing genuine
// keystrokes/paste. Post-send-is-send this no longer gates delivery — it only
// gates the native-approval reconciliation pass — but the classifier's
// correctness still matters, so the guard stays.
const require = createRequire(import.meta.url);
const { isNonTypingTerminalInput } = require("../../dist/runtime");

const E = "\x1b";
const BEL = "\x07";
const ST = "\x1b\\";

// --- 1. Non-typing traffic (mouse + device replies) → excluded ---------------
const nonTyping = {
  "SGR mouse motion": `${E}[<35;72;6M`,
  "SGR scroll wheel": `${E}[<65;72;6M`,
  "SGR mouse release": `${E}[<35;74;5m`,
  "X10 mouse": `${E}[M${String.fromCharCode(35, 72, 54)}`,
  "CPR": `${E}[24;80R`,
  "CPR ?-prefixed (DECXCPR)": `${E}[?49;3R`,
  "DA1": `${E}[?1;2c`,
  "DA2": `${E}[>0;276;0c`,
  "DECRQM report": `${E}[?2026;2$y`,
  "kitty flags reply": `${E}[?1u`,
  "OSC color (BEL)": `${E}]11;rgb:1e1e/1d1d/1a1a${BEL}`,
  "OSC color (ST)": `${E}]10;rgb:e8e8/e3e3/d9d9${ST}`,
  "DCS (XTVERSION)": `${E}P>|xterm.js(6.0.0)${ST}`,
  "focus in": `${E}[I`,
  "focus out": `${E}[O`,
  // A redraw can batch several reports/mouse events into one onData chunk —
  // must still classify as non-typing (else one bumps the typing window).
  "batched mouse+OSC+CPR": `${E}[<35;72;6M${E}]11;rgb:1/2/3${BEL}${E}[24;80R`,
};
for (const [name, seq] of Object.entries(nonTyping)) {
  assert.equal(isNonTypingTerminalInput(seq), true, `non-typing: ${name}`);
}

// --- 2. Genuine human input → NOT excluded (must register as typing) ---------
const typing = {
  "printable char": "h",
  "word": "hello",
  "Enter": "\r",
  "Ctrl-C": "\x03",
  "arrow up": `${E}[A`,
  "Home": `${E}[H`,
  "Delete": `${E}[3~`,
  "kitty key PRESS (no ?)": `${E}[97;2u`,
  "bracketed paste payload": `${E}[200~hello${E}[201~`,
  "mouse report + real keystroke": `${E}[<35;72;6Mx`,
};
for (const [name, seq] of Object.entries(typing)) {
  assert.equal(isNonTypingTerminalInput(seq), false, `typing: ${name}`);
}
assert.equal(isNonTypingTerminalInput(""), false, "empty chunk is not non-typing");

console.log(JSON.stringify({ smoke: "terminal-input-classifier", success: true }, null, 2));
