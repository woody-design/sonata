// P1 scan cost (2026-09 D2, slice U2) — what the decoupling COSTS, timed through
// the SHIPPED locator.
//
// WHY THIS IS A SEPARATE FILE FROM p1. The p1 probe answers "what does the CLI
// name the directory"; it timed a *replica* of the scan inline, which is fine for
// a sanity check and not fine as the source of a number quoted in shipped source
// comments and in the inventory. A replica can drift from the thing it models —
// so every performance claim in `session-locator.ts`, in F76, and in the
// coupling-inventory row now cites THIS capture, produced by importing
// `locateSessionFile` from `dist/` and calling it.
//
// WHAT IT MEASURES. Both layers of the post-U2 Claude locator, over the user's
// REAL projects root (the point: ~900 directories, not a fixture):
//
//   - the id-anchored scan on a HIT   — one `readdir` + `stat` until found;
//   - the id-anchored scan on a MISS  — one `readdir` + one `stat` per project
//     directory with no early exit, which is the TRUE worst case and, per F74,
//     the common case before a session's first turn (the transcript is written
//     lazily, so discovery polls a guaranteed miss until then);
//   - the id-LESS mtime fallback, which production never reaches
//     (`allowMtimeFallback:false` at both `assembleTaskRuntime` call sites) but
//     which the smoke suite does, at two not-before windows.
//
// METHOD. One warm-up call per case, discarded, then N timed calls; the MEDIAN is
// reported alongside min/max, because a single sample over a filesystem is noise.
// Read-only: nothing here spawns a CLI, writes a file, or touches the user's
// configuration, so it needs no settings guard — the one probe in this program
// that genuinely does not.
//
// The capture is sanitized for `$HOME` and the munged `-Users-…-` form; the
// session id it happens to time against is redacted, since it names a real
// conversation of the user's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { locateSessionFile } = require(APP_DIR + "dist/runtime/provider-transcript/index");

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

const RUNS = 12;
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

const projectsDir = path.join(HOME, ".claude", "projects");
const dirCount = (() => {
  try {
    return fs.readdirSync(projectsDir).length;
  } catch {
    return 0;
  }
})();

/** A real session file to hit, plus the cwd its own head record declares — the
 *  id-less fallback needs a cwd that some file will actually match, or it would
 *  be timing a search with no possible answer. */
function findProbeSession() {
  for (const dir of fs.readdirSync(projectsDir)) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(projectsDir, dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = path.join(projectsDir, dir, file);
      let head = "";
      try {
        head = fs.readFileSync(full, "utf8").slice(0, 200_000);
      } catch {
        continue;
      }
      for (const line of head.split("\n").slice(0, 40)) {
        try {
          const record = JSON.parse(line);
          if (typeof record?.cwd === "string") {
            return { dir, id: path.basename(file, ".jsonl"), cwd: record.cwd, path: full };
          }
        } catch {
          /* not a record */
        }
      }
    }
  }
  return null;
}

const probe = findProbeSession();
if (!probe) {
  console.log(JSON.stringify({ success: false, reason: `no readable session under ${projectsDir}` }));
  process.exit(1);
}

