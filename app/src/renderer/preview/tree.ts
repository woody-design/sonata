import type { PreviewViewState } from "./state";

/**
 * Folder panel — an intentional STUB in S1 (§8). The panel toggles open/closed
 * and persists that in the session, but its body is a quiet placeholder; the
 * real lazy tree (twisties, dims, filter, auto-reveal) is S3. Kept as its own
 * module so S3 fills it in without touching the composition root.
 */
export function renderTree(state: PreviewViewState, panelEl: HTMLElement): void {
  const open = state.binding.session?.panelOpen ?? false;
  panelEl.classList.toggle("hidden", !open);
  if (!open) {
    return;
  }
  if (panelEl.dataset.stub === "true") {
    return;
  }
  panelEl.dataset.stub = "true";
  panelEl.replaceChildren();
  const hint = document.createElement("p");
  hint.className = "preview-tree-stub";
  hint.textContent = "Folder tree arrives soon.";
  panelEl.append(hint);
}
