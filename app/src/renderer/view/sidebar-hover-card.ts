import { Folder } from "lucide";
import {
  reduceSidebarHoverCard,
  type SidebarHoverCardEvent,
  type SidebarHoverCardState,
} from "../../reading-core/sidebar-hover-card";
import { sidebarHoverCardModel } from "../../reading-core/selectors/sidebar";
import { anchorRectOf, type RendererState } from "../../reading-core/state";
import { elements } from "../dom";
import { lucideIcon } from "./icons";
import { positionSidebarHoverCard } from "./popover-geometry";

interface SidebarHoverCardElements {
  card: HTMLDivElement;
  title: HTMLDivElement;
  time: HTMLTimeElement;
  folderLabel: HTMLSpanElement;
  tags: HTMLDivElement;
}

let state: RendererState;
let initialized = false;
let hoverState: SidebarHoverCardState = { kind: "idle" };
let stateTimer: number | null = null;
let cardElements: SidebarHoverCardElements | null = null;
let describedButton: HTMLButtonElement | null = null;
let pointer = { x: -1, y: -1 };
let reconcileQueued = false;

export function initSidebarHoverCard(stateRef: RendererState): void {
  state = stateRef;
  if (initialized) {
    return;
  }
  initialized = true;
  cardElements = createSidebarHoverCard();
  elements.sidebarHoverCardRoot.append(cardElements.card);

  elements.sidebarList.addEventListener("pointermove", (event) => {
    pointer = { x: event.clientX, y: event.clientY };
  });
  elements.sidebarList.addEventListener("pointerover", handlePointerOver);
  elements.sidebarList.addEventListener("pointerout", handlePointerOut);
  document.addEventListener("pointerdown", dismissSidebarHoverCard, true);
  document.addEventListener("dragstart", dismissSidebarHoverCard, true);
  (elements.sidebarList.parentElement ?? elements.sidebarList).addEventListener(
    "scroll",
    dismissSidebarHoverCard,
    { passive: true },
  );
  window.addEventListener("blur", dismissSidebarHoverCard);
  window.addEventListener("resize", repositionOpenSidebarHoverCard);

  new MutationObserver(queueSidebarHoverReconcile).observe(elements.sidebarList, {
    childList: true,
    subtree: true,
  });
  new MutationObserver(() => {
    if (elements.sidebarMenuRoot.childElementCount > 0) {
      dismissSidebarHoverCard();
    }
  }).observe(elements.sidebarMenuRoot, { childList: true });
}

export function dismissSidebarHoverCard(): void {
  transitionSidebarHoverCard({ type: "dismiss" });
}

function createSidebarHoverCard(): SidebarHoverCardElements {
  const card = document.createElement("div");
  card.id = "sidebar-hover-card";
  card.className = "sidebar-hover-card";
  card.hidden = true;
  card.setAttribute("role", "tooltip");

  const top = document.createElement("div");
  top.className = "sidebar-hover-card-top";
  const title = document.createElement("div");
  title.className = "sidebar-hover-card-title";
  const time = document.createElement("time");
  time.className = "sidebar-hover-card-time";
  top.append(title, time);

  const folder = document.createElement("div");
  folder.className = "sidebar-hover-card-folder";
  folder.append(lucideIcon(Folder, 14));
  const folderLabel = document.createElement("span");
  folderLabel.className = "sidebar-hover-card-folder-label";
  folder.append(folderLabel);

  const tags = document.createElement("div");
  tags.className = "sidebar-hover-card-tags";
  card.append(top, folder, tags);
  return { card, title, time, folderLabel, tags };
}

function handlePointerOver(event: PointerEvent): void {
  if (event.pointerType && event.pointerType !== "mouse") {
    return;
  }
  pointer = { x: event.clientX, y: event.clientY };
  const row = sessionRowFromTarget(event.target);
  if (!row || row === sessionRowFromTarget(event.relatedTarget)) {
    return;
  }
  const taskId = row.dataset.taskId;
  if (!taskId || !sidebarHoverCardEligible(taskId)) {
    dismissSidebarHoverCard();
    return;
  }
  transitionSidebarHoverCard({ type: "row-enter", taskId, now: performance.now() });
}

function handlePointerOut(event: PointerEvent): void {
  if (event.pointerType && event.pointerType !== "mouse") {
    return;
  }
  const row = sessionRowFromTarget(event.target);
  if (!row || row === sessionRowFromTarget(event.relatedTarget)) {
    return;
  }
  const nextRow = sessionRowFromTarget(event.relatedTarget);
  const nextTaskId = nextRow?.dataset.taskId;
  if (nextTaskId && sidebarHoverCardEligible(nextTaskId)) {
    // A direct row-to-row move is one open→open transition. The singleton card
    // never hides or detaches, so there is no second dwell or follow animation.
    transitionSidebarHoverCard({
      type: "row-enter",
      taskId: nextTaskId,
      now: performance.now(),
    });
    return;
  }
  transitionSidebarHoverCard({ type: "row-leave", now: performance.now() });
}

