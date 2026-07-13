// The inline-rename interaction controller (moved verbatim from main.ts at the
// 2026-07-13 post-program review fix): the single-flight commit lifecycle
// (`commitActiveRename`), the IME composition waiters, the pointer-boundary
// state + waiters, `runAfterRename`, `startSessionRename`/`startProjectRename`,
// `finishRenameForContinuation`, and `prepareSidebarStructureChange`. The
// composition root wires, it does not implement.
//
// The pure single-flight lifecycle lives in `reading-core/rename-flow.ts`
// (`commitRename`, driven by injected ports); THIS module is its shell-bound
// orchestration — the transport classification at the port seam, the DOM
// pointer/composition boundaries, and the queued-continuation choreography.
// Document-level pointer/click/window-blur LISTENERS are boot grammar and stay
// in main.ts, feeding this controller through the `note*` notification
// functions below. The protected-editor view calls arrive init-bound (flows
// never import view families — one mechanism for every upward edge).

import {
  commitRename as commitRenameFlow,
  RenameTransportFailure,
  type RenameFlowResult,
} from "../../reading-core/rename-flow";
import type { RendererState, SidebarRenameEditor } from "../../reading-core/state";
import * as renameTransitions from "../../reading-core/transitions/rename";
import type { RenameCommitTrigger } from "../../reading-core/transitions/rename";
import { render } from "../render";

interface RenameFlowDeps {
  /** Patch only the protected rename input (view/rename-editor) — a full render
   *  mid-blur/pointerdown could destroy the eventual click target before its
   *  click event is dispatched. */
  refreshProtectedRenameEditor(editor: SidebarRenameEditor | null): void;
  /** Return keyboard ownership to an editor whose queued action was blocked
   *  (view/rename-editor). */
  focusProtectedRenameEditor(editor: SidebarRenameEditor | null): boolean;
  /** Restore the browser-resolved Tab destination after a successful commit
   *  rebuilds the originating structure (view/rename-editor). */
  restoreRenameTabFocusIntent(editor: SidebarRenameEditor | null): void;
}

let state: RendererState;
let deps: RenameFlowDeps;

/** Bound once by main.ts at boot, before the first render (R4). */
export function initRenameFlows(boundState: RendererState, boundDeps: RenameFlowDeps): void {
  state = boundState;
  deps = boundDeps;
}

const activeRenameCommitPromises = new Map<number, Promise<RenameFlowResult>>();
const renameCompositionWaiters = new WeakMap<
  SidebarRenameEditor,
  { promise: Promise<void>; resolve: () => void }
>();
const activeRenamePointers = new Set<number>();
const renamePointerReleaseWaiters = new Set<() => void>();
let renamePointerBoundaryPending = false;

/**
 * Electron's ipcRenderer.invoke rejects with an Error whose message is prefixed
 * `Error invoking remote method '<channel>'` (plus OS codes and absolute data
 * paths). Classifying that Electron-specific shape here — at the port seam —
 * keeps transport knowledge in the shell; the pure flow only sees the
 * RenameTransportFailure type and picks its stable recovery copy.
 */
function asRenameTransportFailure(error: unknown): unknown {
  if (error instanceof Error && error.message.includes("Error invoking remote method")) {
    return new RenameTransportFailure(error.message, { cause: error });
  }
  return error;
}

export function commitActiveRename(trigger: RenameCommitTrigger): Promise<RenameFlowResult> {
  const editorAtTrigger = state.sidebar.renameEditor;
  if (editorAtTrigger?.status === "committing") {
    const active = activeRenameCommitPromises.get(editorAtTrigger.requestVersion);
    if (active) {
      return active;
    }
  }

  const statusBefore = state.sidebar.renameEditor?.status ?? null;
  const compositionBoundary = editorAtTrigger?.composing
    ? waitForRenameCompositionEnd(editorAtTrigger)
    : null;
  const flowPromise = commitRenameFlow(state, trigger, {
    renameSession: async (taskId, title) => {
      try {
        return await window.duetRuntime.renameSession({ taskId, title });
      } catch (error) {
        throw asRenameTransportFailure(error);
      }
    },
    renameProject: async (path, displayName) => {
      try {
        return await window.duetRuntime.renameProject({ path, displayName });
      } catch (error) {
        throw asRenameTransportFailure(error);
      }
    },
  });
  // The flow claims committing synchronously. Patch only the protected node;
  // a full render inside blur/pointerdown could destroy the eventual click
  // target before its click event is dispatched.
  deps.refreshProtectedRenameEditor(state.sidebar.renameEditor);
  const claimedPersistence =
    statusBefore !== "committing" && state.sidebar.renameEditor?.status === "committing";
  const requestVersion = claimedPersistence
    ? (state.sidebar.renameEditor?.requestVersion ?? null)
    : null;

  let pending!: Promise<RenameFlowResult>;
  pending = (async (): Promise<RenameFlowResult> => {
    const result = await flowPromise;
    if (result.kind === "ignored" && result.reason === "composing" && compositionBoundary) {
      await compositionBoundary;
      if (state.sidebar.renameEditor !== editorAtTrigger) {
        return { kind: "ignored", reason: "missing" };
      }
      return commitActiveRename(trigger);
    }
    // Missing/composing/duplicate commands do not own the persistence slot and
    // do not mutate presentation. In particular, an IME blur ignored while
    // composing must not swallow compositionend's immediate real retry.
    if (result.kind === "ignored") {
      return result;
    }
    await waitForRenameInteractionBoundary(trigger);
    if (requestVersion !== null && activeRenameCommitPromises.get(requestVersion) === pending) {
      activeRenameCommitPromises.delete(requestVersion);
    }
    render();
    deps.restoreRenameTabFocusIntent(editorAtTrigger);
    return result;
  })();
  if (requestVersion !== null) {
    activeRenameCommitPromises.set(requestVersion, pending);
  }
  return pending;
}

