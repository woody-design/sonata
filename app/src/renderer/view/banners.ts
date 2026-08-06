// ——— Attention banners (S5) ——————————————————————————————————————————————
// One family: passive "in the Terminal" pointers (contract §2 — every
// interaction homed in the Terminal owes Reading a banner). Display-only by
// design: a banner never drives delivery, runs, or approvals; clicking
// focuses the terminal window through the single choke point, dismissing
// only clears the pointer. The third family member — the multiSelect
// option-prompt's "Answer in terminal" — stays inside its card (the card is
// the stronger attention surface) and shares the family's action style.
//
// ONE DECLARED EXCEPTION (SL-6, upstream sync 2026-08-03): the codex
// resumable-exit banner carries a RESUME action instead of the "Open CLI →"
// pointer. The family's contract rests on a premise that fails for exactly this
// member — "the interaction is homed in the Terminal" — because there IS no
// Terminal any more: the CLI process is dead, and pointing at a dead surface
// tells the user nothing. The exception is deliberately narrow: it is still one
// click, still a user action (Sonata never respawns on its own), and it routes
// through the same seam the CLI window's own "Resume task" button uses rather
// than opening a second lifecycle path.
//
// A SECOND DECLARED EXCEPTION (CLI readiness S4, 2026-08-05): the
// cli-session-start banner replaces the "Open CLI →" pointer with a RECOVERY —
// and for the mirror image of the reason above. Here the CLI is not dead, it is
// not THERE (absent) or not usable yet (signed out), so the pointer would point
// at an empty grid. The recovery instead opens that window ON a running command
// — the CLI's own installer, or the CLI itself landing on its own first-run
// screen — which is the only thing Sonata is allowed to do about either fact
// (D1: no credential handling, ever), and it reuses S2's seam verbatim, so this
// adds no lifecycle path of its own. Narrower than it looks: once that command
// IS running, the recovery withdraws and the member falls back to the family's
// ordinary pointer, which by then is the truest thing left to offer.
//
// (map §3.1 renderer/view/banners.ts, D3 — moved verbatim from main.ts.
// State reads via the init-bound atom reference; the dismiss handlers' bare
// assignments are grammar and route through the actions seam — C3 ruling.)

import {
  activeTaskView,
  clearCliSessionStartBlocked,
  type RendererState,
} from "../../reading-core/state";
import { cliReadinessBanner } from "../../reading-core/selectors/cli-readiness-banner";
import { elements } from "../dom";
import { actions } from "../actions";

/** The shell's state atom, bound once at boot for the family's read paths. */
let state: RendererState;

export function initBannersView(stateRef: RendererState): void {
  state = stateRef;
}

/**
 * Codex hooks-liveness banner state (S2). Renderer-LOCAL by design: hook
 * liveness is shell chrome, not reading content, so it never becomes a
 * reading-core view field (which the reducer owns + the crown fence pins).
 * Keyed by taskId so a background task's missing-handshake is remembered and
 * shown when it becomes active. Fed by main.ts from the `cli-hooks:liveness`
 * runtime event.
 */
const codexHooksMissing = new Set<string>();

export function setCodexHooksMissing(taskId: string, missing: boolean): void {
  if (missing) {
    codexHooksMissing.add(taskId);
  } else {
    codexHooksMissing.delete(taskId);
  }
}

/**
 * Codex boot "Update available!" gate state (S4). Renderer-LOCAL, same family as
 * codexHooksMissing: the gate is shell chrome (a terminal-homed interaction owes
 * Reading a passive banner), never a reading-core view field. Keyed by taskId so
 * a background session's stuck boot is remembered and shown when it becomes
 * active; fed by main.ts from the `codex-update-prompt:detected` runtime event
 * and cleared on that task's `pty:exit` (a fresh session re-detects if still
 * stuck).
 */
const codexUpdatePrompt = new Set<string>();

export function setCodexUpdatePrompt(taskId: string, blocked: boolean): void {
  if (blocked) {
    codexUpdatePrompt.add(taskId);
  } else {
    codexUpdatePrompt.delete(taskId);
  }
}

