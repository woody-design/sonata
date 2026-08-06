import {
  isCliProviderUnhealthy,
  type CliProviderReadiness,
} from "../../shared/types/cli-readiness";
import type { CliSetupRun } from "../../shared/types/cli-setup-run";
import type { RuntimeProvider } from "../../shared/types/domain";
import { activeTaskView, type RendererState } from "../state";

/**
 * The New Chat readiness card, decided as data (CLI readiness S2; plan D6, D8,
 * D9, L1).
 *
 * The card states one fact about ONE provider — the one the draft is preselected
 * on — and offers the action that fixes it. Everything perception-sensitive about
 * it lives here rather than in the view, because "which card, on which facts" is
 * the part that can be wrong in a way a screenshot will not reveal: the whole
 * matrix is a pure function of (draft provider × facts × live setup run), fenced
 * row by row.
 *
 * Three rules carry the design.
 *
 * **`unknown` shows nothing.** The gate is {@link isCliProviderUnhealthy}, which
 * is true for exactly `absent` and `signedOut`. A provider we could not read is a
 * provider we must not accuse (D3): the pty spawn is the final truth, and a false
 * alarm costs more than a silent false negative.
 *
 * **Healthy wins over any run outcome.** The gate runs FIRST, so a failed install
 * for a provider that is nonetheless present shows nothing at all — there is
 * nothing left to fix, and a "didn't finish" card over a working CLI would be a
 * lie with a button on it.
 *
 * **The card never proposes switching provider (D6).** It carries no provider
 * picker, no "try Codex instead". The composer's own provider chip stays live
 * beside it, so switching is one click away in the place the user already knows —
 * and switching to a healthy provider makes this function return null, which is
 * how the card yields and the composer comes back.
 */

export type CliReadinessCardKind =
  | "both-absent"
  | "absent"
  | "installing"
  | "install-failed"
  | "signed-out";

export type CliReadinessCardActionKind = "install" | "install-retry" | "start";

export interface CliReadinessCardAction {
  readonly kind: CliReadinessCardActionKind;
  readonly provider: RuntimeProvider;
  readonly label: string;
  /** Stable DOM id — the fences and the screenshot harness address these. */
  readonly domId: string;
}

export interface CliReadinessCardModel {
  readonly kind: CliReadinessCardKind;
  /** The provider the card is ABOUT. Usually the draft's preselected provider;
   *  for a live run it is the run's, since a run in flight is the more immediate
   *  fact (see the run branch below). */
  readonly provider: RuntimeProvider;
  readonly copy: string;
  readonly actions: readonly CliReadinessCardAction[];
}

/**
 * The CLI's own name, as the user knows it from its docs and its prompt. Two
 * vocabularies on purpose, and the difference is not cosmetic: the CLI NAME
 * ("Claude Code CLI") is what is or is not installed on the machine, while the
 * PRODUCT name ("Claude Code") is what is being installed — "Installing Claude
 * Code CLI CLI" is what a single vocabulary would eventually produce.
 */
function cliName(provider: RuntimeProvider): string {
  return provider === "claude" ? "Claude Code CLI" : "Codex CLI";
}

function productName(provider: RuntimeProvider): string {
  return provider === "claude" ? "Claude Code" : "Codex";
}

function installAction(provider: RuntimeProvider): CliReadinessCardAction {
  return {
    kind: "install",
    provider,
    label: `Install ${cliName(provider)}`,
    domId: `cli-readiness-install-${provider}`,
  };
}

function retryAction(provider: RuntimeProvider): CliReadinessCardAction {
  return {
    kind: "install-retry",
    provider,
    label: "Try again",
    domId: "cli-readiness-retry",
  };
}

function startAction(provider: RuntimeProvider): CliReadinessCardAction {
  return {
    kind: "start",
    provider,
    label: `Start ${cliName(provider)}`,
    domId: "cli-readiness-start",
  };
}

/**
 * The signed-out statement (D8). `actionable` is false while that provider's CLI
 * is ALREADY running in the CLI window: the sentence still holds — finish the
 * setup over there — but offering to start a second copy of a CLI that is on
 * screen waiting for input would be an invitation to make a mess. The copy is not
 * re-written for that case; a button is simply absent, which is the subtraction
 * the house prefers over a second sentence.
 */
