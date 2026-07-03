import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

// Governance fence for the pinned runtime-event corpus (review 2026-07-03
// P1): pinned fixtures must never carry account/environment data. This lint
// is what makes the sanitizer's guarantees durable — a future re-pin that
// skips sanitization fails here, not in a repo audit.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/runtime-events");
const HOME = os.homedir();
const USER = process.env.USER ?? "";

const FORBIDDEN = [
  { name: "email (non-placeholder)", re: /[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "real home path", re: new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) },
  ...(USER && USER !== "user"
    ? [{ name: "real username path", re: new RegExp(`/Users/${USER}\\b`) }]
    : []),
  { name: "claude.ai session url", re: /https:\/\/claude\.ai\/(?!REDACTED)[A-Za-z0-9/_-]+/ },
  { name: "secret-like token", re: /\bsk-(?!REDACTED)[A-Za-z0-9-]{10,}/ },
];

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...filesUnder(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

const files = filesUnder(ROOT);
assert.ok(files.length > 0, "pinned corpus exists");

const hits = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const { name, re } of FORBIDDEN) {
    const match = text.match(re);
    if (match) {
      hits.push(`${file}: ${name} → ${JSON.stringify(match[0].slice(0, 60))}`);
    }
  }
}

assert.deepEqual(hits, [], `corpus-lint violations:\n${hits.join("\n")}`);
console.log(`corpus-lint: ${files.length} pinned file(s) clean`);
