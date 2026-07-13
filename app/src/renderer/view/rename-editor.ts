import type { RendererState, SidebarRenameEditor } from "../../reading-core/state";
import * as renameTransitions from "../../reading-core/transitions/rename";
import { actions } from "../actions";

interface RenameEditorOptions {
  surface: "header" | "sidebar";
  focusKey?: string;
}

interface ProtectedRenameEditor {
  editor: SidebarRenameEditor;
  root: HTMLDivElement;
  input: HTMLInputElement;
  progress: HTMLSpanElement;
  error: HTMLSpanElement;
  options: RenameEditorOptions;
  progressTimer: number | null;
}

interface RenameTabFocusIntent {
  targetElement: HTMLElement | null;
  targetId: string | null;
  targetFocusKey: string | null;
}

const PROGRESS_DELAY_MS = 300;
let state: RendererState;
let protectedEditor: ProtectedRenameEditor | null = null;
let editorSerial = 0;
const pendingTabFocusIntents = new Map<SidebarRenameEditor, RenameTabFocusIntent>();

export function initRenameEditorView(stateRef: RendererState): void {
  state = stateRef;
}

/**
 * Returns one protected input node for the lifetime of one state editor.
 * Callers may move its wrapper into a freshly reconciled host, but repeated
 * renders never recreate the input, so selection, caret, focus and the
 * browser's composition owner survive background paints.
 */
export function renderProtectedRenameEditor(
  editor: SidebarRenameEditor,
  options: RenameEditorOptions,
): HTMLElement {
  if (!protectedEditor || protectedEditor.editor !== editor) {
    releaseProtectedRenameEditor();
    protectedEditor = createProtectedRenameEditor(editor, options);
    scheduleInitialFocus(protectedEditor);
  }
  syncProtectedRenameEditor(protectedEditor, editor, options);
  return protectedEditor.root;
}

/** The Sidebar uses this to defer structural list paints while its editor is
 * mounted. Updating the state is still allowed; the next safe render catches
 * the list up after commit/cancel. */
export function sidebarRenameEditorIsProtected(editor: SidebarRenameEditor | null): boolean {
  return Boolean(
    editor?.surface === "sidebar" &&
      protectedEditor?.editor === editor &&
      protectedEditor.input.isConnected,
  );
}

export function reconcileProtectedRenameEditor(editor: SidebarRenameEditor | null): void {
  if (!editor || protectedEditor?.editor !== editor) {
    releaseProtectedRenameEditor();
  }
}

export function refreshProtectedRenameEditor(editor: SidebarRenameEditor | null): void {
  if (editor && protectedEditor?.editor === editor) {
    syncProtectedRenameEditor(protectedEditor, editor, protectedEditor.options);
  }
}

/** Returns keyboard ownership to an editor when a queued intent could not
 * continue. The identity check prevents a late request from stealing focus
 * from a newer editor generation. */
export function focusProtectedRenameEditor(editor: SidebarRenameEditor | null): boolean {
  if (!editor || protectedEditor?.editor !== editor || !protectedEditor.input.isConnected) {
    return false;
  }
  protectedEditor.input.focus({ preventScroll: true });
  return document.activeElement === protectedEditor.input;
}

/** Restores the browser-resolved Tab destination after a successful commit
 * rebuilds the originating structure. A later pointer/focus choice wins. */
export function restoreRenameTabFocusIntent(editor: SidebarRenameEditor | null): void {
  if (!editor) {
    return;
  }
  const intent = pendingTabFocusIntents.get(editor) ?? null;
  pendingTabFocusIntents.delete(editor);
  if (!intent) {
    return;
  }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const target = resolveTabFocusIntent(intent);
  if (!target || active === target) {
    return;
  }
  if (active && active !== document.body && active.isConnected) {
    return;
  }
  target.focus({ preventScroll: true });
}

