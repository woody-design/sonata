// Q30 companion — the byte-level verdict on Sonata's shared 1x1 PNG test
// fixture, with no CLI, no network and no model turn in the loop.
//
// `redPngBytes()` (app/tests/smoke/native-image-attachments.mjs:471-476, and
// copy-pasted verbatim into five e2e files) is NOT a valid PNG. Its IDAT chunk
// header declares length 0x0b for a 12-byte zlib stream, so:
//
//   * the deflate stream is truncated one byte short of its Adler-32 trailer,
//   * the 4 bytes read as the IDAT CRC are actually the stream's last byte plus
//     the first three CRC bytes, so the CRC check fails,
//   * the next chunk header is read one byte early, so IEND is unparseable.
//
// `file(1)` and macOS `sips` still report "PNG image data, 1 x 1" because they
// only parse IHDR. Any real decoder — including the Rust `image` crate that
// codex-cli uses — rejects it, and codex then substitutes
// "image content omitted because it could not be processed"
// (codex-rs/core/src/image_preparation.rs:26-27, 95, 211-217).
//
// Flipping that one byte to 0x0c produces a PNG that inflates cleanly and that
// codex accepts (measured in q30-image-ab.capture.txt, both spawn arms).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { sanitize, writeCapture } from "./driver.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;

/** app/tests/smoke/native-image-attachments.mjs:471-476, verbatim. */
const SMOKE_RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function walk(bytes) {
  const chunks = [];
  let i = 8;
  while (i + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(i);
    const type = bytes.subarray(i + 4, i + 8).toString("latin1");
    const end = i + 8 + length;
    if (end + 4 > bytes.length) {
      chunks.push({ type, length, verdict: `TRUNCATED (needs ${end + 4} bytes, file has ${bytes.length})` });
      break;
    }
    const stored = bytes.readUInt32BE(end);
    const computed = crc32(bytes.subarray(i + 4, end));
    const entry = {
      type,
      length,
      storedCrc: stored.toString(16).padStart(8, "0"),
      computedCrc: computed.toString(16).padStart(8, "0"),
      verdict: stored === computed ? "CRC OK" : "**CRC MISMATCH**",
    };
    if (type === "IHDR") {
      entry.width = bytes.readUInt32BE(i + 8);
      entry.height = bytes.readUInt32BE(i + 12);
      entry.bitDepth = bytes[i + 16];
      entry.colorType = bytes[i + 17];
    }
    if (type === "IDAT") {
      try {
        entry.inflate = `OK -> ${zlib.inflateSync(bytes.subarray(i + 8, end)).toString("hex")}`;
      } catch (error) {
        entry.inflate = `**FAIL** ${String(error?.message ?? error)}`;
      }
    }
    chunks.push(entry);
    i = end + 4;
  }
  return chunks;
}

const corrupt = Buffer.from(SMOKE_RED_PNG_B64, "base64");
const repaired = Buffer.from(corrupt);
repaired[36] = 0x0c; // IDAT length low byte: 0x0b -> 0x0c

const diff = [];
for (let i = 0; i < corrupt.length; i += 1) {
  if (corrupt[i] !== repaired[i]) {
    diff.push({ offset: i, corrupt: corrupt[i], repaired: repaired[i] });
  }
}

// Every file in the tree that carries the same corrupt literal.
const carriers = [];
const scan = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(full);
    else if (/\.(mjs|js|ts|tsx)$/.test(entry.name)) {
      if (fs.readFileSync(full, "utf8").includes("AAAAC0lEQVR4nGP4z8AAAAMBAQDJ/pLv")) {
        carriers.push(path.relative(APP_DIR, full));
      }
    }
  }
};
scan(APP_DIR);

const out = {
  probe: "q30-image-fixture",
  fixtureBase64: SMOKE_RED_PNG_B64,
  bytes: corrupt.length,
  corruptHex: corrupt.toString("hex"),
  repairedHex: repaired.toString("hex"),
  singleByteDiff: diff,
  repairedBase64: repaired.toString("base64"),
  corruptChunks: walk(corrupt),
  repairedChunks: walk(repaired),
  carriersUnderApp: carriers.sort(),
};

console.log(sanitize(JSON.stringify(out, null, 2)));
console.log("\ncapture:", writeCapture(OUT_DIR, "q30-image-fixture.capture.txt", out));
