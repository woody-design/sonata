import type {
  RenameSessionResponse,
  RuntimeEvent,
  TagDefinition,
  TagGroup,
  Task,
  TaskId,
} from "../shared/types";
import type { TaskManifestV1 } from "../shared/schemas";
import type { TagsStore } from "./tags-store";
import type { TagManifestCandidate } from "./tag-manifests";
import { planTagRemovalFromManifests } from "./tag-manifests";
import { retainKnownTagIds, withTaskTags } from "../shared/session-tags";

type SessionsUpdatedReason =
  | "session-created"
  | "session-updated"
  | "session-renamed"
  | "session-archived"
  | "session-deleted"
  | "project-updated";

/** A live runtime as SessionMetadata sees it: its task record, where it
 *  persists, and the ability to be retired (the archive path stops the PTY).
 *  `ActiveTaskRuntime` satisfies this — mutating `task` here mutates the shared
 *  runtime object the controller still holds. */
export interface SessionMetadataLiveSession {
  task: Task;
  storageRoot: string;
  /** The last automatically applied undated title. A user rename clears it so a
   *  later provider-session name cannot overwrite the user's choice. */
  autoTitle: string | null;
}

/** The controller-owned operations SessionMetadata needs. Mirrors the S4
 *  host-seam pattern (ControlSwitchEngine): thin callbacks closing over the
 *  controller, so the metadata facade owns the orchestration while the
 *  controller keeps the shared runtime/manifest primitives. */
export interface SessionMetadataHost {
  liveSession(taskId: TaskId): SessionMetadataLiveSession | null;
  /** Live tasks keyed by id — the freshest task payload for the tag-removal plan. */
  liveTasks(): Map<TaskId, Task>;
  requirePersistedSession(taskId: TaskId): { storageRoot: string; manifest: TaskManifestV1 };
  manifestCandidates(): TagManifestCandidate[];
  persistManifest(
    task: Task,
    storageRoot: string,
    reason?: "session-updated" | "session-renamed",
    emitUpdate?: boolean,
  ): void;
  emitSessionsUpdated(reason: SessionsUpdatedReason): void;
  sendEvent(event: RuntimeEvent): void;
  /** Stop a live session's PTY and drop it from the authoritative map;
   *  disposeTaskRuntime persists the manifest with the current flags applied. */
  retireLiveSession(session: SessionMetadataLiveSession): void;
}

/**
 * The tags / rename / archive facade, moved out of RuntimeController so the
 * controller keeps only thin IPC delegation. Rename and archive are metadata
 * (updatedAt stays put so the sidebar ordering never jumps); tag edits validate
 * ids against the live vocabulary before they touch a manifest. Each operation
 * has the same live-vs-persisted shape: mutate the live runtime in place when
 * one exists, otherwise rewrite the persisted manifest directly.
 */
export class SessionMetadataService {
  constructor(
    private readonly host: SessionMetadataHost,
    private readonly tagsStore: TagsStore,
  ) {}

  renameSession(taskId: TaskId, title: string): RenameSessionResponse {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session title must not be empty.");
    }
    // Renaming is metadata, not activity — leave updatedAt alone so the
    // session keeps its place in the sidebar ordering.
    const live = this.host.liveSession(taskId);
    if (live) {
      // Persist the candidate before publishing it to the live runtime. A
      // failed atomic write must leave both memory and the old manifest intact.
      const candidate = { ...live.task, title: trimmed, titleOrigin: "user" as const };
      this.host.persistManifest(candidate, live.storageRoot, "session-renamed", false);
      live.task = candidate;
      live.autoTitle = null;
      this.host.emitSessionsUpdated("session-renamed");
      this.host.sendEvent({
        type: "task:updated",
        payload: { taskId, task: candidate, reason: "session-renamed" },
        ts: new Date().toISOString(),
      });
      return { task: candidate };
    }
    const record = this.host.requirePersistedSession(taskId);
    const candidate = {
      ...record.manifest.task,
      title: trimmed,
      titleOrigin: "user" as const,
    };
    this.host.persistManifest(candidate, record.storageRoot, "session-renamed");
    return { task: candidate };
  }

  archiveSession(taskId: TaskId, archived: boolean): void {
    // Like rename, the archive flag is metadata — updatedAt stays put.
    const live = this.host.liveSession(taskId);
    if (live) {
      // Archiving a running session stops its PTY first; disposeTaskRuntime
      // persists the manifest with the flag already applied.
      live.task = { ...live.task, archived };
      if (archived) {
        this.host.retireLiveSession(live);
      } else {
        this.host.persistManifest(live.task, live.storageRoot);
      }
      return;
    }
    const record = this.host.requirePersistedSession(taskId);
    this.host.persistManifest({ ...record.manifest.task, archived }, record.storageRoot);
  }

  setSessionTags(taskId: TaskId, tagIds: string[]): void {
    // Validate ids against the live vocabulary before they touch a manifest: a
    // stale renderer can send a just-deleted id (its delete-time manifest scrub
    // has already run), which would persist as a permanent orphan. Unknown ids
    // are silently dropped, not rejected — a stale renderer is not an error.
    const validTagIds = retainKnownTagIds(tagIds, this.tagsStore.list());
    // Like archive, tag selection is metadata — updatedAt stays put.
    const live = this.host.liveSession(taskId);
    if (live) {
      live.task = withTaskTags(live.task, validTagIds);
      this.host.persistManifest(live.task, live.storageRoot);
      return;
    }
    const record = this.host.requirePersistedSession(taskId);
    this.host.persistManifest(
      withTaskTags(record.manifest.task, validTagIds),
      record.storageRoot,
    );
  }

  listTags(): TagDefinition[] {
    return this.tagsStore.list();
  }

  createTag(label: string, group: TagGroup): TagDefinition {
    return this.tagsStore.create(label, group);
  }

  deleteTag(id: string): void {
    this.tagsStore.delete(id);
    const mutations = planTagRemovalFromManifests(
      this.host.manifestCandidates(),
      this.host.liveTasks(),
      id,
    );
    for (const mutation of mutations) {
      const live = this.host.liveSession(mutation.task.id);
      if (live) {
        live.task = mutation.task;
        this.host.persistManifest(live.task, mutation.storageRoot, "session-updated", false);
        continue;
      }
      this.host.persistManifest(mutation.task, mutation.storageRoot, "session-updated", false);
    }
    this.host.emitSessionsUpdated("session-updated");
  }
}
