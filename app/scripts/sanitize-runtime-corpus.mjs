// Sanitize a raw runtime-event capture before pinning it as fixtures
// (decomposition program, review 2026-07-03 P1). Captures are verbatim
// reality and therefore carry account/environment data: emails, home paths,
// Claude config/transcript paths, session URLs and ids, TUI greeting lines.
// The reducer fixtures need event STRUCTURE and state-driving fields, not
// the operator's identity — so replacements are stable, shape-preserving
// strings applied to EVERY string field, pty:data bytes included (ANSI
// framing survives; only the sensitive substrings are swapped).
//
// Usage: node scripts/sanitize-runtime-corpus.mjs <raw-dir> <out-dir>
// Deterministic: same input → same output (review the diff on re-pin).
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const [rawDir, outDir] = process.argv.slice(2);
if (!rawDir || !outDir) {
  console.error("usage: node scripts/sanitize-runtime-corpus.mjs <raw-dir> <out-dir>");
  process.exit(1);
}

const HOME = os.homedir();
const USER = process.env.USER ?? "user";

// Order matters: longer/more specific patterns first.
const REPLACEMENTS = [
  // account identity
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com"],
  [/Welcome back,?\s+\S+/g, "Welcome back User"],
  // claude session/share URLs and long opaque ids
  [/https:\/\/claude\.ai\/[A-Za-z0-9/_-]+/g, "https://claude.ai/REDACTED"],
  [/\bsk-[A-Za-z0-9-]{10,}/g, "sk-REDACTED"],
  // home-anchored paths (keep structure: tests rely on path SHAPE, not owner)
  [new RegExp(escapeRe(`${HOME}/.claude`), "g"), "/Users/user/.claude"],
  [new RegExp(escapeRe(`${HOME}/.duet`), "g"), "/Users/user/.duet"],
  [new RegExp(escapeRe(HOME), "g"), "/Users/user"],
  [new RegExp(`/Users/${escapeRe(USER)}\\b`, "g"), "/Users/user"],
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeString(value) {
  let out = value;
  for (const [re, sub] of REPLACEMENTS) {
    out = out.replace(re, sub);
  }
  return out;
}

function sanitizeValue(value) {
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeValue(v);
    }
    return out;
  }
  return value;
}

let files = 0;
let lines = 0;
function walk(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dst, entry);
    if (statSync(from).isDirectory()) {
      walk(from, to);
    } else if (entry.endsWith(".jsonl")) {
      const out = [];
      for (const line of readFileSync(from, "utf8").split("\n")) {
        if (!line.trim()) continue;
        out.push(JSON.stringify(sanitizeValue(JSON.parse(line))));
        lines++;
      }
      writeFileSync(to, out.join("\n") + "\n");
      files++;
    } else {
      writeFileSync(to, sanitizeString(readFileSync(from, "utf8")));
      files++;
    }
  }
}

walk(rawDir, outDir);
console.log(`sanitized ${files} file(s), ${lines} event line(s) → ${outDir}`);