function waitForRenameCompositionEnd(editor: SidebarRenameEditor): Promise<void> {
  const existing = renameCompositionWaiters.get(editor);
  if (existing) {
    return existing.promise;
  }
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  renameCompositionWaiters.set(editor, { promise, resolve });
  return promise;
}

export function completeRenameComposition(editor: SidebarRenameEditor): void {
  const waiter = renameCompositionWaiters.get(editor);
  if (!waiter) {
    return;
  }
  renameCompositionWaiters.delete(editor);
  waiter.resolve();
}

async function waitForRenameInteractionBoundary(trigger: RenameCommitTrigger): Promise<void> {
  if (renamePointerBoundaryPending || activeRenamePointers.size > 0) {
    await new Promise<void>((resolve) => renamePointerReleaseWaiters.add(resolve));
  }
  if (trigger === "tab") {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }
}

function releaseRenamePointerWaiters(): void {
  if (renamePointerBoundaryPending || activeRenamePointers.size > 0) {
    return;
  }
  for (const resolve of renamePointerReleaseWaiters) {
    resolve();
  }
  renamePointerReleaseWaiters.clear();
}

function renameResultAllowsContinuation(result: RenameFlowResult): boolean {
  return (
    result.kind === "succeeded" ||
    result.kind === "unchanged" ||
    result.kind === "reverted-empty" ||
    (result.kind === "ignored" && result.reason === "missing")
  );
}

async function finishRenameForContinuation(trigger: RenameCommitTrigger): Promise<boolean> {
  const editorAtTrigger = state.sidebar.renameEditor;
  if (!editorAtTrigger) {
    return true;
  }
  const allowed = renameResultAllowsContinuation(await commitActiveRename(trigger));
  if (!allowed && state.sidebar.renameEditor === editorAtTrigger) {
    // The intended destination never became active. Keep recovery local by
    // returning focus to the exact draft that blocked the queued action.
    deps.refreshProtectedRenameEditor(editorAtTrigger);
    deps.focusProtectedRenameEditor(editorAtTrigger);
  }
  return allowed;
}

export async function prepareSidebarStructureChange(): Promise<boolean> {
  if (state.sidebar.renameEditor?.surface !== "sidebar") {
    return true;
  }
  return finishRenameForContinuation("destructive-action");
}

export function runAfterRename(
  continuation: () => void | Promise<void>,
  options: { sidebarOnly?: boolean } = {},
): void {
  void (async () => {
    const allowed = options.sidebarOnly
      ? await prepareSidebarStructureChange()
      : await finishRenameForContinuation("destructive-action");
    if (allowed) {
      await continuation();
    }
  })();
}

export function startSessionRename(
  taskId: string,
  surface: "header" | "sidebar",
  original: string,
): void {
  void (async () => {
    if (state.sidebar.renameEditor) {
      const allowed = await finishRenameForContinuation("second-intent");
      if (!allowed) {
        return;
      }
    }
    if (renameTransitions.startSessionRename(state, taskId, surface, original)) {
      render();
    }
  })();
}

export function startProjectRename(path: string, original: string): void {
  void (async () => {
    if (state.sidebar.renameEditor) {
      const allowed = await finishRenameForContinuation("second-intent");
      if (!allowed) {
        return;
      }
    }
    if (renameTransitions.startProjectRename(state, path, original)) {
      render();
    }
  })();
}

// ── Pointer/click/window-blur boundary notifications ─────────────────────────
// main.ts owns the LISTENER registration (boot grammar); their one-line bodies
// call these. The pointer boundary keeps a successful rename from rebuilding
// its target before the native click that triggered it is dispatched.

export function noteRenamePointerDown(pointerId: number): void {
  activeRenamePointers.add(pointerId);
  renamePointerBoundaryPending = true;
}

export function noteRenamePointerSettled(pointerId: number): void {
  activeRenamePointers.delete(pointerId);
  // Native click is dispatched after pointerup. Keep the boundary closed
  // through that click so a successful rename cannot rebuild its target first.
  // (T16 — rename pointer-boundary timeout-0.)
  window.setTimeout(() => {
    if (activeRenamePointers.size === 0) {
      renamePointerBoundaryPending = false;
      releaseRenamePointerWaiters();
    }
  }, 0);
}

export function noteRenamePointerClickBoundary(): void {
  if (activeRenamePointers.size === 0) {
    renamePointerBoundaryPending = false;
    releaseRenamePointerWaiters();
  }
}

export function noteRenameWindowBlur(): void {
  activeRenamePointers.clear();
  renamePointerBoundaryPending = false;
  releaseRenamePointerWaiters();
  if (state.sidebar.renameEditor) {
    void commitActiveRename("window-blur");
  }
}
