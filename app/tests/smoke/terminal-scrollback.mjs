import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Require the specific module (not the terminal-host index) so this stays a
// pure-JS smoke test — no node-pty, runnable under plain node.
const { TerminalScrollback } = require("../../dist/runtime/terminal-host/terminal-scrollback");

const failures = [];
const check = (name, cond, detail) => {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

const results = {};

// 1) A fresh mirror sized to a typical PTY.
const mirror = new TerminalScrollback(120, 36);

// 2) Representative CLI output: a colored header, plain lines, CJK, a cursor-
//    positioned redraw (as claude/codex draw), and a final unique marker.
mirror.write("\x1b[32mDUET_SCROLLBACK header\x1b[0m\r\n");
for (let i = 0; i < 5; i += 1) {
  mirror.write(`line ${i} — plain output\r\n`);
}
mirror.write("CJK: 你好世界终端 ✅\r\n");
mirror.write("\x1b[2K\rredrawn status\r\n");
mirror.write("LAST_LINE_MARKER_XYZ\r\n");

const snap = await mirror.snapshot();
results.snapshotDims = { cols: snap.cols, rows: snap.rows };

check("content", snap.data.includes("DUET_SCROLLBACK header"), "header missing");
check("color-sgr", /\x1b\[3(1|2)m/.test(snap.data), "no SGR color sequence preserved");
check("cjk", snap.data.includes("你好世界终端"), "CJK glyphs missing");
// The final write must appear — this proves snapshot() flushes pending writes
// before serializing (xterm parses writes asynchronously).
check("flush", snap.data.includes("LAST_LINE_MARKER_XYZ"), "last write not flushed into snapshot");

// 3) Resize is reflected (mirror tracks the PTY geometry).
mirror.resize(100, 40);
const resized = await mirror.snapshot();
results.resizedDims = { cols: resized.cols, rows: resized.rows };
check("resize", resized.cols === 100 && resized.rows === 40, `got ${resized.cols}x${resized.rows}`);

// 4) Bounded scrollback: overflow the cap, confirm it stays sane and cheap.
for (let i = 0; i < 3000; i += 1) {
  mirror.write(`bulk line ${i} filler filler filler\r\n`);
}
mirror.write("TAIL_MARKER_END\r\n");
const t0 = process.hrtime.bigint();
const big = await mirror.snapshot();
const serializeMs = Number(process.hrtime.bigint() - t0) / 1e6;
results.serializeMs = Math.round(serializeMs * 100) / 100;
const lineCount = big.data.split("\n").length;
results.snapshotLineCount = lineCount;

check("tail-present", big.data.includes("TAIL_MARKER_END"), "recent tail missing after overflow");
check("bounded", lineCount <= 1200, `snapshot has ${lineCount} lines, expected bounded ~1000`);
check("earliest-dropped", !big.data.includes("bulk line 0 "), "oldest overflowed line should have been dropped");
check("serialize-cost", serializeMs < 100, `serialize took ${results.serializeMs}ms`);

mirror.dispose();

results.success = failures.length === 0;
results.failures = failures;
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.success ? 0 : 1;
