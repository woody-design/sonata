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
 * Duet's approval broker — the single hook Duet installs on `PermissionRequest`
 * (S2). Unlike the fire-and-forget sink, this HOLDS the CLI: it reads the
 * permission payload on stdin, surfaces it to Duet as `ask-<id>.json`, then
 * blocks polling for `reply-<id>.json`. On a reply it prints the decision JSON
 * to stdout (the CLI's structured answer channel) and exits 0. On timeout it
 * writes `expired-<id>.json` and exits 0 with NO output — the CLI then renders
 * its native permission panel in the terminal (the graceful fallback, verified
 * in Phase 0). It never writes to stderr; a broker failure must never block or
 * corrupt the CLI's turn.
 *
 * Protocol dir is argv[2] (Duet's `runtimeDir/approvals`). Timeout ms is argv[3]
 * (Duet passes the tuned ceiling; the CLI is visibly "in hook" until then).
 *
 * Files (all one-shot, tmp+rename so Duet only sees complete writes):
 *  - `ask-<id>.json`     : `{ id, receivedAt, payload }` — Duet renders the card.
 *  - `reply-<id>.json`   : the decision JSON (Duet writes it; broker emits it).
 *  - `expired-<id>.json` : `{}` — broker gave up; native panel took over.
 *  - `answered-<id>.json`: the decision the broker actually emitted (audit).
 */

const controlDir = process.argv[2];
const timeoutMs = Number(process.argv[3]) || 60_000;
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
  const answer = (decision: string): never => {
    // The ask cleanup MUST be independent of the audit write: if writeAtomic
    // throws (ENOSPC), a nested rmSync would be skipped → the ask-<id>.json
    // lingers and Duet's card never clears. Each step gets its own try.
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
    process.stdout.write(decision);
    process.exit(0);
  };

  const deadline = Date.now() + timeoutMs;
  const timer = setInterval(() => {
    const decision = readReply();
    if (decision !== null) {
      clearInterval(timer);
      answer(decision);
    }
    if (Date.now() > deadline) {
      clearInterval(timer);
      // FINAL reply check before giving up: a reply written in the poll gap must
      // still win, else Duet records an allow the CLI never received and the turn
      // wedges (a reply is orphaned into a dead broker's absence — reviewer C2).
      const late = readReply();
      if (late !== null) {
        answer(late);
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
