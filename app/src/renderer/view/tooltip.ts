// Shared hover tooltip (2026-07-16): one singleton pill + document-level
// delegation on [data-tooltip]. Replaces native `title` on the chrome buttons —
// title is slow (~1.5s), unstylable, and platform-inconsistent. The bubble is
// fixed-position on the viewport and appended to <body>, so no ancestor
// overflow/clip can swallow it (the lesson from the run-list popover). Copy
// lives in the attribute; dynamic states just rewrite dataset.tooltip.

const SHOW_DELAY_MS = 500;
// Moving between neighboring tooltipped controls keeps the tooltip "warm":
// within this window the next one shows immediately (menu-bar idiom).
const WARM_WINDOW_MS = 250;
const VIEWPORT_PAD = 8;
const ANCHOR_GAP = 6;

let bubble: HTMLDivElement | null = null;
let anchor: HTMLElement | null = null;
let pending: HTMLElement | null = null;
let showTimer: number | undefined;
let hiddenAt = 0;

function ensureBubble(): HTMLDivElement {
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.className = "app-tooltip";
    bubble.setAttribute("role", "tooltip");
    document.body.append(bubble);
  }
  return bubble;
}

function show(target: HTMLElement): void {
  const text = target.dataset.tooltip;
  if (!text) {
    return;
  }
  anchor = target;
  pending = null;
  const el = ensureBubble();
  el.textContent = text;
  el.classList.add("visible");
  const rect = target.getBoundingClientRect();
  const left = Math.min(
    window.innerWidth - el.offsetWidth - VIEWPORT_PAD,
    Math.max(VIEWPORT_PAD, rect.left + rect.width / 2 - el.offsetWidth / 2),
  );
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(rect.bottom + ANCHOR_GAP)}px`;
}

function hide(): void {
  if (showTimer !== undefined) {
    window.clearTimeout(showTimer);
    showTimer = undefined;
  }
  if (anchor) {
    hiddenAt = Date.now();
  }
  anchor = null;
  pending = null;
  bubble?.classList.remove("visible");
}

export function initTooltips(): void {
  document.addEventListener("pointerover", (event) => {
    const target = (event.target as Element | null)?.closest?.("[data-tooltip]");
    if (target instanceof HTMLElement) {
      if (target === anchor || target === pending) {
        return;
      }
      const warm = anchor !== null || Date.now() - hiddenAt <= WARM_WINDOW_MS;
      hide();
      if (warm) {
        show(target);
        return;
      }
      pending = target;
      showTimer = window.setTimeout(() => {
        showTimer = undefined;
        if (pending) {
          show(pending);
        }
      }, SHOW_DELAY_MS);
    } else if (anchor || pending) {
      hide();
    }
  });
  // Any press, scroll, or focus loss dismisses immediately — a tooltip must
  // never sit over the popover the click just opened.
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
}
