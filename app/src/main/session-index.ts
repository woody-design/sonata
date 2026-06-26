import path from "node:path";
import type { Task, TaskId } from "../shared/types/domain";
import type {
  ProjectGroup,
  SessionIndexResponse,
  SessionSummary,
} from "../shared/types/sessions";
import type { TaskManifestV1 } from "../shared/schemas";
import type { ProjectsFileV1 } from "./projects-store";

/**
 * Pure derivation of the sidebar's session index. Sessions come from the
 * persisted manifests (single source of truth); projects are the distinct
 * working folders across those sessions plus cosmetic overlay metadata.
 * Electron-free so it can be exercised directly by smoke tests.
 */

export interface SessionIndexInput {
  candidates: Array<{ storageRoot: string; manifest: TaskManifestV1; mtimeMs: number }>;
  /** Live runtimes — their in-memory Task is fresher than the disk manifest. */
  liveTasks: Map<TaskId, Task>;
  overlay: ProjectsFileV1;
  includeArchived?: boolean;
}

export function buildSessionIndex(input: SessionIndexInput): SessionIndexResponse {
  const includeArchived = Boolean(input.includeArchived);

  const chats: SessionSummary[] = [];
  const byFolder = new Map<string, SessionSummary[]>();
  const seen = new Set<string>();

  for (const candidate of input.candidates) {
    const persisted = candidate.manifest.task;
    if (seen.has(persisted.id)) {
      continue;
    }
    seen.add(persisted.id);

    const liveTask = input.liveTasks.get(persisted.id) ?? null;
    const task = liveTask ?? persisted;
    const archived = Boolean(task.archived);
    if (archived && !includeArchived) {
      continue;
    }

    const providerCwd = path.resolve(
      task.providerCwd || task.workingDirectory || candidate.storageRoot,
    );
    const summary: SessionSummary = {
      task,
      storageRoot: candidate.storageRoot,
      archived,
      live: Boolean(liveTask),
      liveStatus: liveTask ? liveTask.status : null,
      lastActivityAt: lastActivity(candidate.mtimeMs, task.updatedAt),
    };

    if (task.autoWorkspace) {
      chats.push(summary);
    } else {
      const group = byFolder.get(providerCwd);
      if (group) {
        group.push(summary);
      } else {
        byFolder.set(providerCwd, [summary]);
      }
    }
  }

  const projects: ProjectGroup[] = [];
  for (const [folderPath, sessions] of byFolder) {
    const entry = input.overlay.folders[folderPath] ?? {};
    const projectArchived = Boolean(entry.archived);
    if (projectArchived && !includeArchived) {
      continue;
    }
    sessions.sort(byActivityDesc);
    projects.push({
      path: folderPath,
      name: entry.displayName?.trim() || path.basename(folderPath) || folderPath,
      archived: projectArchived,
      lastActivityAt: sessions[0]?.lastActivityAt ?? entry.lastUsedAt ?? null,
      sessions,
    });
  }
  projects.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
  chats.sort(byActivityDesc);

  return {
    projects,
    chats,
    lastUsedFolder: input.overlay.lastUsedFolder,
  };
}

function lastActivity(manifestMtimeMs: number, updatedAt: string): string {
  // task.updatedAt is the activity record: runs and status transitions
  // bump it; metadata edits (rename, archive) deliberately do not. The
  // manifest mtime would count those edits as activity and reorder the
  // sidebar — use it only when updatedAt is unparseable.
  const updatedMs = Date.parse(updatedAt);
  return new Date(Number.isFinite(updatedMs) ? updatedMs : manifestMtimeMs).toISOString();
}

function byActivityDesc(a: SessionSummary, b: SessionSummary): number {
  return b.lastActivityAt.localeCompare(a.lastActivityAt);
}
