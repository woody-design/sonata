// Mid-session control-switch flows (S6 — moved verbatim from main.ts): the
// immediate-apply Claude switch (S1 model/effort, S2 permission), the STAGED
// model+effort Save (S7 Part 1), the parked recognized-confirm relay (S7 Part
// 2), and the shared refusal copy. Receipts drive the chip through the
// control-switch:state event, so the dispatches are fire-and-forget. Follows
// the session-flows pattern: the state atom and the one view-owned read
// (currentSessionModelPair) arrive init-bound from the composition root; the
// flow imports render + reading-core, never a view family.

import type { ClaudeControlSwitchKind, RuntimeProvider } from "../../shared/types";
import { errorMessage } from "../../reading-core/selectors/formatters";
import {
  activeTaskView as activeTaskViewOf,
  type RendererState,
  type TaskViewState,
} from "../../reading-core/state";
import { render } from "../render";

interface ControlSwitchDeps {
  /** The session's current (model, effort) pair (view/composer selector) — the
   *  staged-menu seed and the change-detection baseline for a Save. */
  currentSessionModelPair(
    view: TaskViewState,
    provider: RuntimeProvider,
  ): { model: string | null; effort: string | null };
}

let state: RendererState;
let deps: ControlSwitchDeps;

/** Bound once by main.ts at boot, before the first render (R4). */
export function initControlSwitchFlows(
  boundState: RendererState,
  boundDeps: ControlSwitchDeps,
): void {
  state = boundState;
  deps = boundDeps;
}

function activeTaskView(): TaskViewState | null {
  return activeTaskViewOf(state);
}

/** Drive a mid-session Claude control switch (S1 model/effort, S2 permission).
 *  Close the menu at once; the pending state and the receipt(s) (settled /
 *  failed / needs-attention) drive the chip through the control-switch:state
 *  event. `from` is the permission origin (the return-home anchor), ignored for
 *  model/effort. A refusal (a rare idle-gate race — the chip is disabled
 *  off-idle) surfaces as a one-line composer notice. */
export async function applyClaudeControlSwitch(
  view: TaskViewState,
  kind: ClaudeControlSwitchKind,
  value: string,
  from?: string,
): Promise<void> {
  const task = view.task;
  if (!task) {
    return;
  }
  state.composerMenu = null;
  render();
  try {
    const result = await window.sonataRuntime.switchClaudeControl({
      taskId: task.id,
      kind,
      value,
      ...(from ? { from } : {}),
    });
    if (!result.ok) {
      view.status = controlSwitchRefusalCopy(kind, result.reason);
      render();
    }
  } catch (error) {
    view.status = errorMessage(error);
    render();
  }
}

/** Apply a STAGED model+effort Save (S7 Part 1). Compares the staged pair to the
 *  session's current and dispatches the changed axes as ONE logical switch:
 *   - claude → `switchClaudeStaged` (the session-scoped picker drive: bare `/model`
 *     then `/effort`, applied with `s` — D2 U4; the cache-miss
 *     confirm relayed via the drawer between them);
 *   - codex → the existing `codex-model` two-level picker with the pair (value =
 *     staged model, from = staged effort as the level-2 target — one picker run).
 *  Save is disabled when clean, so this normally has a real change; a defensive
 *  no-change still closes the menu. The receipt(s) drive the chip via
 *  control-switch:state. */
export async function applyStagedModelSwitch(view: TaskViewState): Promise<void> {
  const task = view.task;
  const staged = state.composerMenu?.staged;
  if (!task || !staged) {
    return;
  }
  const provider = task.provider;
  const current = deps.currentSessionModelPair(view, provider);
  const modelChanged = staged.model !== current.model;
  const effortChanged = staged.effort !== current.effort;
  state.composerMenu = null;
  render();
  if (!modelChanged && !effortChanged) {
    return; // nothing to apply (defensive — Save is disabled when clean)
  }
  try {
    const result =
      provider === "codex"
        ? await window.sonataRuntime.switchClaudeControl({
            taskId: task.id,
            kind: "codex-model",
            // value = the staged model (or current, if only effort changed) — the
            // level-1 target; from = the staged effort — the level-2 target.
            value: staged.model ?? current.model ?? "",
            ...(staged.effort ? { from: staged.effort } : {}),
          })
        : await window.sonataRuntime.switchClaudeStaged({
            taskId: task.id,
            model: modelChanged ? staged.model : null,
            effort: effortChanged ? staged.effort : null,
          });
    if (!result.ok) {
      view.status = controlSwitchRefusalCopy(
        provider === "codex" ? "codex-model" : "model",
        result.reason,
      );
      render();
    }
  } catch (error) {
    view.status = errorMessage(error);
    render();
  }
}

/** Relay the user's chosen row for a PARKED recognized-confirm dialog (S7 Part 2).
 *  The choreography navigates the dialog's cursor there + Enters it; the settle
 *  (or needs-attention) arrives on control-switch:state, which clears the drawer.
 *  Fire-and-forget; a double-answer is ignored backend-side (phase left waiting). */
export async function applyControlConfirmAnswer(rowNumber: number): Promise<void> {
  const view = activeTaskView();
  const task = view?.task;
  if (!task) {
    return;
  }
  try {
    await window.sonataRuntime.answerControlConfirm({ taskId: task.id, rowNumber });
  } catch (error) {
    if (view) {
      view.status = errorMessage(error);
      render();
    }
  }
}

/** One-line reason a switch couldn't be kicked off (idle-gate races + PTY loss).
 *  User-facing, no CLI internals — the composer-notice register. */
export function controlSwitchRefusalCopy(
  kind: ClaudeControlSwitchKind,
  reason: "no-process" | "panel-open" | "busy" | "not-idle" | "wrong-provider" | "invalid",
): string {
  const axis =
    kind === "model" || kind === "codex-model"
      ? "model"
      : kind === "effort" || kind === "codex-effort"
        ? "reasoning"
        : "access";
  switch (reason) {
    case "not-idle":
      return `Finish the current turn before switching ${axis}.`;
    case "busy":
      return "Claude is mid-action — try again in a moment.";
    case "invalid":
      return `That ${axis} isn't available to switch to.`;
    case "panel-open":
      return "Claude is waiting on something in the CLI — answer that first.";
    case "no-process":
      return `This session isn't running — reopen it to switch ${axis}.`;
    default:
      return `Couldn't switch ${axis}.`;
  }
}
