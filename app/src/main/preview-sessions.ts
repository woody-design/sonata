import type { PreviewSession, TaskId } from "../shared/types";
import type { PreviewSessionsStore } from "./settings-store";

/** Coalesce disk writes during rapid tab churn; in-memory state stays current
 *  (modeled on WindowStateManager's debounce). */
const PERSIST_DEBOUNCE_MS = 400;

/**
 * PreviewSessions — the session-truth store (design record §6.1). Per task:
 * ordered tab claims, the active path, per-path scroll, and the folder-panel
 * flag. Owned by main, durable. Mutations happen ONLY through named
 * transitions (open / close / activate / reorder / setScroll / setPanel), each
 * carrying its policy — the old `mergeTabs` reconciler existed only because
 * view truth (dirty/reviewed) had leaked into main state, and is gone with the
 * leak.
 *
 * MRU order is tracked per task (in memory, not persisted): closing the active
 * tab activates the most-recently-used survivor, the editor convention our
 * "opener" in another window makes correct. After a restart MRU re-seeds from
 * tab order — a fresh projection owes nothing to the previous run.
 */
export class PreviewSessions {
  private readonly store: PreviewSessionsStore;
  private readonly sessions = new Map<TaskId, PreviewSession>();
  private readonly mru = new Map<TaskId, string[]>();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(store: PreviewSessionsStore) {
    this.store = store;
    for (const [taskId, session] of Object.entries(store.read().sessions)) {
      this.sessions.set(taskId, session);
      // Seed MRU from tab order with the active tab first, so a restored
      // session's first close-active picks a sensible neighbor.
      const order = session.tabs.map((tab) => tab.path);
      if (session.activePath) {
        this.mru.set(taskId, [session.activePath, ...order.filter((p) => p !== session.activePath)]);
      } else {
        this.mru.set(taskId, order);
      }
    }
  }

  /** The bound task's session, or a fresh empty one (never null — an unclaimed
   *  task simply has no tabs yet). */
  session(taskId: TaskId): PreviewSession {
    return this.sessions.get(taskId) ?? emptySession(taskId);
  }

  hasSession(taskId: TaskId): boolean {
    return this.sessions.has(taskId);
  }

  /** Open a tab, or focus the existing tab for that path (§4: every open is a
   *  new tab; an already-open path focuses, never a second slot). */
  open(taskId: TaskId, path: string): PreviewSession {
    const session = this.mutable(taskId);
    if (!session.tabs.some((tab) => tab.path === path)) {
      session.tabs.push({ path });
    }
    session.activePath = path;
    this.touchMru(taskId, path);
    return this.commit(taskId, session);
  }

  activate(taskId: TaskId, path: string): PreviewSession {
    const session = this.mutable(taskId);
    if (!session.tabs.some((tab) => tab.path === path)) {
      return session;
    }
    session.activePath = path;
    this.touchMru(taskId, path);
    return this.commit(taskId, session);
  }

  /** Close a tab. When it was the active tab, activate the MRU survivor (not the
   *  right neighbor). Scroll for the closed path is dropped. */
  close(taskId: TaskId, path: string): PreviewSession {
    const session = this.mutable(taskId);
    const index = session.tabs.findIndex((tab) => tab.path === path);
    if (index === -1) {
      return session;
    }
    session.tabs.splice(index, 1);
    delete session.scroll[path];
    this.dropMru(taskId, path);
    if (session.activePath === path) {
      session.activePath = this.pickNextActive(taskId, session);
    }
    return this.commit(taskId, session);
  }

  /** Reorder tabs to match `paths` (a permutation of the current set); unknown
   *  or missing paths are ignored so a stale reorder can't corrupt the set. */
  reorder(taskId: TaskId, paths: string[]): PreviewSession {
    const session = this.mutable(taskId);
    const byPath = new Map(session.tabs.map((tab) => [tab.path, tab]));
    const next: PreviewSession["tabs"] = [];
    for (const path of paths) {
      const tab = byPath.get(path);
      if (tab && !next.includes(tab)) {
        next.push(tab);
      }
    }
    // Preserve any tab the reorder omitted (defensive against a stale list).
    for (const tab of session.tabs) {
      if (!next.includes(tab)) {
        next.push(tab);
      }
    }
    session.tabs = next;
    return this.commit(taskId, session);
  }

  /** Record a tab's scroll offset. Write-only: no echo (echoing scroll would
   *  fight the user's live scrolling). Ignored for a path with no tab. */
  setScroll(taskId: TaskId, path: string, scroll: number): void {
    const session = this.sessions.get(taskId);
    if (!session || !session.tabs.some((tab) => tab.path === path)) {
      return;
    }
    session.scroll[path] = Math.max(0, scroll);
    this.scheduleFlush();
  }

  setPanel(taskId: TaskId, open: boolean): PreviewSession {
    const session = this.mutable(taskId);
    session.panelOpen = open;
    return this.commit(taskId, session);
  }

  /** Delete a task's claims entirely (session deleted — no dormant record to
   *  return to). Close/archive keep the claims; only a true delete forgets. */
  forget(taskId: TaskId): void {
    if (!this.sessions.delete(taskId)) {
      return;
    }
    this.mru.delete(taskId);
    this.scheduleFlush();
  }

  /** Write pending state synchronously. Safe to call from `before-quit`. */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.write();
  }

  private mutable(taskId: TaskId): PreviewSession {
    let session = this.sessions.get(taskId);
    if (!session) {
      session = emptySession(taskId);
      this.sessions.set(taskId, session);
    }
    return session;
  }

  private commit(taskId: TaskId, session: PreviewSession): PreviewSession {
    // An empty session leaves no durable claim — drop it so the document doesn't
    // accrete empty per-task records (its MRU goes too).
    if (session.tabs.length === 0 && !session.panelOpen) {
      this.sessions.delete(taskId);
      this.mru.delete(taskId);
    }
    this.scheduleFlush();
    return this.session(taskId);
  }

  private pickNextActive(taskId: TaskId, session: PreviewSession): string | null {
    const present = new Set(session.tabs.map((tab) => tab.path));
    for (const path of this.mru.get(taskId) ?? []) {
      if (present.has(path)) {
        return path;
      }
    }
    return session.tabs.at(-1)?.path ?? null;
  }

  private touchMru(taskId: TaskId, path: string): void {
    const order = this.mru.get(taskId) ?? [];
    this.mru.set(taskId, [path, ...order.filter((entry) => entry !== path)]);
  }

  private dropMru(taskId: TaskId, path: string): void {
    const order = this.mru.get(taskId);
    if (order) {
      this.mru.set(
        taskId,
        order.filter((entry) => entry !== path),
      );
    }
  }

  private scheduleFlush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.write();
    }, PERSIST_DEBOUNCE_MS);
  }

  private write(): void {
    try {
      const sessions: Record<TaskId, PreviewSession> = {};
      for (const [taskId, session] of this.sessions) {
        sessions[taskId] = session;
      }
      this.store.write({ sessions });
    } catch {
      // A failed session write must never crash the app — at worst the tab set
      // re-defaults on next launch.
    }
  }
}

function emptySession(taskId: TaskId): PreviewSession {
  return { taskId, tabs: [], activePath: null, scroll: {}, panelOpen: false };
}
