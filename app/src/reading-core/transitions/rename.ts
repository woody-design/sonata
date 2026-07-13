import type { RenameProjectResponse, Task } from "../../shared/types";
import type { RendererState, SidebarRenameEditor } from "../state";

export type RenameCommitTrigger =
  | "enter"
  | "tab"
  | "blur"
  | "window-blur"
  | "destructive-action"
  | "second-intent";

export type RenameCommitRequest =
  | { kind: "session"; taskId: string; title: string; requestVersion: number }
  | { kind: "project"; path: string; displayName: string; requestVersion: number };

export type RenameCommitDecision =
  | { kind: "commit"; request: RenameCommitRequest }
  | { kind: "ignored"; reason: "missing" | "composing" | "committing" }
  | { kind: "unchanged" }
  | { kind: "reverted-empty" }
  | { kind: "invalid"; errorMessage: string };

export const EMPTY_RENAME_ERROR = "Name cannot be empty.";

export function startSessionRename(
  state: RendererState,
  taskId: string,
  surface: "header" | "sidebar",
  original: string,
): boolean {
  if (state.sidebar.renameEditor) {
    return false;
  }
  state.sidebar.renameNotice = null;
  state.sidebar.renameEditor = {
    kind: "session",
    taskId,
    surface,
    ...initialEditor(original),
  };
  return true;
}

export function startProjectRename(
  state: RendererState,
  path: string,
  original: string,
): boolean {
  if (state.sidebar.renameEditor) {
    return false;
  }
  state.sidebar.renameNotice = null;
  state.sidebar.renameEditor = {
    kind: "project",
    path,
    surface: "sidebar",
    ...initialEditor(original),
  };
  return true;
}

export function updateRenameDraft(state: RendererState, draft: string): boolean {
  const editor = state.sidebar.renameEditor;
  if (!editor || editor.status === "committing") {
    return false;
  }
  editor.draft = draft;
  if (editor.status === "error") {
    editor.status = "editing";
    editor.errorMessage = null;
  }
  return true;
}

export function setRenameComposing(state: RendererState, composing: boolean): boolean {
  const editor = state.sidebar.renameEditor;
  if (!editor || editor.status === "committing") {
    return false;
  }
  editor.composing = composing;
  return true;
}

export function renameCommandSuppressed(
  state: RendererState,
  event: { isComposing: boolean; keyCode: number },
): boolean {
  return Boolean(
    state.sidebar.renameEditor?.composing || event.isComposing || event.keyCode === 229,
  );
}

/** Synchronously claims the one persistence slot before the caller awaits. */
export function requestRenameCommit(
  state: RendererState,
  trigger: RenameCommitTrigger,
): RenameCommitDecision {
  const editor = state.sidebar.renameEditor;
  if (!editor) {
    return { kind: "ignored", reason: "missing" };
  }
  if (editor.composing) {
    return { kind: "ignored", reason: "composing" };
  }
  if (editor.status === "committing") {
    return { kind: "ignored", reason: "committing" };
  }

  const canonicalDraft = editor.draft.trim();
  if (!canonicalDraft) {
    if (trigger === "enter") {
      editor.status = "error";
      editor.errorMessage = EMPTY_RENAME_ERROR;
      return { kind: "invalid", errorMessage: EMPTY_RENAME_ERROR };
    }
    state.sidebar.renameEditor = null;
    return { kind: "reverted-empty" };
  }
  if (canonicalDraft === editor.original) {
    state.sidebar.renameEditor = null;
    return { kind: "unchanged" };
  }

  const requestVersion = state.sidebar.renameRequestVersion + 1;
  state.sidebar.renameRequestVersion = requestVersion;
  editor.status = "committing";
  editor.requestVersion = requestVersion;
  editor.errorMessage = null;
  return editor.kind === "session"
    ? {
        kind: "commit",
        request: {
          kind: "session",
          taskId: editor.taskId,
          title: canonicalDraft,
          requestVersion,
        },
      }
    : {
        kind: "commit",
        request: {
          kind: "project",
          path: editor.path,
          displayName: canonicalDraft,
          requestVersion,
        },
      };
}

export function currentRenameRequestMatches(
  state: RendererState,
  request: RenameCommitRequest,
): boolean {
  const editor = state.sidebar.renameEditor;
  if (!editor || editor.requestVersion !== request.requestVersion) {
    return false;
  }
  return request.kind === "session"
    ? editor.kind === "session" && editor.taskId === request.taskId
    : editor.kind === "project" && editor.path === request.path;
}

export function completeRenameCommit(
  state: RendererState,
  request: RenameCommitRequest,
): boolean {
  if (!currentRenameRequestMatches(state, request)) {
    return false;
  }
  state.sidebar.renameEditor = null;
  return true;
}

export function failRenameCommit(
  state: RendererState,
  request: RenameCommitRequest,
  errorMessage: string,
): boolean {
  if (!currentRenameRequestMatches(state, request)) {
    return false;
  }
  const editor = state.sidebar.renameEditor;
  if (!editor) {
    return false;
  }
  editor.status = "error";
  editor.errorMessage = errorMessage;
  return true;
}

export function cancelRename(state: RendererState): boolean {
  const editor = state.sidebar.renameEditor;
  if (!editor || editor.status === "committing") {
    return false;
  }
  state.sidebar.renameEditor = null;
  return true;
}

/** Ends an orphaned editor. Slice 5 owns the visible surface-level notice. */
export function terminateRenameForMissingEntity(state: RendererState): SidebarRenameEditor | null {
  const editor = state.sidebar.renameEditor;
  if (!editor) {
    return null;
  }
  state.sidebar.renameEditor = null;
  state.sidebar.renameNotice = {
    surface: editor.surface,
    message:
      editor.kind === "session"
        ? "This session is no longer available, so its new name could not be saved."
        : "This project is no longer available, so its new name could not be saved.",
  };
  return editor;
}

export function synchronizeCanonicalSessionRename(
  state: RendererState,
  task: Task,
): void {
  for (const view of state.taskViews) {
    if (view.task?.id === task.id) {
      view.task = task;
    }
  }
  const index = state.sessionIndex;
  if (!index) {
    return;
  }
  for (const project of index.projects) {
    for (const session of project.sessions) {
      if (session.task.id === task.id) {
        session.task = task;
      }
    }
  }
  for (const session of index.chats) {
    if (session.task.id === task.id) {
      session.task = task;
    }
  }
}

export function synchronizeCanonicalProjectRename(
  state: RendererState,
  response: RenameProjectResponse,
): void {
  const project = state.sessionIndex?.projects.find(
    (candidate) => candidate.path === response.path,
  );
  if (project) {
    project.name = response.name;
  }
}

function initialEditor(original: string): Omit<
  SidebarRenameEditor,
  "kind" | "taskId" | "path" | "surface"
> {
  return {
    original,
    draft: original,
    status: "editing",
    requestVersion: 0,
    errorMessage: null,
    composing: false,
  };
}
