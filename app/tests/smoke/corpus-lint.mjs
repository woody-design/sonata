import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

// Governance fence for the pinned runtime-event corpus (review 2026-07-03
// P1): pinned fixtures must never carry account/environment data. This lint
// is what makes the sanitizer's guarantees durable — a future re-pin that
// skips sanitization fails here, not in a repo audit.
// Covers BOTH pinned-fixture trees (C2 review): the raw-event corpus and the
// reducer goldens derived from it — a future golden regen from an unsanitized
// capture fails here, not in a repo audit.
// THIRD TREE (upstream sync 2026-09-01, SL-2): `claude-idle` pins whole real
// pty streams from probe sessions against a live CLI — the same class of
// capture, with the same exposure (cwd paths, the Remote Control session URL a
// 2.1.252 boot banner prints), so it belongs under the same fence rather than
// relying on the probe's own sanitizer having been run.
const FIXTURES = dirname(fileURLToPath(import.meta.url)) + "/../fixtures";
// FOURTH TREE (upstream sync 2026-09-01, SL-3): `claude-boot` pins rendered
// grid frames captured from a live CLI's boot ceremony — same class, same
// exposure (the frames carry the probe's cwd, and a boot banner can print the
// Remote Control session URL).
// FIFTH TREE (upstream sync 2026-09-01, SL-4): `claude-midsession` pins verbatim
// pty windows from a live mid-session `/model` switch — raw escape bytes, and
// each one contains a full transcript redraw, so it carries the probe's cwd and
// whatever the banner printed at that instant. Same class, same fence.
// SIXTH TREE (upstream sync 2026-09-01, SL-11): `claude-remote-control` pins
// verbatim pty windows from live Remote Control transitions. Same class and the
// SHARPEST exposure of the six — an RC window is where the session link lives.
// The pinned windows carry no real link (one was captured through the probe's
// id redaction and re-seeded with a `session_REDACTED…` id; the other is trimmed
// to start below the link row), but the tree is fenced because the next re-pin
// will not remember that — and adding it exposed a hole the fence had all along,
// see the scheme-independent rule below.
const ROOTS = [
  resolve(FIXTURES, "runtime-events"),
  resolve(FIXTURES, "reducer-goldens"),
  resolve(FIXTURES, "claude-idle"),
  resolve(FIXTURES, "claude-boot"),
  resolve(FIXTURES, "claude-midsession"),
  resolve(FIXTURES, "claude-remote-control"),
];
const HOME = os.homedir();
const USER = process.env.USER ?? "";

const FORBIDDEN = [
  { name: "email (non-placeholder)", re: /[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "real home path", re: new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) },
  ...(USER && USER !== "user"
    ? [{ name: "real username path", re: new RegExp(`/Users/${USER}\\b`) }]
    : []),
  { name: "claude.ai/.com url", re: /https:\/\/claude\.(?:ai|com)\/(?!REDACTED)[A-Za-z0-9/_-]+/ },
  // SCHEME-INDEPENDENT, and that is the point (SL-11 review). The rule above
  // needs a literal `https://`, which a pinned pty window can be missing through
  // no sanitising at all: claude's differential repaint does not re-emit
  // characters already correct on the grid, so a REAL link reaches a capture as
  // `at https:\x1b[69G/claude.ai/code/session_…` — one slash, and stripping the
  // escape does not restore the other. The identifying payload is the host and
  // the id, so that is what this matches, with no scheme at all. Redacted or
  // deliberately synthetic ids must say so in the id itself (`session_REDACTED…`),
  // which is what makes a fixture's synthetic link distinguishable from a live
  // one BY THE FENCE rather than by the author remembering.
  {
    name: "claude session link (any scheme)",
    re: /claude\.(?:ai|com)\/code\/session_(?!REDACTED)[A-Za-z0-9_-]+/,
  },
  { name: "secret-like token", re: /\bsk-(?!REDACTED)[A-Za-z0-9-]{10,}/ },
];

/** Terminal escapes, matching `cleanTerminal`'s ANSI pattern (tui-parsers-common).
 *  Inlined rather than imported: this lint is a governance fence and must run
 *  against the fixture trees whether or not `dist/` has been built. */
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

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

const files = ROOTS.flatMap((root) => filesUnder(root));
assert.ok(files.length > 0, "pinned fixtures exist");

const hits = [];
for (const file of files) {
  const raw = readFileSync(file, "utf8");
  // Three of the five trees pin RAW pty bytes, where a marker can be split by a
  // cursor move mid-word (`/Users/\x1b[12Gwoody/…`) and slip past a rule that
  // only ever sees the literal text. Scan the escape-stripped form too, so the
  // fence reads what the SCREEN would show as well as what the file holds.
  const forms = [
    ["raw", raw],
    ["escape-stripped", raw.replace(ANSI_RE, "")],
  ];
  for (const { name, re } of FORBIDDEN) {
    for (const [form, text] of forms) {
      const match = text.match(re);
      if (match) {
        hits.push(`${file}: ${name} (${form}) → ${JSON.stringify(match[0].slice(0, 60))}`);
        break; // one report per rule per file
      }
    }
  }
}

assert.deepEqual(hits, [], `corpus-lint violations:\n${hits.join("\n")}`);
console.log(`corpus-lint: ${files.length} pinned file(s) clean`);
