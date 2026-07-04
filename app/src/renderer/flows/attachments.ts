// Attachment intake + delivery flows (moved verbatim from main.ts at D4d):
// the paste/drop/picker routing, the held-attachment list operations, lazy
// materialization on send, and the composer status channel's write side.
// Mid-flow render() calls are BEHAVIOR — loading states paint at exact
// points — so call positions are preserved exactly. The state atom arrives
// init-bound from the composition root (reads are a module's job; the flows
// never import upward).

import type { DeliveryAttachment, ReferenceResult } from "../../shared/types";
import {
  errorMessage,
  fileExtension,
} from "../../reading-core/selectors/formatters";
import {
  activeTaskView as activeTaskViewOf,
  type ComposerAttachment,
  type RendererState,
  type TaskViewState,
} from "../../reading-core/state";
import { render } from "../render";

let state: RendererState;

/** Bound once by main.ts at boot, before the first render (R4). */
export function initAttachmentFlows(boundState: RendererState): void {
  state = boundState;
}

function activeTaskView(): TaskViewState | null {
  return activeTaskViewOf(state);
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export async function pickAndAddReferences(): Promise<void> {
  let paths: string[];
  try {
    paths = await window.duetRuntime.pickReferences();
  } catch (error) {
    setComposerStatus(activeTaskView(), errorMessage(error));
    return;
  }
  if (paths.length > 0) {
    await addReferences(paths);
  }
}

// Route dropped/pasted Files by the one fact that matters: does it already have
// a path on disk? A real Electron file (drag/paste of a file, or the picker)
// has a path → REFERENCE it (no copy). A path-less image (clipboard bitmap /
// screenshot) has no path → COPY it. webUtils.getPathForFile returns "" for a
// bitmap — that is the discriminator.
export async function intakeFiles(files: File[]): Promise<void> {
  if (files.length === 0) {
    return;
  }
  const bitmaps: File[] = [];
  const referencePaths: string[] = [];
  for (const file of files) {
    const filePath = window.duetRuntime.getPathForFile(file);
    if (filePath) {
      referencePaths.push(filePath);
    } else if (isSupportedImageFile(file)) {
      bitmaps.push(file);
    }
  }
  if (referencePaths.length === 0 && bitmaps.length === 0) {
    // We prevented the default paste/drop but found nothing attachable (e.g. a
    // path-less, unsupported clipboard item) — say so instead of doing nothing.
    setComposerStatus(activeTaskView(), "Nothing attachable here — try a file, folder, or image.");
    return;
  }
  if (referencePaths.length > 0) {
    await addReferences(referencePaths);
  }
  if (bitmaps.length > 0) {
    addBitmaps(bitmaps);
  }
}

/** The composer attachment list for the current surface: a live task's pending
 *  list, or the new-chat draft. */
function composerAttachmentList(): ComposerAttachment[] {
  const view = activeTaskView();
  return view?.task ? view.pendingAttachments : state.draftAttachments;
}

// Path-less image bitmaps (screenshots, copied images) → held as a File and
// copied into the blob dir only on send (lazy). Chipped with a thumbnail.
function addBitmaps(files: File[]): void {
  const list = composerAttachmentList();
  for (const file of files) {
    list.push({
      file,
      reference: null,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
      kind: "image",
    });
  }
  render();
}

// User paths (dragged/pasted files, picked files/folders) → referenced by
// absolute path, never copied. createReference classifies + returns a capped
// thumbnail for images; files/folders fall back to a kind icon.
async function addReferences(paths: string[]): Promise<void> {
  let references: ReferenceResult[];
  try {
    references = await window.duetRuntime.createReference({ paths });
  } catch (error) {
    setComposerStatus(activeTaskView(), errorMessage(error));
    return;
  }
  const list = composerAttachmentList();
  for (const { attachment, previewDataUrl } of references) {
    list.push({
      file: null,
      reference: attachment,
      previewUrl: previewDataUrl,
      name: attachment.originalName,
      kind: attachment.kind,
    });
  }
  // createReference skips paths that vanished / are inaccessible — don't drop them
  // silently (Invariant 5): say how many made it.
  if (references.length < paths.length) {
    setComposerStatus(
      activeTaskView(),
      `Attached ${references.length} of ${paths.length} — the rest were unavailable.`,
    );
    return;
  }
  render();
}

/** Surface a composer status on the active view, or globally for a new chat.
 *  (The channel's suppression policy — composerStatusText — lives with the
 *  render orchestrator in render.ts.) */
function setComposerStatus(view: TaskViewState | null, message: string): void {
  if (view?.task) {
    view.status = message;
  } else {
    state.status = message;
  }
  render();
}

export function composerStatusHint(text: string): void {
  const view = activeTaskView();
  if (view) {
    view.status = text;
  } else {
    state.taskDraft.message = { tone: "info", text };
  }
  render();
}

/** Remove a held composer attachment. Renderer-only: nothing is on disk yet — a
 *  bitmap is copied only on send, a reference is never copied — so dropping the
 *  chip (and revoking any object URL) is the entire removal. Never touches a
 *  user's original (Invariant 4). */
export function removeComposerAttachment(list: ComposerAttachment[], target: ComposerAttachment): void {
  const index = list.indexOf(target);
  if (index === -1) {
    return;
  }
  const [removed] = list.splice(index, 1);
  if (removed?.previewUrl) {
    URL.revokeObjectURL(removed.previewUrl);
  }
  render();
}

export function clearComposerAttachments(list: ComposerAttachment[]): void {
  for (const item of list) {
    if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
  list.length = 0;
}

/** Turn the held items into DeliveryAttachments for the prompt: a bitmap is
 *  copied into the (now live) task's blob dir; a reference passes through (never
 *  copied). The runtime is always live by the time this runs (createTask /
 *  openTask have spawned it). */
export async function materializeAttachments(
  items: ComposerAttachment[],
  taskId: string,
): Promise<DeliveryAttachment[]> {
  const attachments: DeliveryAttachment[] = [];
  for (const item of items) {
    if (item.reference) {
      attachments.push(item.reference);
    } else if (item.file) {
      // Narrow the opaque handle back to File (shell-side; see ComposerAttachment.file).
      const file = item.file as File;
      const bytes = await file.arrayBuffer();
      attachments.push(
        await window.duetRuntime.createAttachment({
          taskId,
          originalName: file.name,
          mediaType: file.type,
          bytes,
        }),
      );
    }
  }
  return attachments;
}

function isSupportedImageFile(file: File): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(file.type) || SUPPORTED_IMAGE_EXTENSIONS.has(fileExtension(file.name));
}

export function hasFileTransfer(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.items ?? []).some((item) => item.kind === "file");
}
