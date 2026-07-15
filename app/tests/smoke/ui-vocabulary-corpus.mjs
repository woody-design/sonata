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
  /class="secondary cli-toggle"[^>]*aria-pressed="true"[^>]*>CLI<\/button>/,
  "main toggle keeps the stable CLI label and toggle semantics",
);
assert.match(source.sidebar, /disclosureSessionGroup\("chats", "Tasks"/, "folderless group is Tasks");
assert.match(source.cli, /<p class="eyebrow terminal-window-label">CLI<\/p>/, "CLI header label");
assert.match(source.cli, />Start CLI<\/button>/, "fresh CLI action");
assert.match(source.cli, /: "Resume task";/, "dormant CLI action");
assert.match(source.cli, />Tasks<\/span>/, "fresh breadcrumb project");
assert.match(source.cli, />New task<\/span>/, "fresh breadcrumb task");
assert.match(source.main, /title:\s*"Duet CLI"/, "native CLI window title");
assert.match(source.cliHtml, /<title>Duet CLI<\/title>/, "CLI document title");

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

// New chat / Chats have no truthful user-facing exception: Duet's work unit is
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
  exact(paths.builtins, "terminal-setup", 1),
  exact(paths.builtins, "List background terminals", 1),
  exact(paths.builtins, "Stop all background terminals", 1),
  exact(paths.builtins, "Configure the terminal title", 1),
  exact(paths.builtins, "Choose or hide the terminal pet", 1),
  exact(paths.runs, "Completed by terminal idle heuristic", 1),
  exact(
    paths.settings,
    "Turned off by Duet's earlier bridge. Restoring affects terminals outside Duet.",
    1,
  ),
];

// Exact non-copy values in otherwise copy-bearing files. Adding an internal
// Terminal literal is deliberate friction: classify it here or, if visible,
// in allowedTerminalCopy. No substring/pattern exceptions are accepted.
const internalTerminalLiterals = [
  exact("src/renderer/actions.ts", "terminal", 1),
  exact("src/renderer/flows/session-flows.ts", "terminal", 1),
  exact("src/renderer/main.ts", "terminal", 1),
  exact("src/renderer/view/approvals.ts", "attention-open-terminal", 1),
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
