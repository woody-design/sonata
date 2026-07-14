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

export function renderAttentionBanners(view = activeTaskView(state)): void {
  const root = elements.attentionBannerRoot;
  const banners: HTMLElement[] = [];
  if (view?.task) {
    if (view.approvalExpiredAttention) {
      banners.push(
        attentionBanner("approval-expired", "Approval waiting for you in the CLI", () => {
          actions.dismissApprovalExpiredAttention(view);
        }),
      );
    }
    if (view.slashAttention) {
      banners.push(
        attentionBanner("slash-sent", `${view.slashAttention.command} ran in the CLI`, () => {
          actions.dismissSlashAttention(view);
        }),
      );
    }
    // Codex's injected hooks never handshook within the spawn window — they are
    // not running. Since Duet passes `--dangerously-bypass-hook-trust` on every
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
