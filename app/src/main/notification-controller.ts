import { Notification } from "electron";
import type { RuntimeEvent } from "../shared/types/events";
import type { TaskId } from "../shared/types/domain";
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

export interface NotificationControllerOptions {
  /** Raise the main window and select the task the notification is about. */
  activateTask: (taskId: TaskId) => void;
  /** Override the platform notifier (tests). Defaults to native macOS. */
  notifier?: Notifier;
  /** Override the "you were still watching" floor (tests). */
  completeFloorMs?: number;
}

/** Copy mirrors Claude Code's own notifications: a short state phrase, no reply
 *  preview. The title carries the task name — the one thing a multi-task host
 *  needs that a single-session CLI does not. */
const BODY: Record<NotificationDecision["kind"], string> = {
  complete: "Claude finished",
  "needs-you": "Claude needs your input",
};

/** Fall back to the app name when a task has no human-readable title yet, and
 *  never surface the auto-title placeholders (they read as noise). */
const FALLBACK_TITLE = "Duet";
const PLACEHOLDER_TITLES = new Set(["New Task", "Walking Skeleton Task", "New Chat"]);

/**
 * Turns the pure {@link NotificationPolicy}'s decisions into native macOS
 * notifications. This is the thin impure shell: it owns the platform notifier,
 * the per-task display name, and the click→focus wiring. It taps the runtime
 * event fan-out and writes no state back.
 */
export class NotificationController {
  private readonly policy: NotificationPolicy;
  private readonly activateTask: (taskId: TaskId) => void;
  private readonly notify: Notifier;
  private readonly titles = new Map<string, string>();
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
    this.notify = options.notifier ?? electronNotifier;
  }

  handleEvent(event: RuntimeEvent): void {
    try {
      this.rememberTitle(event);
      const decision = this.policy.observe(event);
      if (decision) {
        this.fire(decision);
      }
    } catch (error) {
      // A notification must never break the event fan-out that feeds the app.
      console.error("[notifications] handleEvent failed:", error);
    }
  }

  private rememberTitle(event: RuntimeEvent): void {
    if (event.type === "task:updated") {
      this.setTitle(event.payload.taskId, event.payload.task?.title);
    } else if (event.type === "run:started") {
      // The user-editable session name (task:updated) wins; a run title only
      // fills the gap before one exists.
      if (!this.titles.has(event.payload.taskId)) {
        this.setTitle(event.payload.taskId, event.payload.title);
      }
    }
  }

  private setTitle(taskId: string, raw: string | undefined): void {
    const title = raw?.trim();
    if (title && !PLACEHOLDER_TITLES.has(title)) {
      this.titles.set(taskId, title);
    }
  }

  private fire(decision: NotificationDecision): void {
    const handle = this.notify({
      title: this.titles.get(decision.taskId) ?? FALLBACK_TITLE,
      body: BODY[decision.kind],
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
