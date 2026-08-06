import {
  isCliProviderUnhealthy,
  type CliSessionStartBlockReason,
} from "../../shared/types/cli-readiness";
import type { RuntimeProvider } from "../../shared/types/domain";
import type { RendererState, TaskViewState } from "../state";
import {
  cliNotInstalledCopy,
  cliSignedOutCopy,
  installActionLabel,
  startActionLabel,
} from "./cli-readiness-card";

/**
 * The existing-chat readiness banner, decided as data (CLI readiness S4; plan
 * D10, L5).
 *
 * The New Chat card and this banner are the SAME fact at two mount points (D10).
 * The difference is only what the user was doing when they met it: the card is
 * pre-task ("this machine cannot start a conversation yet"), while this is
 * task-keyed ("the conversation you are in tried to start and could not"). So the
 * copy is shared verbatim from the card's vocabulary and only the presence rule
 * differs — and the presence rule is where all the design is.
 *
 * Three conditions, and each one is load-bearing:
 *
 * 1. **A diagnosis happened.** `state.cliSessionStartBlocked` is written only by
 *    main, only after a re-probe, only for a session that demonstrably failed to
 *    reach a prompt. Unhealthy FACTS alone are not enough: a machine can be signed
 *    out of Codex all week while the user works happily in Claude, and every one of
 *    their Claude sessions would otherwise wear a banner about a CLI they never
 *    asked for.
 * 2. **The facts still say so.** Read live, so the banner HEALS: the user clicks
 *    the action, finishes the CLI's own setup, the setup pty exits, S2's re-probe
 *    turns the facts green — and this returns null with nobody having to clear
 *    anything. The same "healthy wins" rule the card applies, for the same reason.
 * 3. **This provider.** The task is provider-locked, so the task decides which CLI
 *    the sentence is about. A stale diagnosis on a task whose provider is fine
 *    cannot speak.
 *
 * What this deliberately does NOT do is gate SEND, which is the one place it
 * diverges from its New Chat twin. See {@link cliReadinessBanner} for why.
 */
export interface CliReadinessBannerAction {
  /** Which S2 seam member to call — `installCli` or `startCliLogin`. */
  readonly kind: "install" | "start";
  readonly provider: RuntimeProvider;
  readonly label: string;
}

export interface CliReadinessBannerModel {
  readonly provider: RuntimeProvider;
  readonly reason: CliSessionStartBlockReason;
  readonly copy: string;
  /**
   * The CLI's own recovery, through S2's actions verbatim (install / start) — or
   * null, which means the family's ordinary "Open CLI →" pointer instead.
   *
   * Null in two cases, and both are the same rule: **never offer to start a second
   * copy of a CLI that is already on screen waiting for input.**
   *
   * 1. A setup command for this provider is already RUNNING in the CLI window.
   * 2. `signedOut` on a session whose own PTY is still LIVE. This is the important
   *    one, and it is where the first implementation was wrong. A live signed-out
   *    diagnosis comes from the boot observation window, which means precisely that
   *    this task's own CLI is up and parked on its first-run screen — so the login
   *    the copy asks for is already open, in the very window the copy points at.
   *    Offering "Start Claude Code CLI" there spawns an INDEPENDENT pty whose grid
   *    hides the task's own, and finishing the login in that copy is the worst
   *    outcome available: the machine facts go green, this banner retires on them,
   *    and the task's own PTY stays parked forever — so the composer falls back to
   *    "…is starting, your message will send when it's ready" over a session that
   *    never will, with the prompt still held in the queue. The eternal pin, rebuilt
   *    by its own cure.
   *
   * The pointer is the right degradation rather than a coincidence of the factory:
   * the sentence says "finish its setup in the terminal window", the login screen IS
   * in that window, and finishing it there genuinely heals (the CLI paints its
   * composer, `acceptsPromptInput()` turns true, the delivery pump latches and the
   * queued prompt goes out).
   *
   * A DEAD pty keeps the Start button: there is nothing to point at, so a fresh
   * spawn is the only door. `view.live` is the discriminator; it lags a PTY that
   * died on its own (the session-index refresh clears it — see the S4 record's
   * out-of-scope 2), and the lag's direction is benign: at worst a pointer where a
   * button was due, for as long as it takes the next attempt to say so again.
   */
  readonly action: CliReadinessBannerAction | null;
}

