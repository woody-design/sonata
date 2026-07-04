import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Machine fence for import direction (decomposition map §2.4, extended to the
// D1 full form §2.5/§3.2): layer rules are data; the walker asserts every
// static import/export-from/side-effect/dynamic specifier obeys its layer's
// allowlist, that NOTHING imports renderer/main.ts (it is the composition
// root), and that the renderer + reading-core module graph is acyclic (vite
// tolerates ESM cycles silently — the seam rules get a machine, not a
// promise).
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

// Most-specific (longest) matching rule wins. A file with no matching rule is
// a composition root / separate renderer entry (main.ts, inspector.ts,
// preview.ts, terminal.ts) — unrestricted imports, but still subject to the
// main-denylist and the acyclicity check. Future layers (renderer/flows/,
// renderer/render.ts, renderer/scheduler.ts) get rows here as D-mid/D-late
// land them.
const RULES = [
  {
    layer: "reading-core/",
    allowedPrefixes: ["reading-core/", "shared/"],
    allowedPackages: [],
  },
  // View builders may reach the DOM shell (dom/icons/popover-geometry), the
  // pure core, shared protocol types, and the late-binding actions INTERFACE
  // — never flows/render/scheduler/main, and never a sibling view family
  // (cross-view composition goes through main.ts via the actions seam).
  {
    layer: "renderer/view/",
    allowedPrefixes: [
      "renderer/view/icons",
      "renderer/view/popover-geometry",
      "renderer/dom",
      "renderer/actions",
      "reading-core/",
      "shared/",
    ],
    allowedPackages: ["lucide", "dompurify", "marked"],
  },
  // The seams and the DOM shell are leaves: they import nothing renderer-
  // internal (actions/dom types come from core/shared only).
  {
    layer: "renderer/actions.ts",
    allowedPrefixes: ["reading-core/", "shared/"],
    allowedPackages: [],
  },
  { layer: "renderer/invalidate.ts", allowedPrefixes: [], allowedPackages: [] },
  { layer: "renderer/dom.ts", allowedPrefixes: [], allowedPackages: [] },
];

// No module may import the composition root.
const DENY_TARGETS = ["renderer/main"];

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

function relativeToSrc(target) {
  return target.startsWith(SRC + sep) ? target.slice(SRC.length + 1) : target;
}

// Exact module (with or without extension) or anything under a directory
// prefix — never a lexical sibling ("renderer/view/icons-evil").
function prefixMatches(relative, prefix) {
  const p = prefix.replaceAll("/", sep);
  if (p.endsWith(sep)) {
    return (relative + sep).startsWith(p);
  }
  return relative === p || relative === `${p}.ts` || (relative + sep).startsWith(p + sep);
}

function ruleFor(relative) {
  let best = null;
  for (const rule of RULES) {
    if (prefixMatches(relative, rule.layer) && (!best || rule.layer.length > best.layer.length)) {
      best = rule;
    }
  }
  return best;
}

const files = [...tsFilesUnder(join(SRC, "reading-core")), ...tsFilesUnder(join(SRC, "renderer"))];
const violations = [];
const graph = new Map(); // absolute file path -> [absolute imported file paths]

for (const file of files) {
  const relative = relativeToSrc(file);
  const rule = ruleFor(relative);
  const source = readFileSync(file, "utf8");
  const edges = [];
  for (const specifier of specifiersIn(source)) {
    if (!specifier.startsWith(".")) {
      if (rule && !rule.allowedPackages.includes(specifier)) {
        violations.push(`${file}: package import "${specifier}" not allowed in ${rule.layer}`);
      }
      continue;
    }
    const target = resolve(dirname(file), specifier);
    const targetRelative = relativeToSrc(target);
    for (const deny of DENY_TARGETS) {
      if (targetRelative === deny.replaceAll("/", sep)) {
        violations.push(`${file}: imports the composition root "${specifier}" (${deny})`);
      }
    }
    if (rule) {
      const ok = rule.allowedPrefixes.some((prefix) => prefixMatches(targetRelative, prefix));
      if (!ok) {
        violations.push(
          `${file}: "${specifier}" resolves outside ${rule.layer} allowlist (${rule.allowedPrefixes.join(", ")})`,
        );
      }
    }
    // Graph edge for the acyclicity check (only .ts targets that exist).
    const asFile = existsSync(`${target}.ts`) ? `${target}.ts` : existsSync(target) && target.endsWith(".ts") ? target : null;
    if (asFile) {
      edges.push(asFile);
    }
  }
  graph.set(file, edges);
}

// Acyclicity over src/renderer + src/reading-core (map §2.4; the only
// intra-core constraint is acyclicity — C3 review ruling 2).
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map();
const stack = [];

function visit(node) {
  color.set(node, GRAY);
  stack.push(node);
  for (const next of graph.get(node) ?? []) {
    const c = color.get(next) ?? WHITE;
    if (c === GRAY) {
      const cycleStart = stack.indexOf(next);
      const cycle = [...stack.slice(cycleStart), next].map(relativeToSrc).join(" -> ");
      violations.push(`import cycle: ${cycle}`);
    } else if (c === WHITE) {
      visit(next);
    }
  }
  stack.pop();
  color.set(node, BLACK);
}

for (const node of graph.keys()) {
  if ((color.get(node) ?? WHITE) === WHITE) {
    visit(node);
  }
}

assert.deepEqual(violations, [], `import-fence violations:\n${violations.join("\n")}`);
console.log(
  `import-fence: ${RULES.length} layer rule(s) hold; no module imports renderer/main; ${graph.size} modules acyclic`,
);
