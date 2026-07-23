// ——— Attention banners (S5) ——————————————————————————————————————————————
// One family: passive "in the Terminal" pointers (contract §2 — every
// interaction homed in the Terminal owes Reading a banner). Display-only by
// design: a banner never drives delivery, runs, or approvals; clicking
// focuses the terminal window through the single choke point, dismissing
// only clears the pointer. The third family member — the multiSelect
// option-prompt's "Answer in terminal" — stays inside its card (the card is
// the stronger attention surface) and shares the family's action style.
//
// (map §3.1 renderer/view/banners.ts, D3 — moved verbatim from main.ts.
// State reads via the init-bound atom reference; the dismiss handlers' bare
// assignments are grammar and route through the actions seam — C3 ruling.)

import {
  activeTaskView,
  type RendererState,
} from "../../reading-core/state";
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
  }
  root.replaceChildren(...banners);
}

function attentionBanner(kind: string, copy: string, onDismiss: () => void): HTMLElement {
  const banner = document.createElement("div");
  banner.className = "attention-banner";
  banner.dataset.kind = kind;
  const text = document.createElement("span");
  text.className = "attention-banner-copy";
  text.textContent = copy;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "attention-open-terminal";
  open.textContent = "Open CLI →";
  open.addEventListener("click", () => {
    actions.setViewMode("terminal");
  });
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "attention-banner-dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "✕";
  dismiss.addEventListener("click", onDismiss);
  banner.append(text, open, dismiss);
  return banner;
}
