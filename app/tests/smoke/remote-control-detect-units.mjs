// Unit tests for Remote Control detection (tui-parsers-claude.ts:
// compactRemoteControlScan / hasRemoteControlDisconnect /
// findRemoteControlUrlOnScreen), pinned per CHANNEL.
//
// The two signals ride different channels because they are different kinds of
// thing, and each channel is pinned against the failure that put it there:
//
//   OFF  → the raw pty STREAM. Regression guard for Woody's stale-button bug
//          (2026-06-28): claude word-POSITIONS the disconnect line with cursor
//          moves instead of spaces, and the one-shot line can split across PTY
//          reads (between printables OR inside an escape) — the detector must
//          catch all of these, and must NOT trip on the footer / panel option /
//          slash menu / lowercase prose / a connect banner.
//   URL  → the reconstructed SCREEN. Regression guard for the 2.1.258 failure
//          (SL-11, probe rc5): the differential repaint does not re-emit
//          characters already correct on the grid, so `https://` never enters
//          the stream as a unit and the old stream reader went intermittently
//          blind — which is what left `remote-control-disconnect.mjs` red.
//
// The two MEASURED fixtures are verbatim pty windows from live 2.1.258 sessions
// and are what makes the channel split falsifiable rather than asserted: the
// same bytes are pushed down both channels, and the assertions pin which one
// can answer.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  compactRemoteControlScan,
  hasRemoteControlDisconnect,
  findRemoteControlUrlOnScreen,
  normalizeTerminalDimensions,
  REMOTE_CONTROL_SCAN_LIMIT,
} = require("../../dist/runtime");
const { TaskScreenModel } = require("../../dist/runtime/terminal-host/task-screen-model");

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
const readFixture = (relative) => fs.readFileSync(path.join(FIXTURES, relative), "utf8");

const E = "\x1b";
// The geometry the windows below were captured at (rc5 ran the production
// TerminalHost shape); laying them out at a different size would measure this
// test's arithmetic, not claude's paint.
const DIMENSIONS = normalizeTerminalDimensions(120, 36);

// ── OFF: the STREAM channel ─────────────────────────────────────────────────

// Mirror detectRemoteControlState's rolling RAW tail: accumulate raw, then
// compact the whole tail per chunk (so a split escape reassembles before strip).
function feedOff(chunks) {
  let scan = "";
  let off = false;
  for (const chunk of chunks) {
    scan = (scan + chunk).slice(-REMOTE_CONTROL_SCAN_LIMIT);
    off = hasRemoteControlDisconnect(compactRemoteControlScan(scan)) || off;
  }
  return off;
}

const offPositive = {
  "plainly spaced (fresh session)": ["⎿  Remote Control disconnected."],
  "word-positioned (cursor moves, no spaces)": [`Remote${E}[9GControl${E}[17Gdisconnected.`],
  "split between printables": ["Remote Control", " disconnected."],
  "split INSIDE an escape sequence": [`Remote Control${E}[1`, "6Gdisconnected."],
};
for (const [name, chunks] of Object.entries(offPositive)) {
  assert.equal(feedOff(chunks), true, `OFF positive: ${name}`);
}

const offNegative = {
  "footer active marker": ["/remote-control is active · Continue here, on your phone · /rc active"],
  "panel option 'Disconnect this session'": [`     Disconnect this session${E}[K`],
  "slash menu 'Disconnect Remote Control'": ["/remote-control   Disconnect Remote Control"],
  "lowercase model prose": ["the remote control disconnected briefly during the call"],
  "the connect URL line (not a disconnect)": ["…or at https://claude.ai/code/session_01ABCdef"],
};
for (const [name, chunks] of Object.entries(offNegative)) {
  assert.equal(feedOff(chunks), false, `OFF negative: ${name}`);
}

