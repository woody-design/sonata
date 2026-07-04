import { ChevronDown, ChevronRight, FolderOpen, PanelRight, SquareArrowOutUpRight } from "lucide";
import { lucideIcon } from "../view/icons";
import { activePath, type PreviewDeps, type PreviewViewState } from "./state";

/**
 * The toolbar (§5.5): a static breadcrumb, the Open dropdown (Reveal in Finder
 * / Open in Cursor, both on the workspace external-open bridge), and the
 * folder-panel toggle. The dropdown is disabled on a tombstone — there is
 * nothing on disk to reveal.
 */

export interface ToolbarElements {
  breadcrumb: HTMLElement;
  openButton: HTMLButtonElement;
  openMenu: HTMLElement;
  panelToggle: HTMLButtonElement;
}

let deps: PreviewDeps | null = null;
let menuOpen = false;

export function initToolbar(toolbar: ToolbarElements, bound: PreviewDeps): void {
  deps = bound;
  toolbar.openButton.append(
    textSpan("Open"),
    lucideIcon(ChevronDown, 14),
  );
  toolbar.panelToggle.append(lucideIcon(PanelRight, 16));

  toolbar.openButton.addEventListener("click", (event) => {
    event.stopPropagation();
    setMenuOpen(toolbar, !menuOpen);
  });
  toolbar.openMenu.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-open-target]");
    if (!target) {
      return;
    }
    const which = target.dataset.openTarget === "cursor" ? "cursor" : "folder";
    setMenuOpen(toolbar, false);
    deps?.openExternal(which);
  });
  document.addEventListener("click", (event) => {
    if (!menuOpen) {
      return;
    }
    if (
      !toolbar.openMenu.contains(event.target as Node) &&
      event.target !== toolbar.openButton
    ) {
      setMenuOpen(toolbar, false);
    }
  });
  toolbar.panelToggle.addEventListener("click", () => deps?.togglePanel());
}

export function renderToolbar(state: PreviewViewState, toolbar: ToolbarElements): void {
  renderBreadcrumb(state, toolbar.breadcrumb);

  // Disabled when there is nothing on disk to open — no active tab, or the
  // active tab is a tombstone.
  const path = activePath(state);
  const tombstoned = state.docPath === path && state.doc?.kind === "absent";
  const openable = Boolean(path) && !tombstoned;
  toolbar.openButton.disabled = !openable;
  if (!openable) {
    setMenuOpen(toolbar, false);
  }

  const panelOpen = state.binding.session?.panelOpen ?? false;
  toolbar.panelToggle.setAttribute("aria-pressed", String(panelOpen));
  toolbar.panelToggle.classList.toggle("active", panelOpen);
}

function renderBreadcrumb(state: PreviewViewState, breadcrumb: HTMLElement): void {
  breadcrumb.replaceChildren();
  const root = state.binding.projectDirName;
  const path = activePath(state);
  if (!root && !path) {
    return;
  }

  const segments: string[] = [];
  if (root) {
    segments.push(root);
  }
  if (path) {
    segments.push(...path.split("/").filter(Boolean));
  }

  segments.forEach((segment, index) => {
    if (index > 0) {
      const sep = lucideIcon(ChevronRight, 12);
      sep.classList.add("preview-crumb-sep");
      breadcrumb.append(sep);
    }
    const span = document.createElement("span");
    span.className = "preview-crumb";
    span.classList.toggle("preview-crumb-leaf", index === segments.length - 1);
    span.textContent = segment;
    breadcrumb.append(span);
  });
}

function setMenuOpen(toolbar: ToolbarElements, open: boolean): void {
  menuOpen = open;
  toolbar.openButton.setAttribute("aria-expanded", String(open));
  toolbar.openMenu.classList.toggle("hidden", !open);
  if (open) {
    toolbar.openMenu.replaceChildren(
      openItem("folder", FolderOpen, "Reveal in Finder"),
      openItem("cursor", SquareArrowOutUpRight, "Open in Cursor"),
    );
  }
}

function openItem(target: "folder" | "cursor", icon: Parameters<typeof lucideIcon>[0], label: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "preview-open-item";
  button.dataset.openTarget = target;
  button.append(lucideIcon(icon, 15), textSpan(label));
  return button;
}

function textSpan(text: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}
