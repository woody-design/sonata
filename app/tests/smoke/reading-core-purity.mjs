import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The reading-core layer must load in plain node — no DOM, no Electron, no
// renderer globals. Requiring every built module IS the proof: a stray
// `document`/`window`/`require("electron")` fails right here. (The compile
// fence — tsconfig.main has no DOM lib — catches types; this catches runtime.)
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../../dist/reading-core");

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...jsFilesUnder(full));
    } else if (entry.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const files = jsFilesUnder(root);
assert.ok(files.length > 0, "dist/reading-core contains built modules");

for (const file of files) {
  const mod = require(file);
  assert.equal(typeof mod, "object", `${file} loads in plain node`);
}

console.log(`reading-core purity: ${files.length} module(s) load in plain node`);