function time(fn) {
  fn(); // warm-up, discarded
  const samples = [];
  let last = null;
  for (let i = 0; i < RUNS; i++) {
    const started = process.hrtime.bigint();
    last = fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return {
    median: samples[Math.floor(RUNS / 2)],
    min: samples[0],
    max: samples[RUNS - 1],
    found: last ? path.basename(last.path) : null,
  };
}

const base = {
  provider: "claude",
  providerCwd: probe.cwd,
  notBefore: new Date(Date.now() - 60_000).toISOString(),
};

const cases = [
  {
    label: "id scan — HIT",
    reachedBy: "discovery, once the session's first turn has written the file",
    run: () =>
      locateSessionFile({ ...base, expectedSessionId: probe.id, allowMtimeFallback: false }),
  },
  {
    label: "id scan — MISS (no early exit)",
    reachedBy: "every discovery poll before the first turn (F74) — the common case",
    run: () =>
      locateSessionFile({ ...base, expectedSessionId: MISSING_ID, allowMtimeFallback: false }),
  },
  {
    label: "id-less mtime fallback, 60s window",
    reachedBy: "nothing in production (allowMtimeFallback:false at both call sites)",
    run: () => locateSessionFile({ ...base, allowMtimeFallback: true }),
  },
  {
    label: "id-less mtime fallback, 7-day window",
    reachedBy: "nothing in production; the widest a caller could plausibly ask for",
    run: () =>
      locateSessionFile({
        ...base,
        notBefore: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
        allowMtimeFallback: true,
      }),
  },
];

const results = cases.map((entry) => ({ ...entry, run: undefined, ...time(entry.run) }));

const lines = [
  `# p1 scan cost — the shipped locator over the real projects root (D2 U2)`,
  ``,
  `Produced by \`p1-scan-cost.mjs\`, which imports \`locateSessionFile\` from`,
  `\`app/dist/runtime/provider-transcript/index\` and calls it. Every performance`,
  `number in \`session-locator.ts\`, in finding F76, and in the coupling-inventory`,
  `row for "Transcript / rollout file paths" cites THIS file.`,
  ``,
  `- projects root: \`$HOME/.claude/projects\` — **${dirCount} entries**`,
  `- timed session: \`<redacted>.jsonl\` in one of them (a real conversation; the`,
  `  id is not evidence and is not printed)`,
  `- **${RUNS} timed runs per case**, one discarded warm-up before each; median`,
  `  reported, min/max alongside`,
  `- machine: darwin, APFS, warm page cache (the numbers a running app sees)`,
  ``,
  `| case | median | min | max | found | reached by |`,
  `|---|---|---|---|---|---|`,
  ...results.map(
    (r) =>
      `| ${r.label} | **${r.median.toFixed(2)} ms** | ${r.min.toFixed(2)} ms | ` +
      `${r.max.toFixed(2)} ms | ${r.found ? "yes" : "no"} | ${r.reachedBy} |`,
  ),
  ``,
  `## Reading these numbers`,
  ``,
  `What this replaced was a \`readdir\` of ONE slug-named directory — well under`,
  `a millisecond, never measured, and not measurable now that the code is gone.`,
  `So the comparison is stated as a shape rather than a ratio: a bounded`,
  `per-directory \`stat\` sweep where there used to be a single directory read.`,
  `The MISS row is the number that matters, because per F74 it is the common`,
  `case: discovery polls every 1.5 s for up to 120 s while the transcript does`,
  `not yet exist, so a task that never reaches its first turn spends roughly`,
  `${(results[1].median * 80).toFixed(0)} ms of \`stat\` across those two minutes — on the order of 0.3% of`,
  `one core. That is the registered cost (F76/F79); the saving is in discovery's`,
  `lifecycle, not in this function.`,
  ``,
  `The directory count moves on its own — this root held 915 entries earlier the`,
  `same day and ${dirCount} at the time of this run — so treat the absolute`,
  `medians as "this machine, this many directories", and the SHAPE (linear in`,
  `directory count, one \`stat\` each) as the durable claim.`,
  ``,
  `The id-less rows are stated for completeness. Production cannot reach them:`,
  `\`assembleTaskRuntime\` passes \`allowMtimeFallback:false\` on both entry`,
  `points, and it is the only construction site of a transcript that discovers.`,
  ``,
];

const capture = `${sanitize(lines.join("\n"))}\n`;
fs.writeFileSync(path.join(OUT_DIR, "p1-scan-cost.capture.txt"), capture);
console.log(capture);
console.log(
  JSON.stringify({ success: true, dirCount, runs: RUNS, capture: "p1-scan-cost.capture.txt" }),
);
