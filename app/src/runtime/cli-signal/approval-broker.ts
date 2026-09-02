import fs from "node:fs";
import path from "node:path";
import {
  ANSWERED_PREFIX,
  APPROVAL_POLL_MS,
  ASK_PREFIX,
  EXPIRED_PREFIX,
  REPLY_PREFIX,
} from "./approval-protocol";

/**
 * Sonata's approval broker — the single hook Sonata installs on `PermissionRequest`
 * (S2). Unlike the fire-and-forget sink, this HOLDS the CLI: it reads the
 * permission payload on stdin, surfaces it to Sonata as `ask-<id>.json`, then
 * blocks polling for `reply-<id>.json`. On a reply it prints the decision JSON
 * to stdout (the CLI's structured answer channel) and exits 0. On timeout it
 * writes `expired-<id>.json` and exits 0 with NO output — the CLI then renders
 * its native permission panel in the terminal (the graceful fallback, verified
 * in Phase 0). It never writes to stderr; a broker failure must never block or
 * corrupt the CLI's turn.
 *
 * Protocol dir is argv[2] (Sonata's `runtimeDir/approvals`). Timeout ms is argv[3]
 * (Sonata passes the tuned ceiling; the CLI is visibly "in hook" until then).
 *
 * Files (all one-shot, tmp+rename so Sonata only sees complete writes):
 *  - `ask-<id>.json`     : `{ id, receivedAt, payload }` — Sonata renders the card.
 *  - `reply-<id>.json`   : the decision JSON (Sonata writes it; broker emits it).
 *  - `expired-<id>.json` : `{}` — broker gave up; native panel took over.
 *  - `answered-<id>.json`: the decision the broker actually emitted (audit).
 *
 * STDOUT CONTRACT (audited SL-9 against claude 2.1.258, probe
 * `spikes/upstream-sync-2026-09/claude/h2-hook-stdout-audit.mjs`). The CLI parses
 * this stream: output that does not start with `{` degrades to plain text
 * harmlessly, but `{`-leading text that ENDS with `}` and does not parse — or
 * parses and fails the hook-output schema — sets `validationError`, which one CLI
 * call site reports as a non-blocking hook error and another `throw`s on. So the
 * only safe emissions are "nothing at all" and "one complete, schema-valid JSON
 * object", and the broker must never emit a PARTIAL object. Every path here was
 * measured for stdout bytes; the only writer is `answer()`.
 */

// A dead read end (the CLI killed the hook, the pty went away) makes the stdout
// write emit `error` instead of throwing. Unhandled, that is a crash with stderr
// noise on a channel this broker promises never to write to. Swallow it and exit
// clean: a broker failure must never block or corrupt the CLI's turn.
process.stdout.on("error", () => {
  process.exit(0);
});

const controlDir = process.argv[2];
// Fallback mirrors the injected production hold (claude-runtime-settings) so a
// direct spawn without argv can't silently regress to the pre-S0 60s behavior.
const timeoutMs = Number(process.argv[3]) || 580_000;
const POLL_MS = APPROVAL_POLL_MS;

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});

