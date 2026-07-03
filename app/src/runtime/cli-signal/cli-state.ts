import type { RuntimeEvent } from "../../shared/types/events";
import type {
  CliActivity,
  CliStateSnapshot,
  ClaudeHookPayload,
} from "../../shared/types/cli-signal";

/**
 * The one in-memory CLI-state model (Slice 1, Layer 1). UI-agnostic: it reduces
 * two input streams into a single `busy | idle | waiting-approval | turn-ended`
 * activity that the renderer subscribes to.
 *
 *  - PRIMARY: Claude hooks — `UserPromptSubmit`/`PreToolUse`→busy,
 *    `PermissionRequest`→waiting-approval (names the tool), `Stop`→turn-ended.
 *  - SAFETY NET: existing terminal-host signals — `prompt:submitted`→busy,
 *    `approval:detected`→waiting-approval, `approval:decision`→busy,
 *    `task:ready`→turn-ended (fallback if the Stop hook is absent), `pty:exit`
 *    →idle. With hooks disabled entirely this degrades to today's behavior.
 *
 * (OSC 9;4 is intentionally absent — Phase 0 found it does not arrive under
 * duet's spawn; the glyph-scrape/quiescence in StatusRegionTracker remains the
 * deeper net behind both feeds.)
 */
export class CliStateModel {
  private snapshot: CliStateSnapshot;
  private readonly now: () => string;

  constructor(
    private readonly onChange: (snapshot: CliStateSnapshot) => void,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.now = now;
    this.snapshot = {
      activity: "idle",
      tool: null,
      approvalKind: null,
      source: "init",
      changedAt: now(),
    };
  }

  current(): CliStateSnapshot {
    return this.snapshot;
  }

  /** Feed a parsed Claude hook payload (the primary signal). */
  applyHook(payload: ClaudeHookPayload): void {
    const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
    const tool = typeof payload.tool_name === "string" ? payload.tool_name : null;
    switch (event) {
      case "UserPromptSubmit":
        this.set("busy", { tool: null, approvalKind: null }, "hook:UserPromptSubmit");
        break;
      case "PreToolUse":
        this.set("busy", { tool, approvalKind: null }, "hook:PreToolUse");
        break;
      case "PostToolUse":
        this.set("busy", { tool: null, approvalKind: null }, "hook:PostToolUse");
        break;
      case "PermissionRequest":
        this.set("waiting-approval", { tool }, "hook:PermissionRequest");
        break;
      case "Stop":
        this.set("turn-ended", { tool: null, approvalKind: null }, "hook:Stop");
        break;
      case "StopFailure":
        // The turn ended by FAILING (API error after retries — probed S6).
        // Stop does not fire in this case, so without this the state sat
        // busy until the quiescence fallback.
        this.set("turn-ended", { tool: null, approvalKind: null }, "hook:StopFailure");
        break;
      case "Notification": {
        const kind = typeof payload.notification_type === "string" ? payload.notification_type : "";
        if (kind === "permission_prompt") {
          this.set("waiting-approval", { tool }, "hook:Notification(permission_prompt)");
        } else if (kind === "idle_prompt") {
          this.set("turn-ended", { tool: null, approvalKind: null }, "hook:Notification(idle_prompt)");
        }
        break;
      }
      case "SessionStart":
        // Session ready, no turn yet — only meaningful before the first turn.
        if (this.snapshot.activity === "idle") {
          this.set("idle", {}, "hook:SessionStart");
        }
        break;
      // SubagentStop: a subagent finished but the main turn continues — no change.
      default:
        break;
    }
  }

  /** Feed a terminal-host runtime event (corroboration / safety net). */
  applyRuntimeEvent(event: RuntimeEvent): void {
    switch (event.type) {
      case "prompt:submitted":
        this.set("busy", { tool: null, approvalKind: null }, "event:prompt:submitted");
        break;
      case "approval:detected":
        this.set(
          "waiting-approval",
          { approvalKind: event.payload.kind ?? null },
          "event:approval:detected",
        );
        break;
      case "approval:decision":
        this.set("busy", { approvalKind: null }, "event:approval:decision");
        break;
      case "task:ready":
        // Fallback only: if a turn was running and the Stop hook never landed,
        // the composer going idle ends the turn. Never downgrade a fresh idle.
        if (this.snapshot.activity === "busy") {
          this.set("turn-ended", { tool: null, approvalKind: null }, "event:task:ready");
        }
        break;
      case "pty:exit":
        this.set("idle", { tool: null, approvalKind: null }, "event:pty:exit");
        break;
      default:
        break;
    }
  }

  private set(
    activity: CliActivity,
    fields: { tool?: string | null; approvalKind?: string | null },
    source: string,
  ): void {
    const next: CliStateSnapshot = {
      activity,
      tool: fields.tool !== undefined ? fields.tool : this.snapshot.tool,
      approvalKind:
        fields.approvalKind !== undefined ? fields.approvalKind : this.snapshot.approvalKind,
      source,
      changedAt: this.snapshot.changedAt,
    };
    if (
      next.activity === this.snapshot.activity &&
      next.tool === this.snapshot.tool &&
      next.approvalKind === this.snapshot.approvalKind
    ) {
      return; // no meaningful change
    }
    next.changedAt = this.now();
    this.snapshot = next;
    this.onChange(next);
  }
}