function signedOutCard(provider: RuntimeProvider, actionable: boolean): CliReadinessCardModel {
  // Claude calls it "first-run setup" (theme, then login); Codex just "setup".
  // Verbatim per D8 — each is that CLI's own vocabulary for its own screen.
  const copy =
    provider === "claude"
      ? "Claude Code CLI isn't signed in. Finish its first-run setup in the terminal window."
      : "Codex CLI isn't signed in. Finish its setup in the terminal window.";
  return {
    kind: "signed-out",
    provider,
    copy,
    actions: actionable ? [startAction(provider)] : [],
  };
}

/**
 * The card for the current state, or null for "no card, normal composer".
 *
 * Pure. Reads only the draft's provider, the readiness facts, the live setup run,
 * and whether a task is open.
 */
export function cliReadinessCard(state: RendererState): CliReadinessCardModel | null {
  // New Chat only (D9). Every other surface — an open session, its history, the
  // sidebar, settings — is untouched by this slice; an old chat that hits the same
  // wall is the banner family's job (D10).
  if (activeTaskView(state)?.task) {
    return null;
  }

  const provider = state.taskDraft.provider;
  const fact: CliProviderReadiness = state.cliReadiness[provider];
  if (!isCliProviderUnhealthy(fact)) {
    return null;
  }

  // A LIVE run is narrated whichever provider it belongs to: the user just asked
  // for it and the CLI window came forward, so "Installing Codex…" is the truest
  // thing the card can say even while the draft sits on Claude. A FINISHED
  // failure is instead a fact ABOUT a provider, so it only speaks on that
  // provider's card — otherwise a failed Codex attempt would occupy Claude's
  // card and hide Claude's own install button behind an unrelated "Try again".
  const run = state.cliSetupRun;
  if (run && (run.phase === "running" || run.provider === provider)) {
    const card = runCard(run);
    if (card) {
      return card;
    }
  }

  if (fact.install === "absent") {
    // absent > signedOut (D9's priority), and the probe cannot even produce both:
    // it only asks about auth over a binary it found.
    return absentCard(state, provider);
  }
  return signedOutCard(provider, true);
}

/** The composer's send path is closed exactly while a card is showing — every
 *  card means "this provider cannot serve a session right now", so a prompt
 *  submitted here would queue into a CLI that will never boot. That silent queue
 *  is the bug this whole program replaces, so the gate is the card's presence
 *  itself rather than a second, separately-drifting condition. */
export function cliReadinessBlocksSend(state: RendererState): boolean {
  return cliReadinessCard(state) !== null;
}

function runCard(run: CliSetupRun): CliReadinessCardModel | null {
  if (run.kind === "install") {
    if (run.phase === "running") {
      return {
        kind: "installing",
        provider: run.provider,
        copy: `Installing ${productName(run.provider)} — follow along in the terminal window.`,
        actions: [],
      };
    }
    return {
      kind: "install-failed",
      provider: run.provider,
      // Deliberately says nothing about WHY: Sonata does not read the installer's
      // output (L7), so any diagnosis here would be invented. It points at the
      // window where the real output is.
      copy: "Installation didn't finish — check the output in the terminal window.",
      actions: [retryAction(run.provider)],
    };
  }
  if (run.phase === "running") {
    return signedOutCard(run.provider, false);
  }
  // A `start` run never reaches a terminal phase (it clears instead), so this is
  // unreachable by construction — returning null rather than inventing a card
  // keeps the function total without pretending the state means something.
  return null;
}

/**
 * Absent, in two variants. Both-absent (D8's opening state) is a genuinely
 * different sentence and a genuinely different choice — a machine with no CLI at
 * all has no preselection worth honouring yet, so it offers both installs. One
 * absent (L1) names only the one that is missing: the other provider works, and
 * the user can reach it through the composer's chip whenever they want.
 */
function absentCard(state: RendererState, provider: RuntimeProvider): CliReadinessCardModel {
  const other: RuntimeProvider = provider === "claude" ? "codex" : "claude";
  if (state.cliReadiness[other].install === "absent") {
    return {
      kind: "both-absent",
      provider,
      copy: "Claude Code CLI or Codex CLI not installed.",
      // Claude first regardless of the draft: this is a fixed pair of choices,
      // not a statement about the draft, and a pair that reorders itself under
      // the user is a pair they have to re-read.
      actions: [installAction("claude"), installAction("codex")],
    };
  }
  return {
    kind: "absent",
    provider,
    copy: `${cliName(provider)} not installed.`,
    actions: [installAction(provider)],
  };
}
