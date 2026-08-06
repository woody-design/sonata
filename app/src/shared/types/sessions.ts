import type { DeliveryTaskState, Task, TaskStatus } from "./domain";
import type { TranscriptBlock, TranscriptSourceRef } from "./transcript";
import type { RuntimeReportV1 } from "../schemas/runtime-report";

/**
 * Sidebar vocabulary: a "session" is one conversation thread with an agent
 * in a folder (today's Task — the code-level rename is a later mechanical
 * slice). A "project" is a working folder derived from the distinct
 * providerCwd values across session manifests; it is never stored as its
 * own entity. Sessions in Sonata auto-workspaces (no user-picked folder)
 * group under "Chats".
 */

export interface SessionSummary {
  task: Task;
  storageRoot: string;
  archived: boolean;
  /** A PTY for this session is alive in this app instance. */
  live: boolean;
  /** Live runtime status; null when dormant. */
  liveStatus: TaskStatus | null;
  /** Last persisted activity (manifest mtime), ISO timestamp. */
  lastActivityAt: string;
}

export interface ProjectGroup {
  /** Absolute working-folder path (providerCwd). */
  path: string;
  /** Display name: overlay override, else folder basename. */
  name: string;
  archived: boolean;
  lastActivityAt: string | null;
  /** Newest first. Archived sessions excluded unless includeArchived. */
  sessions: SessionSummary[];
}

export interface SessionIndexResponse {
  /** Ordered by lastActivityAt desc. */
  projects: ProjectGroup[];
  /** Auto-workspace sessions ("Chats" section), newest first. */
  chats: SessionSummary[];
  /** New Chat preselects this folder. */
  lastUsedFolder: string | null;
}

export interface ReadSessionIndexRequest {
  includeArchived?: boolean;
}

export interface ReadSessionSnapshotRequest {
  taskId: string;
}

/**
 * One-shot read of a session's full reading surface — transcript, runs,
 * sources — straight from disk. Never spawns a PTY: this is the read half
 * of the read/write separation; browsing history is free.
 */
export interface SessionSnapshotResponse {
  task: Task;
  live: boolean;
  report: RuntimeReportV1 | null;
  sources: TranscriptSourceRef[];
  blocks: TranscriptBlock[];
  /**
   * The live delivery state as of this read — the SAME value a `delivery:state`
   * event carries, straight off the controller, not a parallel projection.
   *
   * It is here because `delivery:state` events are deltas: they fire when the
   * delivery state CHANGES (S1), so a view created after the last change would
   * otherwise never learn the state at all and read as a still-booting session
   * forever. A new listener pulls current state once, here, and follows the
   * deltas after. Null for a dormant session — there is no controller, and
   * "unknown" is the honest answer rather than a fabricated idle state.
   */
  delivery: DeliveryTaskState | null;
}