function transitionSidebarHoverCard(event: SidebarHoverCardEvent): void {
  const next = reduceSidebarHoverCard(hoverState, event);
  if (next === hoverState) {
    return;
  }
  hoverState = next;
  syncSidebarHoverCard();
}

function syncSidebarHoverCard(): void {
  clearStateTimer();
  if (hoverState.kind === "pending") {
    const delay = Math.max(0, hoverState.openAt - performance.now());
    stateTimer = window.setTimeout(() => {
      stateTimer = null;
      transitionSidebarHoverCard({ type: "timer", now: performance.now() });
    }, delay);
    hideSidebarHoverCard();
    return;
  }
  if (hoverState.kind === "warm") {
    const delay = Math.max(0, hoverState.until - performance.now());
    stateTimer = window.setTimeout(() => {
      stateTimer = null;
      transitionSidebarHoverCard({ type: "timer", now: performance.now() });
    }, delay);
    hideSidebarHoverCard();
    return;
  }
  if (hoverState.kind === "open" && showSidebarHoverCard(hoverState.taskId)) {
    return;
  }
  if (hoverState.kind === "open") {
    hoverState = { kind: "idle" };
  }
  hideSidebarHoverCard();
}

function showSidebarHoverCard(taskId: string): boolean {
  const view = cardElements;
  const row = sessionRowForTask(taskId);
  const model = sidebarHoverCardModel(state.sessionIndex, state.tagDefinitions, taskId);
  if (!view || !row || !model || !sidebarHoverCardEligible(taskId)) {
    return false;
  }
  view.card.dataset.taskId = taskId;
  view.title.textContent = model.title;
  view.time.textContent = model.relativeActivity;
  view.time.dateTime = model.lastActivityAt;
  view.time.setAttribute("aria-label", `Last active ${model.relativeActivity}`);
  view.folderLabel.textContent = model.folderLabel;
  view.tags.replaceChildren(
    ...model.tags.map((tag) => {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.dataset.tagColor = tag.color;
      chip.textContent = tag.label;
      return chip;
    }),
  );
  view.tags.hidden = model.tags.length === 0;
  view.card.hidden = false;
  setDescribedButton(row.querySelector<HTMLButtonElement>(".sidebar-session-button"));
  positionSidebarHoverCard(view.card, anchorRectOf(row));
  return true;
}

function hideSidebarHoverCard(): void {
  if (cardElements) {
    cardElements.card.hidden = true;
    delete cardElements.card.dataset.taskId;
  }
  setDescribedButton(null);
}

function setDescribedButton(button: HTMLButtonElement | null): void {
  if (describedButton === button) {
    return;
  }
  if (describedButton?.getAttribute("aria-describedby") === "sidebar-hover-card") {
    describedButton.removeAttribute("aria-describedby");
  }
  describedButton = button;
  describedButton?.setAttribute("aria-describedby", "sidebar-hover-card");
}

function clearStateTimer(): void {
  if (stateTimer !== null) {
    window.clearTimeout(stateTimer);
    stateTimer = null;
  }
}

function sidebarHoverCardEligible(taskId: string): boolean {
  return (
    state.sidebar.menu === null &&
    !elements.sidebar.classList.contains("collapsed") &&
    !(
      state.sidebar.renameEditor?.kind === "session" &&
      state.sidebar.renameEditor.taskId === taskId
    )
  );
}

function sessionRowFromTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(".sidebar-session") : null;
}

function sessionRowForTask(taskId: string): HTMLElement | null {
  return elements.sidebarList.querySelector<HTMLElement>(
    `.sidebar-session[data-task-id="${CSS.escape(taskId)}"]`,
  );
}

function queueSidebarHoverReconcile(): void {
  if (reconcileQueued || hoverState.kind !== "open") {
    return;
  }
  reconcileQueued = true;
  queueMicrotask(() => {
    reconcileQueued = false;
    if (hoverState.kind !== "open") {
      return;
    }
    const pointedRow = document
      .elementFromPoint(pointer.x, pointer.y)
      ?.closest<HTMLElement>(".sidebar-session");
    const taskId = pointedRow?.dataset.taskId;
    if (!taskId || !sidebarHoverCardEligible(taskId)) {
      dismissSidebarHoverCard();
      return;
    }
    if (taskId !== hoverState.taskId) {
      transitionSidebarHoverCard({ type: "row-enter", taskId, now: performance.now() });
      return;
    }
    showSidebarHoverCard(taskId);
  });
}

function repositionOpenSidebarHoverCard(): void {
  if (hoverState.kind !== "open") {
    return;
  }
  const row = sessionRowForTask(hoverState.taskId);
  if (!row || !cardElements || cardElements.card.hidden) {
    dismissSidebarHoverCard();
    return;
  }
  positionSidebarHoverCard(cardElements.card, anchorRectOf(row));
}
