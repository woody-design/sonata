// Slice 4 vocabulary fence. The corpus is intentionally broader than a list
// of strings we happened to change: it covers every renderer view, every
// reading selector, the runtime status reducer, slash descriptions, window
// titles, and renderer HTML. Any user-facing Terminal/terminal literal must be
// classified by exact file + value, so new legacy copy fails closed while
// internal identifiers do not create false positives.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const appRoot = path.resolve(import.meta.dirname, "../..");
const paths = {
  dom: "src/renderer/dom.ts",
  cli: "src/renderer/terminal.ts",
  sidebar: "src/reading-core/selectors/sidebar.ts",
  composer: "src/reading-core/selectors/composer.ts",
  runtime: "src/reading-core/runtime-reducer.ts",
  builtins: "src/shared/slash/builtins.ts",
  runs: "src/reading-core/selectors/runs.ts",
  settings: "src/renderer/view/settings.ts",
  main: "src/main/main.ts",
  updateButton: "src/renderer/view/update-button.ts",
  updaterInteractive: "src/main/updater/updater-interactive.ts",
  quitGuard: "src/main/quit-guard.ts",
  indexHtml: "src/renderer/index.html",
  cliHtml: "src/renderer/terminal.html",
  previewHtml: "src/renderer/preview.html",
};
const source = Object.fromEntries(
  Object.entries(paths).map(([key, relativePath]) => [key, read(relativePath)]),
);