// MEASURED (claude 2.1.258, probe rc3 arm B): the real pty window produced by
// answering "Disconnect this session" in claude's own RC panel. It contains the
// panel's own option rows too, so one fixture pins the positive AND the two
// nearest negatives in the shape they actually arrive in.
const DISCONNECT_WINDOW = readFixture("claude-remote-control/panel-disconnect-2.1.258.txt");
assert.equal(
  feedOff([DISCONNECT_WINDOW]),
  true,
  "OFF positive: the MEASURED 2.1.258 panel-disconnect window",
);
// Chunked at every byte: the production detector never sees the window whole.
assert.equal(
  feedOff([...DISCONNECT_WINDOW]),
  true,
  "OFF positive: the MEASURED window still fires when split byte-by-byte",
);
// The panel BEFORE the confirmation — same window, truncated at the last byte
// before the receipt line — must stay silent. This is the discrimination the
// glued form buys: "Disconnect this session" is one word away from a match.
const beforeReceipt = DISCONNECT_WINDOW.slice(0, DISCONNECT_WINDOW.indexOf("Remote Control disc"));
assert.ok(beforeReceipt.includes("Disconnect this session"), "the truncated window still holds the panel");
assert.equal(
  feedOff([beforeReceipt]),
  false,
  "OFF negative: the MEASURED panel, up to the moment before the receipt",
);

// ── URL: the SCREEN channel ─────────────────────────────────────────────────

/** Lay bytes out on a real TaskScreenModel and read the viewport back — the
 *  exact shape detectRemoteControlState hands the parser in production. */
async function renderScreen(bytes) {
  const model = new TaskScreenModel(DIMENSIONS);
  model.write(bytes);
  await new Promise((resolve) => model.whenSettled(resolve));
  const text = model.viewportText();
  model.dispose();
  return text;
}

/** What the RETIRED stream reader would have made of the same bytes: strip
 *  escapes, keep whitespace, match. Kept here — and only here — so the reason
 *  the channel moved is pinned as an executable fact rather than a comment. */
function streamReaderVerdict(raw) {
  return (
    raw
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .match(/https:\/\/claude\.(?:ai|com)\/code\/session_[A-Za-z0-9_-]+/)?.[0] ?? null
  );
}

// MEASURED (claude 2.1.258, probe rc5 leg "immediate"): the RC panel repainted
// over a boot that was still settling its own auto-connect. claude emits
// `at https:` then a column jump then `/claude.ai/…` — the second slash is
// never sent, because the grid already had it.
const SPLIT_WINDOW = readFixture("claude-remote-control/panel-split-url-repaint-2.1.258.txt");

assert.equal(
  streamReaderVerdict(SPLIT_WINDOW),
  null,
  "URL: the retired STREAM reader finds nothing in the MEASURED split repaint — this is why the channel moved",
);
assert.match(
  SPLIT_WINDOW.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""),
  /https:\/claude\.ai\/code\/session_/,
  "URL: and the reason is structural — one slash reaches the stream, not two",
);
const splitScreen = await renderScreen(SPLIT_WINDOW);
assert.equal(
  findRemoteControlUrlOnScreen(splitScreen),
  "https://claude.ai/code/session_REDACTEDprobeFixture0001",
  "URL: the SCREEN channel reads the same bytes whole",
);

// Contiguous forms, MEASURED at 2.1.258 (rc1/rc3/rc5/rc6) as they land on the
// grid: the native panel (link on the SAME line) and the boot / re-connect
// banner (link on the NEXT line). These two are the entire link-bearing
// vocabulary the probes rendered — grepped across every capture, not sampled.
const LINK = "https://claude.ai/code/session_01G6S9mxyfB4e6EBf4M1F8xo";
const PANEL_LINE = `   This session is available in the Claude mobile app and at ${LINK}.`;
const BANNER =
  "  /remote-control is active · Continue here, on your phone, or at \n" + `  ${LINK}`;
