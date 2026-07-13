import type { RenameProjectResponse, RenameSessionResponse } from "../shared/types";
import type { RendererState } from "./state";
import {
  clearRenameNoticeForCommittedEntity,
  completeRenameCommit,
  currentRenameRequestMatches,
  failRenameCommit,
  requestRenameCommit,
  synchronizeCanonicalProjectRename,
  synchronizeCanonicalSessionRename,
  type RenameCommitDecision,
  type RenameCommitRequest,
  type RenameCommitTrigger,
} from "./transitions/rename";

export interface RenamePorts {
  renameSession(taskId: string, title: string): Promise<RenameSessionResponse>;
  renameProject(path: string, displayName: string): Promise<RenameProjectResponse>;
}

/**
 * A transport-layer rename failure, classified in the Electron-aware shell and
 * rethrown into this pure flow. The core owns no transport knowledge; it only
 * needs the type to select its stable recovery copy (see `renameErrorMessage`).
 */
export class RenameTransportFailure extends Error {
  constructor(message = "Rename transport failed.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RenameTransportFailure";
  }
}

export type RenameFlowResult =
  | Exclude<RenameCommitDecision, { kind: "commit" }>
  | { kind: "succeeded"; request: RenameCommitRequest }
  | { kind: "failed"; request: RenameCommitRequest; errorMessage: string }
  | { kind: "stale"; request: RenameCommitRequest };

/**
 * The single-flight async rename lifecycle. `requestRenameCommit` claims the
 * request synchronously, before the first await, so Enter + blur + app-blur can
 * never send duplicate IPC calls. Canonical state is synchronized before the
 * editor closes, preventing an old-name flash on the next render.
 */
export async function commitRename(
  state: RendererState,
  trigger: RenameCommitTrigger,
  ports: RenamePorts,
): Promise<RenameFlowResult> {
  const decision = requestRenameCommit(state, trigger);
  if (decision.kind !== "commit") {
    return decision;
  }
  const request = decision.request;

  try {
    if (request.kind === "session") {
      const response = await ports.renameSession(request.taskId, request.title);
      // Response validation stays BEFORE any state mutation.
      if (response.task.id !== request.taskId) {
        throw new Error("Session rename returned a different session.");
      }
      synchronizeCanonicalSessionRename(state, response.task);
    } else {
      const response = await ports.renameProject(request.path, request.displayName);
      synchronizeCanonicalProjectRename(state, response);
    }
    // The disk save happened, so canonical projections are repaired
    // unconditionally (they never touch the editor). A stale success — the
    // editor has since closed/reopened — still lands its canonical data and
    // retracts any terminate-notice that claimed THIS entity could not be
    // saved; a notice for a different entity survives. Editor closure alone
    // keeps the `currentRenameRequestMatches` guard.
    clearRenameNoticeForCommittedEntity(state, request);
    if (!currentRenameRequestMatches(state, request)) {
      return { kind: "stale", request };
    }
    completeRenameCommit(state, request);
    return { kind: "succeeded", request };
  } catch (error) {
    const errorMessage = renameErrorMessage(error);
    if (!failRenameCommit(state, request, errorMessage)) {
      return { kind: "stale", request };
    }
    return { kind: "failed", request, errorMessage };
  }
}

function renameErrorMessage(error: unknown): string {
  // Transport failures (Electron's invoke wrapper leaks channel names, OS codes
  // and absolute data paths — useful in logs, not in a compact inline editor)
  // are classified in the shell and arrive as RenameTransportFailure. Intentional
  // domain errors pass their message through untouched.
  if (error instanceof RenameTransportFailure) {
    return "Couldn’t save this name. Your draft is still here—try again.";
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Rename could not be saved.";
}
