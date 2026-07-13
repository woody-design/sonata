import type { RenameProjectResponse, RenameSessionResponse } from "../shared/types";
import type { RendererState } from "./state";
import {
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
      if (!currentRenameRequestMatches(state, request)) {
        return { kind: "stale", request };
      }
      if (response.task.id !== request.taskId) {
        throw new Error("Session rename returned a different session.");
      }
      synchronizeCanonicalSessionRename(state, response.task);
    } else {
      const response = await ports.renameProject(request.path, request.displayName);
      if (!currentRenameRequestMatches(state, request)) {
        return { kind: "stale", request };
      }
      synchronizeCanonicalProjectRename(state, response);
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
  if (error instanceof Error && error.message.trim()) {
    // Electron's invoke wrapper includes channel names, OS codes and absolute
    // data paths. Those details are useful in logs, not in a compact inline
    // editor. Preserve intentional domain errors while translating transport
    // failures into a stable recovery message.
    if (error.message.includes("Error invoking remote method")) {
      return "Couldn’t save this name. Your draft is still here—try again.";
    }
    return error.message;
  }
  return "Rename could not be saved.";
}