/**
 * A codex session died without Sonata killing it and its conversation can be
 * resumed (SL-6 — the openai/codex #36005 silent-exit class). Renderer-LOCAL,
 * same family as the two above. The value is the honest detail the copy needs:
 * `true` when the exit cut a turn short (the answer in flight is lost).
 *
 * Set from the `codex-session-exit:resumable` runtime event and cleared when the
 * task starts a session again (`task:started`) or when the user dismisses. NOT
 * cleared on `pty:exit` like its update-prompt sibling — `pty:exit` is the very
 * event that produces this state.
 *
 * It must also SURVIVE a switch-away, where its siblings need not: they re-detect
 * on the next spawn, while this one never can — the session it names is dead, so
 * no future event re-raises it. It does survive, because `clearTaskBanners` fires
 * on a switch-away only for a view `evictDormantTaskView` actually drops, and a
 * task that reached this state was necessarily LIVE in this renderer session,
 * whose delivery pump emits `delivery:state` on every runtime event — so that
 * function's `deliveryState !== null` cue holds the view. Incidental rather than
 * designed; noted so a change to that cue is read as touching this banner too.
 * (The removal path — archive/delete — clears it, which is right: the task is
 * gone and there is nothing left to resume.)
 */
const codexResumableExit = new Map<string, { midTurn: boolean }>();

export function setCodexResumableExit(taskId: string, midTurn: boolean): void {
  codexResumableExit.set(taskId, { midTurn });
}

export function clearCodexResumableExit(taskId: string): void {
  codexResumableExit.delete(taskId);
}

/**
 * Tasks whose S4 session-start banner the user has closed. Renderer-LOCAL, the same
 * species as the three stores above — and deliberately NOT the same thing as the
 * diagnosis itself, which lives in the state atom because the composer reads it.
 *
 * That split is the whole point. The diagnosis is a fact about the machine; the
 * dismissal is a fact about this banner. Folding them together would mean closing
 * the notice sent the composer back to "your message will send when it's ready" over
 * a CLI that cannot start — the exact promise this slice removes. So a dismissal
 * hides the banner and changes nothing else.
 *
 * Cleared by a FRESH diagnosis (a new failed attempt is a new statement, and a
 * once-closed banner must not be silenced forever) and by the removed-task sweep.
 */
const cliSessionStartDismissed = new Set<string>();

/** A new diagnosis landed for this task — any earlier dismissal is spent. */
export function noteCliSessionStartDiagnosis(taskId: string): void {
  cliSessionStartDismissed.delete(taskId);
}

/** Forget a task's renderer-local banner flags (OBS S8, F10). The stores are
 *  keyed by taskId; a task removed (archive/delete) or evicted on switch-away
 *  without a self-clearing event (e.g. a hooks-missing task deleted before its
 *  `pty:exit`) would otherwise leave its id behind for the whole uptime. On a
 *  fresh spawn the liveness/update signals re-detect and re-populate, so
 *  clearing is transparent. */
export function clearTaskBanners(taskId: string): void {
  codexHooksMissing.delete(taskId);
  codexUpdatePrompt.delete(taskId);
  codexResumableExit.delete(taskId);
  cliSessionStartDismissed.delete(taskId);
  // The S4 diagnosis lives in the state atom rather than a store up here (see the
  // field's own note: the composer reads it too), but it is task-keyed banner state
  // like the others and belongs to the same sweep — one function, so a removed task
  // cannot leave any of the five behind.
  clearCliSessionStartBlocked(state, taskId);
}