assert.match(source.dom, />New task<\/span>/, "sidebar creation label is New task");
assert.match(
  source.dom,
  /id="toggle-terminal-window"[^>]*aria-pressed="true"[^>]*data-tooltip="Toggle Terminal \(CLI\)"/,
  "main toggle keeps toggle semantics and the Toggle Terminal (CLI) tooltip (copy 2026-07-24)",
);
assert.match(source.sidebar, /disclosureSessionGroup\("chats", "Tasks"/, "folderless group is Tasks");
assert.match(source.cli, /<p class="eyebrow terminal-window-label">CLI<\/p>/, "CLI header label");
assert.match(source.cli, />Start CLI<\/button>/, "fresh CLI action");
assert.match(source.cli, /: "Resume task";/, "dormant CLI action");
assert.match(source.cli, />Tasks<\/span>/, "fresh breadcrumb project");
assert.match(source.cli, />New task<\/span>/, "fresh breadcrumb task");
assert.match(source.main, /title:\s*"Sonata CLI"/, "native CLI window title");
assert.match(source.cliHtml, /<title>Sonata CLI<\/title>/, "CLI document title");

// Auto-update pill vocabulary (S2; re-pinned 2026-07-27 when the pill collapsed
// to two one-click states). The two button states are the agreed,
// Woody-approved wording; pin the string LITERALS (not the const-declaration
// syntax) so the fence tracks the wording — a harmless rename of the constants
// leaves it green, a softened or drifted label fails it. ("Check for Updates…"
// is the menu affordance, added by S3.)
assert.match(source.updateButton, /"Restart to Update"/, "update pill resting label");
assert.match(source.updateButton, /"Installing…"/, "update pill updating label");

// Run-card pending-wake label (SL-16, 2026-09-02). Woody-approved wording,
// pinned as a LITERAL for the same reason as the pills above: this is the one
// new user-facing string the revival-modeling slice introduced, and its exact
// form is load-bearing. The trailing character is a single `…` (U+2026), not
// three periods, and there is no "Ended," prefix — the ellipsis alone carries
// "this run is still owed something", which is precisely what the state means
// now that it is scoped to the turn that started the work.
assert.match(source.runs, /"Waiting on background work\u2026"/, "pending-wake run outcome label");

// Auto-update menu + dialog vocabulary (S3). The manual affordance's label and
// the eight result-dialog title/body strings are the agreed, Woody-approved
// wording. Pin the LITERALS (same rationale as the S2 pills): a wording drift
// fails the fence; a code refactor that keeps the copy stays green.
assert.match(source.main, /"Check for Updates…"/, "manual update menu affordance label");
// Dialog titles.
assert.match(source.updaterInteractive, /"You're up to date"/, "up-to-date dialog title");
assert.match(source.updaterInteractive, /"Update available"/, "found-downloading dialog title");
assert.match(source.updaterInteractive, /"Update on its way"/, "already-downloading dialog title");
assert.match(source.updaterInteractive, /"Update ready"/, "staged dialog title");
assert.match(source.updaterInteractive, /"Couldn't check for updates"/, "check-failed dialog title");
assert.match(source.updaterInteractive, /"Internal build"/, "disabled-internal dialog title");
assert.match(source.updaterInteractive, /"Updates unavailable"/, "disabled-location/dev dialog title");
assert.match(source.updaterInteractive, /"Updates disabled"/, "disabled-env dialog title");
// Dialog bodies (distinctive substrings — some are interpolated or concatenated).
assert.match(source.updaterInteractive, /is the latest version\./, "up-to-date dialog body");
assert.match(source.updaterInteractive, /is downloading in the background\./, "downloading dialog body");
// Names the pill by its label, so the pointer stays true to what the user will
// actually see (re-pinned 2026-07-27 with the pill's two-state collapse).
assert.match(
  source.updaterInteractive,
  /The Restart to Update button will appear in the sidebar when it's ready\./,
  "downloading dialog sidebar pointer",
);
assert.match(source.updaterInteractive, /is ready to install\./, "staged dialog body");
assert.match(source.updaterInteractive, /"Sonata will retry automatically\."/, "check-failed dialog body");
assert.match(source.updaterInteractive, /"Later"/, "staged dialog cancel button");
assert.match(
  source.updaterInteractive,
  /"This build updates through update-daily\.sh, not the public channel\."/,
  "disabled-internal dialog body",
);
assert.match(
  source.updaterInteractive,
  /"Move Sonata to the Applications folder to enable automatic updates\."/,
  "disabled-location dialog body",
);
assert.match(
  source.updaterInteractive,
  /"Updates are disabled in development builds\."/,
  "disabled-dev dialog body",
);
assert.match(
  source.updaterInteractive,
  /"Automatic updates are turned off for this session \(SONATA_DISABLE_UPDATER\)\."/,
  "disabled-env dialog body",
);
// "Restart to Update" is shared with the pill; assert it also anchors the staged
// dialog's default button so a drift here can't slip past the pill-only pin.
assert.match(source.updaterInteractive, /"Restart to Update"/, "staged dialog restart button");

// Quit / last-window confirmation vocabulary (Focus/Flow S4, D5). These four
// strings are the whole dialog, and they are Woody-approved verbatim — note the
// body carries NO full stop, matching the rest of the family. Pinned on
// main/quit-guard.ts because that file is the SINGLE author of this copy for
// both surfaces: the renderer dialog paints the words main pushes it, and the
// native `dialog.showMessageBox` fallback reads the same spec. So one pin here
// covers both, and a renderer that started composing its own wording would
// break the smoke:quit-guard projection assertions instead.
assert.match(source.quitGuard, /title: "Quit Sonata\?"/, "quit dialog title");
assert.match(
  source.quitGuard,
  /body: "All sessions will be terminated"/,
  "quit dialog body (no full stop)",
);
assert.match(source.quitGuard, /"Close Sonata"/, "quit dialog primary CTA");
assert.match(source.quitGuard, /buttons: \["Close Sonata", "Cancel"\]/, "quit dialog CTA pair + order");

const rendererFiles = filesUnder("src/renderer", ".ts").filter(
  (file) => ![paths.dom, paths.cli].includes(file),
);
const selectorFiles = filesIn("src/reading-core/selectors", ".ts");
const literalCorpusFiles = [
  ...rendererFiles,
  ...selectorFiles,
  paths.runtime,
  paths.builtins,
];
const uiCorpus = [
  ...literalCorpusFiles.map((file) => ({ file, values: literalValues(read(file)) })),
  {
    file: paths.dom,
    values: [...htmlAssignmentCopy(source.dom), ...visibleAssignmentCopy(source.dom)],
  },
  {
    file: paths.cli,
    values: [...htmlAssignmentCopy(source.cli), ...visibleAssignmentCopy(source.cli)],
  },
  { file: paths.main, values: propertyAssignmentCopy(source.main, "title") },
  ...[paths.indexHtml, paths.cliHtml, paths.previewHtml]
    .filter((file) => fs.existsSync(path.join(appRoot, file)))
    .map((file) => ({ file, values: visibleHtmlCopy(read(file)) })),
];

// New chat / Chats have no truthful user-facing exception: Sonata's work unit is
// a task. The sole compatibility value is the internal disclosure group id.
// Apply this to the same extracted corpus as Terminal so HTML templates and
// every renderer view/flow are covered, not just the original two source files.
const internalLegacyTaskLiterals = [exact(paths.sidebar, "chats", 1)];
const legacyTaskEntries = uiCorpus.flatMap(({ file, values }) =>
  values
    .filter((value) => /\bnew\s+chat\b/i.test(value) || /\bchats\b/i.test(value))
    .map((value) => ({ file, value })),
);
for (const entry of legacyTaskEntries) {
  assert.equal(
    internalLegacyTaskLiterals.some(
      (classification) =>
        classification.file === entry.file && classification.value === entry.value,
    ),
    true,
    `unclassified legacy task UI literal in ${entry.file}: ${JSON.stringify(entry.value)}`,
  );
}
for (const classification of internalLegacyTaskLiterals) {
  const count = legacyTaskEntries.filter(
    (entry) => entry.file === classification.file && entry.value === classification.value,
  ).length;
  assert.equal(
    count,
    classification.count,
    `legacy task literal count drifted in ${classification.file}: ${classification.value}`,
  );
}

// User-facing uses that truthfully describe provider-owned/background
// terminals, an external terminal, or the real completion detector.
const allowedTerminalCopy = [
  // The CLI satellite toggle (2026-07-24 copy): "Terminal" for readers who
  // don't know the acronym, "(CLI)" to anchor the term the providers use.
  // aria-label + data-tooltip carry the same value; the extractor yields it once.
  exact(paths.dom, "Toggle Terminal (CLI)", 1),
  exact(paths.builtins, "terminal-setup", 1),
  exact(paths.builtins, "List background terminals", 1),
  exact(paths.builtins, "Stop all background terminals", 1),
  exact(paths.builtins, "Configure the terminal title", 1),
  exact(paths.builtins, "Choose or hide the terminal pet", 1),
  exact(paths.runs, "Completed by terminal idle heuristic", 1),
  exact(
    paths.settings,
    "Turned off by Sonata's earlier bridge. Restoring affects terminals outside Sonata.",
    1,
  ),
  // (CLI readiness S2 had four classifications here — the readiness card's copy,
  // which said "the terminal window" while the window's own chrome calls itself
  // "CLI". This fence is what surfaced that tension, and D8 v2 RESOLVED it: Woody's
  // visual gate renamed every one of those strings to "the CLI window", so they no
  // longer belong to the Terminal category at all and the classifications are gone
  // rather than updated. The card's copy now agrees with the window it points at,
  // which is what this fence exists to enforce.)
];

// Exact non-copy values in otherwise copy-bearing files. Adding an internal
// Terminal literal is deliberate friction: classify it here or, if visible,
// in allowedTerminalCopy. No substring/pattern exceptions are accepted.
const internalTerminalLiterals = [
  exact("src/renderer/actions.ts", "terminal", 1),
  exact("src/renderer/flows/session-flows.ts", "terminal", 1),
  exact("src/renderer/main.ts", "terminal", 1),
  // drawer S2: the expired permission drawer's "Answer in CLI →" pointer
  // routes through setViewMode("terminal") — one internal literal.
  exact("src/renderer/view/approvals.ts", "terminal", 1),
  exact("src/renderer/view/banners.ts", "attention-open-terminal", 1),
  exact("src/renderer/view/banners.ts", "terminal", 1),
  exact("src/renderer/view/status-strip.ts", "terminal", 1),
  exact("src/renderer/view/transcript.ts", "terminal-idle-heuristic", 1),
  exact("src/renderer/view/transcript.ts", "secondary turn-terminal-action", 2),
  exact("src/renderer/view/transcript.ts", "terminal", 2),
  exact(paths.runs, "terminal-idle-heuristic", 1),
];

const classifications = [...allowedTerminalCopy, ...internalTerminalLiterals];
const terminalEntries = uiCorpus.flatMap(({ file, values }) =>
  values
    .filter((value) => /\bterminals?\b/i.test(value))
    .map((value) => ({ file, value })),
);
for (const entry of terminalEntries) {
  assert.equal(
    classifications.some(
      (classification) =>
        classification.file === entry.file && classification.value === entry.value,
    ),
    true,
    `unclassified Terminal UI literal in ${entry.file}: ${JSON.stringify(entry.value)}`,
  );
}
for (const classification of classifications) {
  const count = terminalEntries.filter(
    (entry) => entry.file === classification.file && entry.value === classification.value,
  ).length;
  assert.equal(
    count,
    classification.count,
    `Terminal literal count drifted in ${classification.file}: ${classification.value}`,
  );
}

console.log(
  JSON.stringify(
    {
      success: true,
      files: [...new Set(uiCorpus.map(({ file }) => file))].sort(),
      legacyTaskEntries,
      terminalEntries,
      allowedTerminalCopy,
    },
    null,
    2,
  ),
);

function exact(file, value, count) {
  return { file, value, count };
}

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

function filesIn(relativeDirectory, extension) {
  return fs
    .readdirSync(path.join(appRoot, relativeDirectory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.posix.join(relativeDirectory, entry.name))
    .sort();
}

function filesUnder(relativeDirectory, extension) {
  const results = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(path.join(appRoot, directory), { withFileTypes: true })) {
      const relativePath = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(relativePath);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        results.push(relativePath);
      }
    }
  };
  visit(relativeDirectory);
  return results.sort();
}

