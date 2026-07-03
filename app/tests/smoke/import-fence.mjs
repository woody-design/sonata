import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Machine fence for import direction (decomposition map §2.4). Layer rules
// are data; the walker asserts every static import/export-from specifier
// obeys its layer's allowlist. The D1 packet extends RULES with the renderer
// view/flows layers + an acyclicity check; the shape below anticipates that.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

// path prefix (relative to src/) → allowed resolved-target prefixes.
// Relative imports are resolved against the importing file, package imports
// are rejected unless allowlisted by name.
const RULES = [
  {
    layer: "reading-core/",
    allowedPrefixes: ["reading-core/", "shared/"],
    allowedPackages: [],
  },
];

function tsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// Three specifier sources (review 2026-07-03: the from-only regex missed
// side-effect and dynamic imports): `import ... from "x"` / `export ... from
// "x"`, bare `import "x"`, and `import("x")` / `require("x")` calls.
// Comments are stripped first so commented-out imports can't false-positive.
const FROM_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
const DYNAMIC_RE = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function* specifiersIn(source) {
  const stripped = stripComments(source);
  for (const re of [FROM_RE, SIDE_EFFECT_RE, DYNAMIC_RE]) {
    for (const match of stripped.matchAll(re)) {
      yield match[1];
    }
  }
}

const violations = [];
for (const rule of RULES) {
  const layerDir = join(SRC, rule.layer);
  for (const file of tsFilesUnder(layerDir)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of specifiersIn(source)) {
      if (!specifier.startsWith(".")) {
        if (!rule.allowedPackages.includes(specifier)) {
          violations.push(`${file}: package import "${specifier}" not allowed in ${rule.layer}`);
        }
        continue;
      }
      const target = resolve(dirname(file), specifier);
      const relative = target.startsWith(SRC + sep) ? target.slice(SRC.length + 1) : target;
      const ok = rule.allowedPrefixes.some((prefix) =>
        (relative + sep).startsWith(prefix.replaceAll("/", sep)),
      );
      if (!ok) {
        violations.push(`${file}: "${specifier}" resolves outside ${rule.allowedPrefixes.join(", ")}`);
      }
    }
  }
}

assert.deepEqual(violations, [], `import-fence violations:\n${violations.join("\n")}`);
console.log(`import-fence: ${RULES.length} layer rule(s) hold`);