export function renderAttentionBanners(view = activeTaskView(state)): void {
  const root = elements.attentionBannerRoot;
  const banners: HTMLElement[] = [];
  if (view?.task) {
    // (approval-expired banner retired in drawer S2 — the action drawer's
    // expired variant carries that state in place.)
    if (view.slashAttention) {
      banners.push(
        attentionBanner("slash-sent", `${view.slashAttention.command} ran in the CLI`, () => {
          actions.dismissSlashAttention(view);
        }),
      );
    }
    // Mid-session control-switch needs-attention (RED LINE): the drive couldn't
    // confirm the target and the screen is in an unrecognized state — model/effort
    // (S1): the injected command earned no receipt (a possible cache-miss confirm
    // / consent interstitial); permission (S2): the Shift+Tab stepping aborted and
    // returned home, or landed where the hook SSOT must reconcile;
    // codex-permission (S3): the `/permissions` picker choreography rolled back
    // with an Esc (an unexpected screen / timeout). Sonata does nothing further —
    // a passive pointer to the CLI, where the user resolves it.
    if (view.controlSwitch?.phase === "needs-attention") {
      const kind = view.controlSwitch.kind;
      const axis =
        kind === "model" || kind === "codex-model"
          ? "model"
          : kind === "effort" || kind === "codex-effort"
            ? "reasoning"
            : "access";
      // A known cause (S5) names the exact next action; otherwise the generic
      // fallback. `interstitial` — the CLI is showing the cache-miss/consent
      // handoff the user answers natively (the DEFAULT claude flow on a session
      // with history). `consent` — codex's Full Access grant is the human's to give
      // (RED LINE 2). `drift` — the codex model list moved upstream, so the switch
      // has to be made natively.
      const message =
        view.controlSwitch.reason === "interstitial"
          ? "Confirm the switch in the CLI"
          : view.controlSwitch.reason === "consent"
            ? "Confirm Full Access in the CLI"
            : view.controlSwitch.reason === "drift"
              ? "Model list changed upstream — switch in the CLI"
              : `Couldn't confirm the ${axis} switch — check the CLI`;
      banners.push(
        attentionBanner("control-switch", message, () => {
          actions.dismissControlSwitch(view);
        }),
      );
    }
    // Codex's injected hooks never handshook within the spawn window — they are
    // not running. Since Sonata passes `--dangerously-bypass-hook-trust` on every
    // codex spawn (D4 overturn: trust can't persist through a profile layer),
    // this is no longer a trust-ceremony gap — it means the hook shim itself
    // failed to fire (e.g. its interpreter isn't on PATH in a non-login launch).
    // The copy is user-facing, deliberately silent on hook internals; it points
    // at the Terminal because that's where the failure is visible. Dismiss clears
    // the renderer-local flag (not a view field, so handled here rather than
    // through the actions seam).
    if (codexHooksMissing.has(view.task.id)) {
      const taskId = view.task.id;
      banners.push(
        attentionBanner(
          "codex-hooks-liveness",
          "Codex hooks aren't running — check the CLI",
          () => {
            codexHooksMissing.delete(taskId);
            renderAttentionBanners();
          },
        ),
      );
    }
    // Codex's boot "Update available!" gate is blocking composer readiness (S4).
    // Sonata NEVER auto-answers it (running `brew upgrade` / pressing keys blind
    // is the user's call) — a passive pointer to the Terminal, where the gate is
    // visible and resolvable. Dismiss clears the renderer-local flag.
    if (codexUpdatePrompt.has(view.task.id)) {
      const taskId = view.task.id;
      banners.push(
        attentionBanner(
          "codex-update-prompt",
          "Codex needs an update to start — resolve it in the CLI",
          () => {
            codexUpdatePrompt.delete(taskId);
            renderAttentionBanners();
          },
        ),
      );
    }
    // Codex vanished on its own and the conversation survived in its rollout
    // (SL-6 — the #36005 silent-exit class: no stderr, no crash report, the task
    // simply turns dormant wearing the same face as a session the user closed).
    // The banner exists to make that death VISIBLE and to say the thing the user
    // most needs to hear: nothing was lost. Its action is the family's one
    // declared exception (see the header) — a resume, because there is no live
    // CLI left to point at.
    //
    // The headline says "ended", NOT "ended unexpectedly". Sonata cannot yet tell
    // a silent death from a deliberate quit — `/quit` in Sonata's composer,
    // `/quit` or Ctrl-D in the co-visible CLI, and "No, quit" on a reopened task's
    // trust dialog all leave the same fingerprint, and the exit code discriminates
    // nothing (a killed codex and a graceful one both report 0). "Unexpectedly"
    // would be a plain falsehood on those paths, so the copy states what Sonata
    // knows — the session ended, the conversation survived — and not why.
    // `midTurn` stays: "ended mid-turn" is true however the process died, and it
    // is the one thing the user cannot see for themselves (the conversation is
    // saved either way; the answer in flight is not).
    const resumableExit = codexResumableExit.get(view.task.id);
    if (resumableExit) {
      const taskId = view.task.id;
      banners.push(
        attentionBanner(
          "codex-resumable-exit",
          resumableExit.midTurn
            ? "Codex ended mid-turn — your conversation is saved"
            : "Codex ended — your conversation is saved",
          () => {
            codexResumableExit.delete(taskId);
            renderAttentionBanners();
          },
          {
            label: "Resume task →",
            onAct: () => {
              // Fire-and-forget through the seam, exactly as the CLI window's
              // "Resume task" button does: the flow revalidates selection and
              // liveness itself, and the resumed session's `task:started` clears
              // this banner.
              actions.resumeTask(taskId);
            },
          },
        ),
      );
    }
    // This session tried to start and could not, and the readiness probe named the
    // reason (S4 — plan D10: the same fact as the New Chat card, at the second
    // mount point). The whole model — whether to speak at all, which sentence,
    // which action — is the pure selector's; see its header for the three
    // conditions. Notably it needs no clearing path: it goes quiet by itself once
    // the machine is fixed, and again when a session actually starts.
    //
    // Dismissal is applied HERE rather than inside the selector, because the
    // selector answers "can this CLI start" and the COMPOSER asks it the same
    // question — an answer that changed because a notice was closed would send the
    // composer back to promising a boot (see `cliSessionStartDismissed`).
    const sessionStart = cliSessionStartDismissed.has(view.task.id)
      ? null
      : cliReadinessBanner(state, view);
    if (sessionStart) {
      const taskId = view.task.id;
      banners.push(
        attentionBanner(
          "cli-session-start",
          sessionStart.copy,
          () => {
            // Banner-local, like its three siblings' dismiss handlers: the composer's
            // copy is unchanged by this, so only the banners repaint.
            cliSessionStartDismissed.add(taskId);
            renderAttentionBanners();
          },
          // No action ⇒ the family's own "Open CLI →" pointer, which is the right
          // thing to say once the CLI is already running over there (see the
          // selector's note on `action`).
          sessionStart.action
            ? {
                label: sessionStart.action.label,
                onAct: () => {
                  // S2's seam, verbatim and fire-and-forget: main owns the pty,
                  // brings the CLI window forward, and pushes every phase back.
                  // Nothing optimistic happens here — including no dismissal: the
                  // banner yields when the FACTS turn green, which is the only
                  // authority on whether the recovery worked.
                  const action = sessionStart.action;
                  if (!action) {
                    return;
                  }
                  if (action.kind === "install") {
                    actions.installCli(action.provider);
                    return;
                  }
                  actions.startCliLogin(action.provider);
                },
              }
            : undefined,
        ),
      );
    }
  }
  root.replaceChildren(...banners);
}

/** The family's shared shape. `action` replaces the default "Open CLI →"
 *  pointer for the one member whose CLI is gone (SL-6). */
function attentionBanner(
  kind: string,
  copy: string,
  onDismiss: () => void,
  action?: { label: string; onAct: () => void },
): HTMLElement {
  const banner = document.createElement("div");
  banner.className = "attention-banner";
  banner.dataset.kind = kind;
  const text = document.createElement("span");
  text.className = "attention-banner-copy";
  text.textContent = copy;
  // One button slot, one style: the default is the family's CLI pointer, and the
  // SL-6 exception swaps what it says and does. The class stays put — the
  // affordance looks the same wherever it appears.
  const primary = document.createElement("button");
  primary.type = "button";
  primary.className = "attention-open-terminal";
  primary.textContent = action ? action.label : "Open CLI →";
  primary.addEventListener("click", () => {
    if (action) {
      action.onAct();
      return;
    }
    actions.setViewMode("terminal");
  });
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "attention-banner-dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "✕";
  dismiss.addEventListener("click", onDismiss);
  banner.append(text, primary, dismiss);
  return banner;
}
