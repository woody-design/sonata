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

// Most-specific (longest) matching rule wins. All mapped layers have landed
// (D-late complete). A file with no matching rule must be a registered
// composition root (ROOTS below) — any other unmatched module is an
// UNCLAIMED layer and fails the fence (external review 2026-07-04: the
// default-open pass would let a future renderer/foo.ts bypass every layer
// rule; the fence must be a machine for future files too).
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
  // Flows (D4d): async orchestrations (create/submit/resume/approve…). May
  // import the paint layer (render), the actions INTERFACE (types only in
  // practice), the DOM shell, and the pure core — never view families, the
  // scheduler, or main; their calls into those arrive as init-bound deps
  // from the composition root. (The invalidate seam this row once allowed
  // was retired at D5 — flows import render directly.)
  {
    layer: "renderer/flows/",
    allowedPrefixes: [
      "renderer/flows/",
      "renderer/render",
      "renderer/actions",
      "renderer/dom",
      "reading-core/",
      "shared/",
    ],
    allowedPackages: [],
  },
  // The paint orchestrator (D4a): full render / transcript stream / directive
  // performer. May reach every view family, the DOM shell, and the pure core;
  // its outward calls (schedulers, report-refresh flow) are init-bound deps —
  // render never imports upward (flows/scheduler import render, never the
  // reverse).
  {
    layer: "renderer/render.ts",
    allowedPrefixes: ["renderer/view/", "renderer/dom", "reading-core/", "shared/"],
    allowedPackages: [],
  },
  // The scheduling layer (D4b): timing glue only — DOM shell (T1 reads the
  // strip clocks) and the pure core (formatters, state type). Fire targets
  // are init-bound deps, so the scheduler never imports paint or flow
  // modules.
  {
    layer: "renderer/scheduler.ts",
    allowedPrefixes: ["renderer/dom", "reading-core/", "shared/"],
    allowedPackages: [],
  },
  // The seams and the DOM shell are leaves: they import nothing renderer-
  // internal (actions/dom types come from core/shared only).
  {
    layer: "renderer/actions.ts",
    allowedPrefixes: ["reading-core/", "shared/"],
    allowedPackages: [],
  },
  { layer: "renderer/dom.ts", allowedPrefixes: [], allowedPackages: [] },
];

// Composition roots / separate renderer entries: the only files allowed to
// carry no RULES row. Unrestricted imports, but still subject to the
// main-denylist and the acyclicity check. (global.d.ts is ambient
// declarations — no imports to police.)
const ROOTS = [
  "renderer/main.ts",
  "renderer/preview.ts",
  "renderer/inspector.ts",
  "renderer/terminal.ts",
  "renderer/global.d.ts",
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
  if (!rule && !ROOTS.includes(relative.replaceAll(sep, "/"))) {
    violations.push(
      `${file}: unclaimed module — add a RULES row for its layer or register it in ROOTS`,
    );
  }
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
    // Normalize the resolved module id (review 2026-07-04): "./main.ts" and
    // the ESM-style "./main.js" must match the same rules as "./main" — an
    // extension must never tunnel through the denylist or an allowlist.
    const targetRelative = relativeToSrc(target).replace(/\.(ts|js)$/, "");
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