function createProtectedRenameEditor(
  editor: SidebarRenameEditor,
  options: RenameEditorOptions,
): ProtectedRenameEditor {
  editorSerial += 1;
  const root = document.createElement("div");
  root.className = `rename-editor rename-editor-${options.surface}`;
  root.dataset.renameKind = editor.kind;
  root.dataset.renameSurface = options.surface;
  if (editor.kind === "session") {
    root.dataset.taskId = editor.taskId;
  } else {
    root.dataset.projectPath = editor.path;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className =
    options.surface === "header" ? "header-rename-input" : "sidebar-rename-input";
  input.value = editor.draft;
  input.setAttribute("aria-label", editor.kind === "session" ? "Session name" : "Project name");
  input.autocomplete = "off";
  input.spellcheck = false;

  const progress = document.createElement("span");
  progress.className = "rename-progress";
  progress.setAttribute("role", "status");
  progress.setAttribute("aria-live", "polite");

  const error = document.createElement("span");
  error.id = `rename-error-${editorSerial}`;
  error.className = "rename-error";
  error.setAttribute("role", "alert");

  input.addEventListener("input", () => {
    if (ownsCurrentEditor(editor)) {
      renameTransitions.updateRenameDraft(state, input.value);
      syncProtectedRenameEditor(protectedEditorFor(editor), editor, options);
    }
  });
  input.addEventListener("compositionstart", () => {
    if (ownsCurrentEditor(editor)) {
      renameTransitions.setRenameComposing(state, true);
    }
  });
  input.addEventListener("compositionend", () => {
    if (!ownsCurrentEditor(editor)) {
      return;
    }
    renameTransitions.updateRenameDraft(state, input.value);
    renameTransitions.setRenameComposing(state, false);
    actions.completeRenameComposition(editor);
    if (document.activeElement !== input) {
      void actions.commitRename("blur");
    }
  });
  input.addEventListener("keydown", (event) => {
    if (!ownsCurrentEditor(editor) || renameTransitions.renameCommandSuppressed(state, event)) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void actions.commitRename("enter");
      syncProtectedRenameEditor(protectedEditorFor(editor), editor, options);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      actions.cancelRename();
      return;
    }
    if (event.key === "Tab") {
      // Native Tab resolves the destination and direction. Structural cleanup
      // is delayed by the shell until the browser has moved focus.
      captureRenameTabFocusIntent(editor, input, event.shiftKey);
      void actions.commitRename("tab");
      syncProtectedRenameEditor(protectedEditorFor(editor), editor, options);
    }
  });
  input.addEventListener("blur", () => {
    if (ownsCurrentEditor(editor)) {
      void actions.commitRename("blur");
    }
  });

  root.append(input, progress, error);
  return { editor, root, input, progress, error, options, progressTimer: null };
}

function captureRenameTabFocusIntent(
  editor: SidebarRenameEditor,
  input: HTMLInputElement,
  backwards: boolean,
): void {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((candidate) => isTabbable(candidate));
  const index = candidates.indexOf(input);
  const fallback =
    index < 0
      ? null
      : candidates[(index + (backwards ? -1 : 1) + candidates.length) % candidates.length] ?? null;
  pendingTabFocusIntents.set(editor, tabFocusIntentFor(fallback));

  const captureNativeDestination = (event: FocusEvent): void => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target && target !== input) {
      pendingTabFocusIntents.set(editor, tabFocusIntentFor(target));
      document.removeEventListener("focusin", captureNativeDestination, true);
    }
  };
  document.addEventListener("focusin", captureNativeDestination, true);
  window.setTimeout(() => {
    document.removeEventListener("focusin", captureNativeDestination, true);
  }, 0);
}

function tabFocusIntentFor(target: HTMLElement | null): RenameTabFocusIntent {
  return {
    targetElement: target,
    targetId: target?.id || null,
    targetFocusKey: target?.dataset.sidebarFocusKey ?? null,
  };
}

function resolveTabFocusIntent(intent: RenameTabFocusIntent): HTMLElement | null {
  if (intent.targetElement?.isConnected) {
    return intent.targetElement;
  }
  if (intent.targetId) {
    const byId = document.getElementById(intent.targetId);
    if (byId instanceof HTMLElement) {
      return byId;
    }
  }
  if (intent.targetFocusKey) {
    return (
      Array.from(document.querySelectorAll<HTMLElement>("[data-sidebar-focus-key]")).find(
        (candidate) => candidate.dataset.sidebarFocusKey === intent.targetFocusKey,
      ) ?? null
    );
  }
  return null;
}