/**
 * The banner for this view, or null for "nothing to say".
 *
 * Pure. Reads the diagnosis register, the readiness facts, the live setup run, and
 * the view's task.
 *
 * **Send is not gated here** (and the card gates it). Not an oversight — the two
 * sends do different things. A New Chat send CREATES a session, so sending onto a
 * dead provider manufactures a ghost conversation that can never boot; that is the
 * silent-queue wound this program exists to close. An existing chat's send goes
 * into a conversation that already exists, and both shapes of failure leave it
 * honest: with the CLI absent the pty is gone, so the session is dormant and the
 * send is a RESUME the user may well want to retry — blocking it would take away
 * the retry; with the CLI signed out the pty is alive and the delivery queue holds
 * the prompt until the boot latch opens, which is what finishing the login **in
 * this task's own PTY** does. (It is NOT what finishing a login in a second,
 * independent copy of the CLI does — that leaves this session's pty parked and its
 * prompt held, which is exactly why the action degrades to a pointer in that state;
 * see `action` above.) Nothing is lost either way, so the banner states the fact and
 * leaves the composer alone.
 */
export function cliReadinessBanner(
  state: RendererState,
  view: TaskViewState | null,
): CliReadinessBannerModel | null {
  const task = view?.task;
  if (!task) {
    return null;
  }
  const reason = state.cliSessionStartBlocked[task.id];
  if (!reason) {
    return null;
  }
  const provider = task.provider;
  if (!isCliProviderUnhealthy(state.cliReadiness[provider])) {
    return null;
  }
  return {
    provider,
    reason,
    copy: reason === "absent" ? cliNotInstalledCopy(provider) : cliSignedOutCopy(provider),
    action: bannerAction(state, view, provider, reason),
  };
}

function bannerAction(
  state: RendererState,
  view: TaskViewState,
  provider: RuntimeProvider,
  reason: CliSessionStartBlockReason,
): CliReadinessBannerAction | null {
  const run = state.cliSetupRun;
  if (run && run.phase === "running" && run.provider === provider) {
    return null;
  }
  // The signed-out login this task is already sitting on. See `action`'s note: a
  // second copy would hide it and, once satisfied, strand this session for good.
  if (reason === "signedOut" && view.live) {
    return null;
  }
  return reason === "absent"
    ? { kind: "install", provider, label: installActionLabel(provider) }
    : { kind: "start", provider, label: startActionLabel(provider) };
}

/**
 * Is THIS SESSION still stuck before its first prompt (S4, review round 1)?
 *
 * The composer's honest state reads this, and NOT `cliReadinessBanner` as it first
 * did. The two are different questions and conflating them is what let the pin come
 * back:
 *
 * - the BANNER is a statement about the MACHINE, so it is gated on live facts and
 *   retires the moment the machine is fixed;
 * - the COMPOSER is a statement about THIS SESSION, and a session can still be
 *   parked on a screen it will never leave after the machine came good — a login
 *   finished elsewhere (a second copy of the CLI, or the user's own terminal) turns
 *   the facts green without moving this pty an inch.
 *
 * So: the diagnosis stands, AND at least one of the two things that can keep this
 * session from getting going is still true —
 *
 * - **the machine is still broken** (the banner's own condition), so any attempt
 *   fails; or
 * - **this session's PTY is still alive**, which after a diagnosis means it is the
 *   parked one. This is the disjunct that closes the hole: a login finished
 *   elsewhere turns the facts green without moving this pty an inch, and the
 *   composer must not go back to promising a boot for it.
 *
 * Both directions matter, and dropping either one is a lie. Without the second, a
 * healed machine restores the pin over a session that is still parked. Without the
 * first, an install that fixes a DORMANT session's provider would leave "can't start
 * yet" over a conversation that now resumes perfectly well.
 *
 * The register's own lifecycle carries the rest: it is cleared when this task
 * reaches a prompt (its boot latch opening) and when it starts a fresh session. "A
 * session that got to a prompt is not a session that failed to start" is one rule
 * serving both surfaces, and it is what retires a diagnosis that was true-but-wrong
 * about THIS session — the env-API-key case, where `auth status` reports signed out
 * while the CLI runs fine on `ANTHROPIC_API_KEY`: the session latches, the register
 * clears, and both this and the banner go quiet with nobody re-probing. (That is
 * why neither term re-checks `bootLatched`: a latched session has no register.)
 */
export function cliSessionStartStalled(
  state: RendererState,
  view: TaskViewState | null,
): boolean {
  const task = view?.task;
  if (!task || !state.cliSessionStartBlocked[task.id]) {
    return false;
  }
  return isCliProviderUnhealthy(state.cliReadiness[task.provider]) || view?.live === true;
}
