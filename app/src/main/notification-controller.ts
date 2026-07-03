import { Notification } from "electron";
import type { RuntimeEvent } from "../shared/types/events";
import type { RuntimeProvider, TaskId } from "../shared/types/domain";
import { NotificationPolicy, type NotificationDecision } from "./notification-policy";

/** A shown notification, abstracted so the controller is testable and
 *  Electron-decoupled. The real implementation wraps `electron.Notification`. */
export interface NotificationHandle {
  show(): void;
  onClick(callback: () => void): void;
  onClose(callback: () => void): void;
}

/** Builds a notification, or returns null when the OS cannot show one. */
export type Notifier = (content: { title: string; body: string }) => NotificationHandle | null;

/** The bits of a task the copy needs, resolved from the live task registry. */
export interface TaskMeta {
  title: string | null;
  provider: RuntimeProvider;
}

export interface NotificationControllerOptions {
  /** Raise the main window and select the task the notification is about. */
  activateTask: (taskId: TaskId) => void;
  /**
   * The task's CURRENT name + provider, pulled at fire time from the live task
   * registry (the source of truth). Reading it here — rather than inferring a
   * title from runtime events — keeps a renamed session correct and works for a
   * task the controller never saw created (Local-API-opened, post-reload).
   * Null when the task is not live.
   */
  resolveTaskMeta: (taskId: TaskId) => TaskMeta | null;
  /** Override the platform notifier (tests). Defaults to native macOS. */
  notifier?: Notifier;
  /** Override the "you were still watching" floor (tests). */
  completeFloorMs?: number;
}

/** Per-provider agent name, so a Codex task never reads "Claude". Falls back to
 *  the neutral "Agent" when the provider is unknown (task not live). */
const AGENT_LABEL: Record<RuntimeProvider, string> = {
  claude: "Claude",
  codex: "Codex",
};
const NEUTRAL_LABEL = "Agent";

/** Fall back to the app name when a task has no human-readable title yet, and
 *  never surface the auto-title placeholders (they read as noise). */
const FALLBACK_TITLE = "Duet";
const PLACEHOLDER_TITLES = new Set(["New Task", "Walking Skeleton Task", "New Chat"]);

/**
 * Turns the pure {@link NotificationPolicy}'s decisions into native macOS
 * notifications. This is the thin impure shell: it owns the platform notifier,
 * the copy, and the click→focus wiring. It taps the runtime event fan-out and
 * writes no state back.
 *
 * Copy mirrors the reference CLIs' own notifications: a short state phrase, no
 * reply preview. The title carries the task name — the one thing a multi-task
 * host needs that a single-session CLI does not.
 */
export class NotificationController {
  private readonly policy: NotificationPolicy;
  private readonly activateTask: (taskId: TaskId) => void;
  private readonly resolveTaskMeta: (taskId: TaskId) => TaskMeta | null;
  private readonly notify: Notifier;
  /**
   * Held so the click/close handlers survive GC. On macOS Electron collects the
   * Notification (and its onClick) if nothing references it, and the banner goes
   * dead in Notification Center after a couple of minutes.
   */
  private readonly live = new Set<NotificationHandle>();

  constructor(options: NotificationControllerOptions) {
    this.policy = new NotificationPolicy(
      options.completeFloorMs === undefined ? {} : { completeFloorMs: options.completeFloorMs },
    );
    this.activateTask = options.activateTask;
    this.resolveTaskMeta = options.resolveTaskMeta;
    this.notify = options.notifier ?? electronNotifier;
  }

  handleEvent(event: RuntimeEvent): void {
    try {
      const decision = this.policy.observe(event);
      if (decision) {
        this.fire(decision);
      }
    } catch (error) {
      // A notification must never break the event fan-out that feeds the app.
      console.error("[notifications] handleEvent failed:", error);
    }
  }

  private fire(decision: NotificationDecision): void {
    const meta = this.resolveTaskMeta(decision.taskId);
    const agent = meta ? AGENT_LABEL[meta.provider] ?? NEUTRAL_LABEL : NEUTRAL_LABEL;
    const handle = this.notify({
      title: cleanTitle(meta?.title) ?? FALLBACK_TITLE,
      body: decision.kind === "complete" ? `${agent} finished` : `${agent} needs your input`,
    });
    if (!handle) {
      return;
    }
    const drop = (): void => {
      this.live.delete(handle);
    };
    handle.onClick(() => {
      this.activateTask(decision.taskId);
      drop();
    });
    handle.onClose(drop);
    this.live.add(handle);
    handle.show();
  }
}

function cleanTitle(raw: string | null | undefined): string | null {
  const title = raw?.trim();
  return title && !PLACEHOLDER_TITLES.has(title) ? title : null;
}

/** The default notifier: a native macOS notification with the system sound
 *  (`silent` omitted). Returns null when the OS cannot show one. */
function electronNotifier(content: { title: string; body: string }): NotificationHandle | null {
  if (!Notification.isSupported()) {
    return null;
  }
  const notification = new Notification({ title: content.title, body: content.body });
  return {
    show: () => notification.show(),
    onClick: (callback) => notification.on("click", callback),
    onClose: (callback) => notification.on("close", callback),
  };
}