function parsed(body) {
  return ts.createSourceFile("corpus.ts", body, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
}

function literalValues(body) {
  const values = [];
  const visit = (node) => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      values.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed(body));
  return values;
}

function htmlAssignmentCopy(body) {
  const values = [];
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "innerHTML"
    ) {
      values.push(...visibleHtmlCopy(templateText(node.right)));
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed(body));
  return values;
}

function templateText(node) {
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
  }
  return "";
}

function visibleHtmlCopy(html) {
  const values = [];
  for (const match of html.matchAll(/\b(?:aria-label|title|placeholder|alt)="([^"]+)"/g)) {
    values.push(normalizeSpace(match[1]));
  }
  for (const match of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/>([^<]+)</g)) {
    const value = normalizeSpace(match[1]);
    if (value && !/^\$\{.*\}$/.test(value)) {
      values.push(value);
    }
  }
  return values;
}

function visibleAssignmentCopy(body) {
  const values = [];
  const file = parsed(body);
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ["textContent", "innerText", "title", "placeholder", "ariaLabel"].includes(
        node.left.name.text,
      )
    ) {
      values.push(...literalValues(node.right.getText(file)));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === "createTextNode" && node.arguments[0]) {
        values.push(...literalValues(node.arguments[0].getText(file)));
      }
      if (
        method === "setAttribute" &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        ["aria-label", "title", "placeholder"].includes(node.arguments[0].text) &&
        node.arguments[1]
      ) {
        values.push(...literalValues(node.arguments[1].getText(file)));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return values;
}

function propertyAssignmentCopy(body, propertyName) {
  const values = [];
  const file = parsed(body);
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === propertyName) ||
        (ts.isStringLiteralLike(node.name) && node.name.text === propertyName))
    ) {
      values.push(...literalValues(node.initializer.getText(file)));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return values;
}

function normalizeSpace(value) {
  return value.replace(/\s+/g, " ").trim();
}
