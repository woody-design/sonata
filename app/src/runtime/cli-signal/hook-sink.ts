import fs from "node:fs";
import path from "node:path";

/**
 * Sonata's Claude hook sink — the small script the CLI invokes for every injected
 * hook event (mirrors the statusline sink). It reads the hook payload (JSON) on
 * stdin and writes it as ONE uniquely-named file into the directory passed as
 * argv[2], via tmp+rename so the watcher only ever sees complete files.
 *
 * One file per invocation (not an append log): hook processes run concurrently
 * and large payloads (e.g. Stop's last_assistant_message) exceed the atomic
 * append size, so per-file writes are the race-free choice. The watcher consumes
 * and deletes them. Exit 0 always — observation must never block the CLI's turn.
 *
 * STDOUT CONTRACT: this script writes NOTHING to stdout, ever, on any path —
 * which is what makes it immune to the CLI's hook-output parser. AUDITED SL-9
 * (probe `spikes/upstream-sync-2026-09/claude/h2-hook-stdout-audit.mjs`, part B):
 * nine paths — normal payload, empty stdin, whitespace-only stdin, malformed
 * stdin, missing argv, ENOTDIR target, EACCES parent, a 1 MB payload, invalid
 * UTF-8 — measured at ZERO stdout bytes under BOTH interpreters (plain node and
 * the production `ELECTRON_RUN_AS_NODE=1` shape). Keep it that way: at claude
 * 2.1.258 a hook that prints `{`-leading text which ends in `}` and does not
 * parse is a `validationError`, and one CLI call site `throw`s on that. There is
 * no reason to print here — the watcher reads FILES — so the rule is simply
 * "never write stdout", pinned by `tests/smoke/hook-stdout-contract.mjs`.
 */

const outputDirectory = process.argv[2];

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});

process.stdin.on("end", () => {
  if (!outputDirectory) {
    return;
  }
  const trimmed = raw.trimEnd();
  if (!trimmed) {
    return;
  }
  try {
    fs.mkdirSync(outputDirectory, { recursive: true });
    // Sortable, collision-free across concurrent hook processes: wall clock for
    // ordering + hrtime + pid for uniqueness.
    const seq = `${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}-${process.pid}`;
    const filePath = path.join(outputDirectory, `hook-${seq}.json`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, trimmed, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Never surface a sink failure to the CLI.
  }
});