process.stdin.on("end", () => {
  if (!controlDir) {
    process.exit(0);
  }
  let payload: unknown = {};
  try {
    payload = JSON.parse(raw.trim() || "{}");
  } catch {
    payload = { parseError: true };
  }

  // AskUserQuestion is NOT an approval — since ~2.1.2xx the CLI fires
  // PermissionRequest for it alongside PreToolUse (probed 2.1.212,
  // spikes/drawer-option-prompt-probe P5). Holding it here surfaced a phantom
  // approval card next to the option-prompt card, locked the keyed delivery
  // gate, and expired into a false "waiting in the CLI" banner. Exit undecided
  // immediately (no ask file, no stdout): P1 proved the option form renders
  // and answers normally after an undecided hook exit.
  const toolName =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).tool_name
      : undefined;
  if (toolName === "AskUserQuestion") {
    process.exit(0);
  }

  // Sortable, collision-free id across concurrent brokers (parallel tool
  // approvals from subagents): wall clock + hrtime + pid.
  const id = `${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}-${process.pid}`;
  const askPath = path.join(controlDir, `${ASK_PREFIX}${id}.json`);
  const replyPath = path.join(controlDir, `${REPLY_PREFIX}${id}.json`);
  const expiredPath = path.join(controlDir, `${EXPIRED_PREFIX}${id}.json`);
  const answeredPath = path.join(controlDir, `${ANSWERED_PREFIX}${id}.json`);

  try {
    fs.mkdirSync(controlDir, { recursive: true });
    writeAtomic(askPath, JSON.stringify({ id, receivedAt: new Date().toISOString(), payload }));
  } catch {
    // Could not surface the ask → fall back to the native panel immediately.
    process.exit(0);
  }

  const readReply = (): string | null => {
    try {
      return fs.existsSync(replyPath) ? fs.readFileSync(replyPath, "utf8") : null;
    } catch {
      return null;
    }
  };
  const answer = (decision: string): void => {
    // The ask cleanup MUST be independent of the audit write: if writeAtomic
    // throws (ENOSPC), a nested rmSync would be skipped → the ask-<id>.json
    // lingers and Sonata's card never clears. Each step gets its own try.
    try {
      writeAtomic(answeredPath, decision);
    } catch {
      // audit best-effort
    }
    try {
      fs.rmSync(replyPath, { force: true });
    } catch {
      // best-effort
    }
    try {
      fs.rmSync(askPath, { force: true });
    } catch {
      // best-effort
    }
    // NOT `process.stdout.write(d); process.exit(0)`. On macOS a pipe write is
    // ASYNC, and exiting before it drains TRUNCATES the decision — MEASURED at
    // exactly 65536 bytes (one pipe buffer) under BOTH interpreters, plain node
    // and the production `ELECTRON_RUN_AS_NODE=1` shape (SL-9, h2 part B). A
    // truncation that happens to land on a `}` is the CLI's hard `validationError`
    // path; one that does not is silently discarded as plain text and the user's
    // answer is simply lost. Today's decisions are ~100–250 bytes so the bug is
    // latent, but `updatedPermissions` is an unbounded list and the failure mode
    // is silent, which is the combination worth closing.
    //
    // The fix is to stop exiting early: the poll interval is already cleared and
    // stdin has ended by every call site, so the pending stdout write is the ONLY
    // thing left holding the event loop — Node exits on its own the moment it
    // drains, with the exit code set here.
    process.exitCode = 0;
    process.stdout.write(decision);
  };

  const deadline = Date.now() + timeoutMs;
  const timer = setInterval(() => {
    const decision = readReply();
    if (decision !== null) {
      clearInterval(timer);
      answer(decision);
      // `answer` no longer exits the process (it must let the stdout write
      // drain), so both call sites have to return themselves — falling through
      // to the deadline branch would write `expired-<id>.json` over an answer
      // the CLI is about to receive.
      return;
    }
    if (Date.now() > deadline) {
      clearInterval(timer);
      // FINAL reply check before giving up: a reply written in the poll gap must
      // still win, else Sonata records an allow the CLI never received and the turn
      // wedges (a reply is orphaned into a dead broker's absence — reviewer C2).
      const late = readReply();
      if (late !== null) {
        answer(late);
        return;
      }
      // Cleanup independent of the marker write (see answer()): the ask must be
      // removed even if writeAtomic throws, or the card never clears.
      try {
        writeAtomic(expiredPath, "{}");
      } catch {
        // best-effort
      }
      try {
        fs.rmSync(askPath, { force: true });
      } catch {
        // best-effort
      }
      process.exit(0); // no stdout → the CLI renders its native panel
    }
  }, POLL_MS);
  // NOTE: deliberately NOT unref'd. This broker is a short-lived subprocess
  // whose ONLY job is to poll for the reply; the interval must keep the event
  // loop alive until it decides or times out. (Unref would exit immediately
  // after stdin ends → no poll → the CLI falls straight to its native panel.)
});

function writeAtomic(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, contents, "utf8");
  fs.renameSync(tmpPath, filePath);
}
