import { withoutTaskTag } from "../shared/session-tags";
import type { Task, TaskId } from "../shared/types/domain";

export interface TagManifestCandidate {
  storageRoot: string;
  manifest: { task: Task };
}

export interface TagManifestMutation {
  storageRoot: string;
  task: Task;
  live: boolean;
}

/** Pure plan consumed by RuntimeController: every persisted manifest is
 * considered, while a live task remains the freshest task payload. */
export function planTagRemovalFromManifests(
  candidates: readonly TagManifestCandidate[],
  liveTasks: ReadonlyMap<TaskId, Task>,
  tagId: string,
): TagManifestMutation[] {
  const mutations: TagManifestMutation[] = [];
  for (const candidate of candidates) {
    const persisted = candidate.manifest.task;
    const liveTask = liveTasks.get(persisted.id);
    if (!persisted.tags?.includes(tagId) && !liveTask?.tags?.includes(tagId)) {
      continue;
    }
    const task = withoutTaskTag(liveTask ?? persisted, tagId);
    mutations.push({ storageRoot: candidate.storageRoot, task, live: Boolean(liveTask) });
  }
  return mutations;
}
