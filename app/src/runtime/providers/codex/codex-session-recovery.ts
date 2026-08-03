import type { RuntimeProvider } from "../../../shared/types/domain";

/**
 * Codex session-recovery classification (upstream sync 2026-08-03, SL-6).
 *
 * WHY THIS EXISTS. codex 0.146.0 carries an open, untriaged silent-exit class on
 * macOS: the TUI process dies with no stderr and no crash report at the moment
 * the final agent message of a turn finishes rendering (openai/codex #36005;
 * corroborating cluster #36697 streaming tail race, #36527 event-queue
 * saturation, #36750 app-server deadlock; plausible cause #34777, which IS in
 * 0.146.0). No fix exists even in 0.147.0-alpha.4. For a PTY wrapper the whole
 * failure is invisible: the process just goes away, Sonata retires the runtime,
 * and the task quietly turns dormant wearing the same face as a session the user
 * closed on purpose. The one thing that survives is the ROLLOUT FILE — the
 * conversation is intact and `codex resume <session-id>` brings it back.
 *
 * WHAT THIS CLASSIFIES — and what it deliberately does NOT. This is a claim
 * about RECOVERABILITY, not about the cause of death. Sonata cannot know why
 * codex vanished (that is the defining property of a silent exit), and inventing
 * a taxonomy it cannot observe would be dishonest. What it CAN establish is
 * whether the affordance it is about to offer is true:
 *
 *   "the codex session ended; the conversation is intact — resume?"
 *
 * Each clause needs one ingredient, and all three must be present:
 *   - "codex"     → the provider (claude's exit paths are byte-identical and out
 *                   of scope; claude carries no such upstream defect).
 *   - "ended"     → and ended without Sonata asking. Every Sonata-initiated death
 *                   (task close, app teardown, respawn) routes through
 *                   `TerminalHost.disposeProcess`, which stamps the exit; an
 *                   unstamped exit came from outside Sonata's own lifecycle.
 *   - "intact —   → a resumable session id. NOT any id we ever saw: the id
 *      resume?"     `openTask` will actually pass to `codex resume`, read through
 *                   the same persisted-sources path (which drops sources whose
 *                   rollout file is gone). If the caller cannot name that id, the
 *                   offer would be a lie.
 *
 * WHY THE CLAIM STOPS AT "ended" AND NOT "ended UNEXPECTEDLY". Outside-Sonata is
 * NOT the same as unintended. Three reachable paths end a codex session
 * deliberately and leave exactly this fingerprint: `/quit` typed in Sonata's own
 * composer, `/quit` or Ctrl-D in the co-visible CLI, and answering "No, quit" on
 * a reopened task's trust dialog. None is distinguishable here — the exit CODE is
 * dead as a discriminator (a SIGKILL'd codex reports 0 through node-pty, and a
 * graceful quit reports 0 too), and no other honest signal is wired today. So the
 * copy this verdict drives must be true in BOTH worlds. It says what happened
 * (the session ended, the conversation survived) and not why, which is the only
 * thing Sonata can currently stand behind. Codex's `SessionEnd` hook is the
 * candidate discriminator — it plausibly fires on a graceful teardown and not on
 * a silent death — but that is an UNVERIFIED hypothesis needing its own probe;
 * until it is measured, this classifier claims nothing about intent.
 *
 * DELIBERATELY ABSENT: a timing window. #36005's signature is "right after the
 * final agent message", but Sonata has never MEASURED that window — this is a
 * defensive slice built on field reports, not on a probe. A constant like
 * `RESUMABLE_EXIT_WINDOW_MS` would be a speculative bet that also EXCLUDES
 * genuinely recoverable deaths (an exit 30s later is just as resumable) while
 * buying nothing: the offer is correct either way. `midTurn` is recorded instead
 * — it is free (the exit event already carries the in-flight run id) and it is
 * load-bearing for honest copy, since a mid-stream death loses the answer the
 * user was waiting for while an after-turn death loses nothing.
 *
 * CONSERVATIVE BY CONSTRUCTION: every missing ingredient falls through to
 * `generic`, i.e. the pre-existing exit handling (retire the runtime, the task
 * goes dormant). A crash is never dressed up as benign — the copy reports the
 * end and the loss, neither softening nor embellishing — and a crash we cannot
 * resume is never offered a resume.
 */

export interface CodexSessionExitInput {
  /** The task's provider. Only `codex` can classify resumable (see above). */
  provider: RuntimeProvider;
  /** True when Sonata tore this PTY down itself (`TerminalHost.disposeProcess`:
   *  task close, app teardown, or a respawn's pre-spawn dispose). */
  sonataInitiated: boolean;
  /** The session id `codex resume <id>` would target for this task — the SAME
   *  value the reopen path computes (last persisted transcript source whose
   *  rollout file still exists). Null when nothing is resumable. */
  resumableSessionId: string | null;
  /** True when a run was still in flight at exit — the exit cut a turn short and
   *  the in-flight answer is lost. Read from the exit event's `runId`. */
  midTurn: boolean;
}

export type CodexSessionExit =
  | {
      kind: "resumable";
      /** The id to hand `codex resume`. */
      sessionId: string;
      /** The exit interrupted a turn in flight (drives honest copy). */
      midTurn: boolean;
    }
  | {
      kind: "generic";
      /** Which ingredient was missing — the first one checked, so the reason is
       *  a stable single value rather than a set. Diagnostic only; every
       *  `generic` verdict takes the same (pre-existing) code path. */
      reason: "not-codex" | "sonata-initiated" | "no-resumable-session";
    };

/**
 * Classify a PTY exit as a recoverable codex session end or a generic one.
 * Pure — the caller supplies every ingredient and owns the surfacing.
 */
export function classifyCodexSessionExit(input: CodexSessionExitInput): CodexSessionExit {
  if (input.provider !== "codex") {
    return { kind: "generic", reason: "not-codex" };
  }
  if (input.sonataInitiated) {
    return { kind: "generic", reason: "sonata-initiated" };
  }
  // A blank/whitespace id is as unusable as a missing one — `codex resume ""`
  // would fall through to the interactive picker, which a PTY wrapper cannot
  // drive. Treat it as absent rather than offering a resume that opens a menu.
  const sessionId = input.resumableSessionId?.trim();
  if (!sessionId) {
    return { kind: "generic", reason: "no-resumable-session" };
  }
  return { kind: "resumable", sessionId, midTurn: input.midTurn };
}
