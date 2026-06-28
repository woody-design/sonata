// Pure unit tests for the Remote Control stream detection (terminal-host.ts:
// compactRemoteControlScan / hasRemoteControlDisconnect / findRemoteControlUrl).
// Regression guard for Woody's stale-button bug (2026-06-28): claude word-
// POSITIONS the disconnect line with cursor moves instead of spaces, and the
// one-shot line can split across PTY reads (between printables OR inside an
// escape) — the detector must catch all of these, and must NOT trip on the
// footer / panel option / slash menu / lowercase prose / the connect URL line.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  compactRemoteControlScan,
  hasRemoteControlDisconnect,
  findRemoteControlUrl,
  REMOTE_CONTROL_SCAN_LIMIT,
} = require("../../dist/runtime");

const E = "\x1b";

// Mirror detectRemoteControlState's rolling RAW tail: accumulate raw, then
// compact the whole tail per chunk (so a split escape reassembles before strip).
function makeDetector() {
  let scan = "";
  return (chunk) => {
    scan = (scan + chunk).slice(-REMOTE_CONTROL_SCAN_LIMIT);
    // OFF matches the fully-compacted tail; URL matches the raw tail (escapes
    // stripped, whitespace kept) — exactly as detectRemoteControlState does.
    return {
      off: hasRemoteControlDisconnect(compactRemoteControlScan(scan)),
      url: findRemoteControlUrl(scan),
    };
  };
}
function feedOff(chunks) {
  const d = makeDetector();
  let off = false;
  for (const c of chunks) off = d(c).off || off;
  return off;
}

// --- OFF positive: every render claude can produce for "Remote Control disconnected." ---
const offPositive = {
  "plainly spaced (fresh session)": ["⎿  Remote Control disconnected."],
  "word-positioned (cursor moves, no spaces)": [`Remote${E}[9GControl${E}[17Gdisconnected.`],
  "split between printables": ["Remote Control", " disconnected."],
  "split INSIDE an escape sequence": [`Remote Control${E}[1`, "6Gdisconnected."],
};
for (const [name, chunks] of Object.entries(offPositive)) {
  assert.equal(feedOff(chunks), true, `OFF positive: ${name}`);
}

// --- OFF negative: must NOT trip ---
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

// --- URL capture ---
assert.equal(
  makeDetector()(
    "Continue here, on your phone, or at https://claude.ai/code/session_01G6S9mxyfB4e6EBf4M1F8xo ⏺ /rc active",
  ).url,
  "https://claude.ai/code/session_01G6S9mxyfB4e6EBf4M1F8xo",
  "URL: alphanumeric id captured fully (stops at the trailing glyph)",
);
assert.equal(
  makeDetector()("…at https://claude.ai/code/session_aB3-9x_Qz.").url,
  "https://claude.ai/code/session_aB3-9x_Qz",
  "URL: hyphen/underscore id NOT truncated; stops at the period",
);
assert.equal(
  makeDetector()("https://claude.com/code/session_01XYZ next").url,
  "https://claude.com/code/session_01XYZ",
  "URL: claude.com variant matched",
);
assert.equal(
  makeDetector()("just streaming text about TCP, no link here").url,
  null,
  "URL: absent → null",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      offPositive: Object.keys(offPositive).length,
      offNegative: Object.keys(offNegative).length,
      urlCases: 4,
      scanLimit: REMOTE_CONTROL_SCAN_LIMIT,
    },
    null,
    2,
  ),
);
