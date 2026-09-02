import type { RuntimeEvent } from "../../shared/types/events";
import type {
  CliActivity,
  CliStateSnapshot,
  HookPayload,
} from "../../shared/types/cli-signal";
import type { TurnEndWake } from "../../shared/types/domain";

/**
 * The one in-memory CLI-state model (Slice 1, Layer 1). UI-agnostic: it reduces
 * two input streams into a single `busy | idle | waiting-approval | turn-ended`
 * activity that the renderer subscribes to.
 *
 *  - PRIMARY: standard-contract hooks (Claude Code today, Codex on the same
 *    schema) — `UserPromptSubmit`/`PreToolUse`→busy, `PermissionRequest`→
 *    waiting-approval (names the tool), `Stop`→turn-ended, plus the two
 *    provider-specific turn endings that fire INSTEAD of `Stop`:
 *    `StopFailure` (claude, API error) and `Interrupt` (codex, user interrupt).
 *  - SAFETY NET: existing terminal-host signals — `prompt:submitted`→busy,
 *    `approval:detected`→waiting-approval, `approval:decision`→busy,
 *    `task:ready`→turn-ended (fallback if the Stop hook is absent), `pty:exit`
 *    →idle. With hooks disabled entirely this degrades to today's behavior.
 *
 * (OSC 9;4 is intentionally absent — Phase 0 found it does not arrive under
 * sonata's spawn; the glyph-scrape/quiescence in StatusRegionTracker remains the
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
      turnEndWake: null,
      source: "init",
      changedAt: now(),
    };
  }

  current(): CliStateSnapshot {
    return this.snapshot;
  }

  /**
   * Feed a parsed standard-contract hook payload (the primary signal).
   *
   * `turnEndWake` (SL-16) is what the caller's `BackgroundWorkTracker` made of
   * this payload's `background_tasks`, and it is passed IN rather than derived
   * here for one reason: the answer is stateful (it depends on what was already
   * running before this turn), so there must be exactly one memory. The
   * controller advances that memory once and hands the same value to this model
   * and to the run record — which is what keeps the live state and the durable
   * record from disagreeing. Omitted on every non-turn-ending hook, and on a
   * turn ending whose payload said nothing about background work at all.
   */
  applyHook(payload: HookPayload, options: { turnEndWake?: TurnEndWake } = {}): void {
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
        this.endTurn(options.turnEndWake, "hook:Stop");
        break;
      case "StopFailure":
        // The turn ended by FAILING (API error after retries — probed S6).
        // Stop does not fire in this case, so without this the state sat
        // busy until the quiescence fallback.
        //
        // It takes the wake through the SAME path as `Stop` (SL-16 review M1).
        // The first cut stamped the run record here but left this branch reading
        // no payload, so a failed turn that had left a shell running emitted
        // `pendingWake: null` and fired the very double-notification this slice
        // removes. Whether `StopFailure` actually carries `background_tasks` is
        // UNMEASURED at 2.1.258 — which is exactly why the fix must be
        // shape-tolerant rather than conditional: if the field is absent the
        // tracker returns null, this is byte-identical to before, and if it is
        // present a failed turn is treated like any other ending.
        this.endTurn(options.turnEndWake, "hook:StopFailure");
        break;
      case "Interrupt":
        // The turn ended by being INTERRUPTED (codex only, MEASURED 0.152.1 —
        // SL-9). Same shape as StopFailure: codex fires no `Stop` for an
        // interrupted turn, so without this the activity sat `busy` until the
        // `task:ready` quiescence fallback caught up. This model is
        // provider-agnostic by design and claude never emits the event, so no
        // provider gate is needed — and for the same reason the wake it is
        // handed is always null (codex carries no `background_tasks`), which
        // keeps this branch byte-identical while routing through one path.
        this.endTurn(options.turnEndWake, "hook:Interrupt");
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
      //
      // SL-16 considered it for the pause signal and DECIDED AGAINST, on
      // evidence rather than omission. It carries `background_tasks` /
      // `session_crons` with the same keys (MEASURED, z1: the SubagentStop 1.5s
      // after the parent `Stop` named the SAME running shell), so wiring it here
      // would restate one fact twice — and worse, it would state it at a moment
      // when it is false: a `SubagentStop` normally lands mid-turn, while the
      // session is WORKING, and "paused waiting for background work" is not true
      // of a live turn. The pause is a property of the MAIN turn's ending, so
      // `Stop` is its only honest carrier. Deliberate no-op, not an oversight.
      //
      // PostModelSwitch (claude, INJECTED since D2 U3): also a deliberate no-op,
      // and it has to be. A mid-session model switch happens at an IDLE composer —
      // the engine refuses to start one while a run is live — so it is not the
      // beginning or the end of a turn, and moving this model off `idle` because a
      // model changed would make the composer's send gate lie about whether the CLI
      // is working. The switch's own state lives on the control-switch event
      // stream, which is a different question with a different SSOT. Pinned by
      // `tests/smoke/cli-signal-state.mjs`.
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

  /**
   * The ONE turn-ending path (SL-16 review M1): every main-turn ending — `Stop`,
   * `StopFailure`, `Interrupt` — carries its background-work verdict the same
   * way, so no ending can be given the model's attention while being left out of
   * the pause accounting. `source` still names which hook it was.
   *
   * An omitted verdict (the payload said nothing) leaves the last claim standing
   * rather than clearing it — see `set`.
   */
  private endTurn(turnEndWake: TurnEndWake | undefined, source: string): void {
    this.set(
      "turn-ended",
      {
        tool: null,
        approvalKind: null,
        ...(turnEndWake ? { turnEndWake } : {}),
      },
      turnEndWake?.opened ? `${source}(background work pending)` : source,
    );
  }

  private set(
    activity: CliActivity,
    fields: {
      tool?: string | null;
      approvalKind?: string | null;
      turnEndWake?: TurnEndWake;
    },
    source: string,
  ): void {
    const next: CliStateSnapshot = {
      activity,
      tool: fields.tool !== undefined ? fields.tool : this.snapshot.tool,
      approvalKind:
        fields.approvalKind !== undefined ? fields.approvalKind : this.snapshot.approvalKind,
      // The invariant stated ONCE, where it cannot be forgotten by a caller:
      // `turnEndWake` qualifies `turn-ended` and nothing else. Any transition
      // back into a live state (busy / waiting-approval) or into `idle` (a dead
      // PTY) ends the pause by definition — the session is no longer waiting to
      // be woken, it is awake or gone. Only a turn end carries the field
      // forward, and only a payload that actually SPOKE about background work
      // may change it (an omitted verdict keeps the last claim, which is what
      // makes claude's post-turn `Notification(idle_prompt)` — a second
      // `turn-ended` 60s later, carrying none of these fields — harmless).
      turnEndWake:
        activity !== "turn-ended"
          ? null
          : fields.turnEndWake !== undefined
            ? fields.turnEndWake
            : this.snapshot.turnEndWake,
      source,
      changedAt: this.snapshot.changedAt,
    };
    if (
      next.activity === this.snapshot.activity &&
      next.tool === this.snapshot.tool &&
      next.approvalKind === this.snapshot.approvalKind &&
      sameTurnEndWake(next.turnEndWake, this.snapshot.turnEndWake)
    ) {
      return; // no meaningful change
    }
    next.changedAt = this.now();
    this.snapshot = next;
    this.onChange(next);
  }
}

/**
 * Structural, not identity: two turn ends can produce equal-but-distinct
 * verdicts, and an identity compare would emit a spurious change for each. The
 * other direction is what makes this load-bearing rather than tidy — a turn end
 * that opened a pause followed by one that reports the work RETURNED is a real
 * transition with NO activity change, and it is exactly the F43 revival's only
 * signature on this wire (that wake fires no `UserPromptSubmit`, so nothing else
 * moves). Without a value compare here the dedup would swallow it and the held
 * completion notification would never fire.
 */
function sameTurnEndWake(a: TurnEndWake | null, b: TurnEndWake | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if (a.returned !== b.returned) {
    return false;
  }
  const left = a.opened?.tasks ?? [];
  const right = b.opened?.tasks ?? [];
  return (
    left.length === right.length &&
    left.every((task, index) => task.id === right[index]?.id && task.kind === right[index]?.kind)
  );
}
