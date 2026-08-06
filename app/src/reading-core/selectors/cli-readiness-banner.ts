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
   * The CLI's own recovery, through S2's actions verbatim (install / start).
   *
   * Null while the CLI window is ALREADY running a setup command for this provider:
   * offering to start a second copy of a CLI that is on screen waiting for input is
   * a mess, not a fix. The New Chat card answers that state by showing no button at
   * all; the banner instead falls back to the family's own "Open CLI →" pointer,
   * which is what a null action means to `attentionBanner`. That is the better
   * degradation here rather than a coincidence of the factory: the sentence says
   * "finish its setup in the terminal window", so pointing at that window is the
   * one thing left worth offering — and the family's baseline behaviour is exactly
   * that pointer.
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
 * the prompt until the boot latch opens, which is precisely what finishing the
 * login in the CLI window does. Nothing is lost either way, so the banner states
 * the fact and leaves the composer alone.
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
    action: bannerAction(state, provider, reason),
  };
}

function bannerAction(
  state: RendererState,
  provider: RuntimeProvider,
  reason: CliSessionStartBlockReason,
): CliReadinessBannerAction | null {
  const run = state.cliSetupRun;
  if (run && run.phase === "running" && run.provider === provider) {
    return null;
  }
  return reason === "absent"
    ? { kind: "install", provider, label: installActionLabel(provider) }
    : { kind: "start", provider, label: startActionLabel(provider) };
}