const gridForms = {
  "native RC panel line (same line)": [PANEL_LINE, LINK],
  "boot / re-connect banner (next line)": [BANNER, LINK],
  "claude.com variant": [
    "This session is available in the Claude mobile app and at https://claude.com/code/session_01XYZ next",
    "https://claude.com/code/session_01XYZ",
  ],
  // The id char class includes `-`/`_` so a hyphenated/base64url id is never
  // truncated, and the match stops at the punctuation that follows it.
  "hyphen/underscore id": [
    "Continue here, on your phone, or at https://claude.ai/code/session_aB3-9x_Qz.",
    "https://claude.ai/code/session_aB3-9x_Qz",
  ],
  // The screen arrives as raw viewport text; a stray styling escape must not
  // break the match (cleanTerminal is the parser's first move).
  "styling escapes around the link": [
    `available in the Claude mobile app and at ${E}[39m${LINK}${E}[0m.`,
    LINK,
  ],
};
for (const [name, [text, expected]] of Object.entries(gridForms)) {
  assert.equal(findRemoteControlUrlOnScreen(text), expected, `URL grid form: ${name}`);
}

// ── URL: the anchor is a FENCE, not decoration ──────────────────────────────
// Moving this read to the grid widened what it can see: the retired stream scan
// was cleared on activation and so could only ever see post-activation bytes,
// while a viewport read sees the WHOLE screen at that instant — and the value
// LATCHES for the connection, so one wrong read never self-corrects. These pin
// that the sentence anchor is what closes the gap. A regression here means the
// popover would hand the user someone else's session link.
const FOREIGN = "https://claude.ai/code/session_01FOREIGNlinkNotOurs00";

assert.equal(
  findRemoteControlUrlOnScreen(`some earlier output quoting ${FOREIGN} in passing`),
  null,
  "anchor: a bare link with no RC sentence around it is IGNORED",
);
// The panel paints LOW (rows 33–39 of 40), so anything the transcript already
// held is ABOVE it — first-match on the bare shape would have taken the wrong one.
assert.equal(
  findRemoteControlUrlOnScreen([`> here is a link I pasted: ${FOREIGN}`, "", PANEL_LINE].join("\n")),
  LINK,
  "anchor: a foreign link ABOVE the panel does not win",
);
// …and the composer sits BELOW the panel, so a last-match rule would have lost
// to a pasted one. Neither ordering rule works; only the context does.
assert.equal(
  findRemoteControlUrlOnScreen([PANEL_LINE, "", `❯ ${FOREIGN}`].join("\n")),
  LINK,
  "anchor: a foreign link BELOW the panel (in the composer) does not win",
);
assert.equal(
  findRemoteControlUrlOnScreen([`> ${FOREIGN}`, "", BANNER].join("\n")),
  LINK,
  "anchor: same, for the banner form",
);
// The residual, pinned as KNOWN and accepted rather than hidden: a model that
// reproduces claude's own sentence verbatim and follows it with a link is
// indistinguishable from claude saying it. A failure here means the boundary
// IMPROVED — delete the assertion rather than "fix" the code.
assert.equal(
  findRemoteControlUrlOnScreen(`The CLI printed "available in the Claude mobile app and at ${FOREIGN}"`),
  FOREIGN,
  "anchor: KNOWN residual — a verbatim quotation of claude's own sentence still wins",
);
assert.equal(
  findRemoteControlUrlOnScreen("just streaming text about TCP, no link here"),
  null,
  "URL: absent → null",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      offPositive: Object.keys(offPositive).length + 2,
      offNegative: Object.keys(offNegative).length + 1,
      urlGridForms: Object.keys(gridForms).length,
      urlAnchorFences: 6,
      measuredWindows: ["panel-disconnect-2.1.258", "panel-split-url-repaint-2.1.258"],
      scanLimit: REMOTE_CONTROL_SCAN_LIMIT,
    },
    null,
    2,
  ),
);