function isTabbable(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return (
    element.tabIndex >= 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    element.getClientRects().length > 0
  );
}

function syncProtectedRenameEditor(
  nodes: ProtectedRenameEditor,
  editor: SidebarRenameEditor,
  options: RenameEditorOptions,
): void {
  nodes.root.className = `rename-editor rename-editor-${options.surface}`;
  nodes.options = options;
  if (options.focusKey) {
    nodes.input.dataset.sidebarFocusKey = options.focusKey;
  } else {
    delete nodes.input.dataset.sidebarFocusKey;
  }

  // State is authoritative, but never write through an actively owned input:
  // assigning value there collapses the browser selection and can terminate
  // an in-progress composition.
  if (
    document.activeElement !== nodes.input &&
    !editor.composing &&
    nodes.input.value !== editor.draft
  ) {
    nodes.input.value = editor.draft;
  }

  const committing = editor.status === "committing";
  nodes.input.readOnly = committing;
  nodes.input.setAttribute("aria-busy", String(committing));
  nodes.root.classList.toggle("committing", committing);
  syncProgress(nodes, committing);

  const errorMessage = editor.errorMessage?.trim() ?? "";
  nodes.error.textContent = errorMessage;
  nodes.error.classList.toggle("visible", Boolean(errorMessage));
  nodes.input.setAttribute("aria-invalid", String(Boolean(errorMessage)));
  if (errorMessage) {
    nodes.input.setAttribute("aria-describedby", nodes.error.id);
  } else {
    nodes.input.removeAttribute("aria-describedby");
  }
}

function syncProgress(nodes: ProtectedRenameEditor, committing: boolean): void {
  if (!committing) {
    if (nodes.progressTimer !== null) {
      window.clearTimeout(nodes.progressTimer);
      nodes.progressTimer = null;
    }
    nodes.progress.textContent = "";
    nodes.progress.classList.remove("visible");
    return;
  }
  if (nodes.progressTimer !== null || nodes.progress.classList.contains("visible")) {
    return;
  }
  nodes.progressTimer = window.setTimeout(() => {
    nodes.progressTimer = null;
    if (protectedEditor === nodes && nodes.editor.status === "committing") {
      nodes.progress.textContent = "Saving…";
      nodes.progress.classList.add("visible");
    }
  }, PROGRESS_DELAY_MS);
}

function scheduleInitialFocus(nodes: ProtectedRenameEditor): void {
  window.requestAnimationFrame(() => {
    if (protectedEditor !== nodes || !ownsCurrentEditor(nodes.editor) || !nodes.input.isConnected) {
      return;
    }
    // A fast pointer/test/user interaction may already have placed the caret
    // before this first-frame convenience runs. Never overwrite that newer
    // selection intent with the initial select-all policy.
    if (document.activeElement === nodes.input) {
      return;
    }
    nodes.input.focus({ preventScroll: true });
    nodes.input.select();
  });
}

function protectedEditorFor(editor: SidebarRenameEditor): ProtectedRenameEditor {
  if (!protectedEditor || protectedEditor.editor !== editor) {
    throw new Error("Rename editor node identity was lost.");
  }
  return protectedEditor;
}

function ownsCurrentEditor(editor: SidebarRenameEditor): boolean {
  return state.sidebar.renameEditor === editor;
}

function releaseProtectedRenameEditor(): void {
  const progressTimer = protectedEditor?.progressTimer;
  if (progressTimer !== null && progressTimer !== undefined) {
    window.clearTimeout(progressTimer);
  }
  if (protectedEditor) {
    // Disappearance/replacement is also a terminal boundary for any intent
    // waiting on this editor's IME lifecycle.
    actions.completeRenameComposition(protectedEditor.editor);
  }
  protectedEditor = null;
}
