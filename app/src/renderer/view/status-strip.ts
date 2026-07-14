// ——— Status strip (S5) ———————————————————————————————————————————————————
// The slim live-activity surface that replaced the workflow strip's machine
// headline AND the per-turn working-detail row (contract §3.4 / §4). Two
// areas, updated on different cadences so render hygiene holds:
//  - status: the provider's native status region verbatim (display-only relay
//    from StatusRegionTracker — if the scrape breaks, a string goes stale,
//    nothing acts), with Duet's derived "current step" voice as the fallback
//    while a run is active, and the stall voice at "silent" liveness. Text
//    only — safe to rebuild at the ~3Hz relay cadence.
//  - agents: every subagent currently running, from the transcript-derived
//    roster blocks (the same source the work trace renders; probe p5b showed
//    SubagentStart/Stop hooks work too, but a second roster machine would
//    duplicate this one — findings 2026-07-02). Signature-guarded: rebuilt
//    only when membership/status changes, so the working-dots animation runs
//    free and the 1s ticker owns the clocks.
// Visible only while something is happening: an active run, or a background
// subagent still working after its launch turn ended (async agents outlive
// their turn — probe p5b).
//
// (map §3.1 renderer/view/status-strip.ts, D3 — moved verbatim from main.ts.
// The T1 1s ticker that feeds the strip's data-started-at/data-silent-since
// clocks stays in the shell — it is boot wiring over `elements`, scheduler.ts
// territory at D4b, not a render path of this family.)

import type { AgentRunItem } from "../../shared/types/transcript";
import { formatLiveElapsed } from "../../reading-core/selectors/formatters";
import {
  deriveCurrentStepForView,
  stripRunningAgents,
} from "../../reading-core/selectors/turns";
import { hasActiveRun } from "../../reading-core/selectors/runs";
import { isReadingNearBottom } from "../../reading-core/reading-scroll";
import {
  activeTaskView,
  type RendererState,
  type TaskViewState,
} from "../../reading-core/state";
import { elements } from "../dom";
import { actions } from "../actions";

/** The shell's state atom, bound once at boot for the strip's read paths. */
let state: RendererState;

export function initStatusStripView(stateRef: RendererState): void {
  state = stateRef;
}

/** The strip lives inside the reading scroll flow (its last child) — any
 *  mutation that can change its height must keep a bottom-pinned view pinned
 *  (the typing-indicator contract: the live edge stays in sight). Reads the
 *  pin BEFORE mutating, restores it after; a reader scrolled up is left
 *  exactly where they are. */
function withReadingBottomPin(mutate: () => void): void {
  const runList = elements.runList;
  const nearBottom = isReadingNearBottom(runList);
  mutate();
  if (nearBottom) {
    runList.scrollTop = runList.scrollHeight;
  }
}

export function renderStatusStrip(view = activeTaskView(state)): void {
  withReadingBottomPin(() => {
    const strip = elements.statusStrip;
    const runningAgents = view?.task ? stripRunningAgents(view) : [];
    const activeRun = view?.task ? hasActiveRun(view) : false;
    const visible = Boolean(view?.task && (activeRun || runningAgents.length > 0));
    strip.classList.toggle("hidden", !visible);
    if (!visible || !view) {
      strip.classList.remove("quiet", "silent");
      elements.statusStripStatus.replaceChildren();
      elements.statusStripAgents.replaceChildren();
      elements.statusStripAgents.classList.add("hidden");
      delete elements.statusStripAgents.dataset.sig;
      return;
    }
    renderStripStatus(view, activeRun);
    renderStripAgents(runningAgents);
  });
}

/** The ~3Hz native-relay path: refresh ONLY the status area (text nodes; no
 *  CSS animation lives there) — never the agents area, whose working dots
 *  must not restart on a status tick. */
export function updateStatusStripStatusInPlace(view: TaskViewState): void {
  if (elements.statusStrip.classList.contains("hidden")) {
    // A native tick can arrive before any run/render pass showed the strip
    // (hook-begun run) — fall through to the full strip render once.
    renderStatusStrip(view);
    return;
  }
  // Sub-line counts change with the mirror (todo blocks grow/shrink) — a
  // pinned view must follow the live edge.
  withReadingBottomPin(() => {
    renderStripStatus(view, hasActiveRun(view));
  });
}

function renderStripStatus(view: TaskViewState, activeRun: boolean): void {
  const container = elements.statusStripStatus;
  const native = view.workingStatus?.native ?? null;
  container.replaceChildren();
  container.classList.toggle("hidden", !native && !activeRun);
  if (native) {
    // The agent's voice: the provider's status region, verbatim. No CSS
    // spinner — relay updates are the animation, so motion is evidence.
    container.classList.remove("derived");
    for (const trouble of native.troubleLines) {
      const line = document.createElement("div");
      line.className = "strip-status-trouble";
      line.textContent = trouble;
      container.append(line);
    }
    const status = document.createElement("div");
    status.className = "strip-status-line";
    status.textContent = native.line;
    container.append(status);
    for (const sub of native.subLines) {
      const line = document.createElement("div");
      line.className = "strip-status-sub";
      line.textContent = sub;
      container.append(line);
    }
  } else if (activeRun) {
    // Duet's voice: visibly different styling, derived from durable signals
    // (plan step, running tool) with Duet's own clock.
    container.classList.add("derived");
    const line = document.createElement("div");
    line.className = "strip-status-line";
    const label = document.createElement("span");
    label.textContent = deriveCurrentStepForView(view) ?? "Working";
    const elapsed = document.createElement("span");
    elapsed.className = "strip-status-elapsed";
    const startedAt = view.report?.runs.at(-1)?.startedAt ?? null;
    if (startedAt) {
      elapsed.dataset.startedAt = startedAt;
    }
    elapsed.textContent = formatLiveElapsed(startedAt);
    line.append(label, document.createTextNode(" · "), elapsed);
    container.append(line);
  }
  applyStripLiveness(view);
}

// Duet's stall voice — the one thing the native UIs never say. Appears at
// "silent", self-heals without residue when evidence resumes.
function applyStripLiveness(view: TaskViewState): void {
  const strip = elements.statusStrip;
  const liveness = view.workingStatus?.liveness ?? "fresh";
  strip.classList.toggle("quiet", liveness === "quiet");
  strip.classList.toggle("silent", liveness === "silent");
  elements.statusStripStatus.querySelector(".strip-status-stall")?.remove();
  if (liveness !== "silent") {
    return;
  }
  const stall = document.createElement("button");
  stall.type = "button";
  stall.className = "strip-status-stall";
  const silentSince = view.workingStatus?.silentSince ?? null;
  const seconds = document.createElement("span");
  seconds.className = "strip-stall-elapsed";
  if (silentSince) {
    seconds.dataset.silentSince = silentSince;
  }
  seconds.textContent = formatLiveElapsed(silentSince);
  stall.append(
    document.createTextNode("No sign of activity for "),
    seconds,
    document.createTextNode(" — check the CLI"),
  );
  stall.addEventListener("click", () => {
    actions.setViewMode("terminal");
  });
  elements.statusStripStatus.append(stall);
  elements.statusStripStatus.classList.remove("hidden");
}

function renderStripAgents(items: AgentRunItem[]): void {
  const container = elements.statusStripAgents;
  container.classList.toggle("hidden", items.length === 0);
  const sig = items
    .map((item) => `${item.toolUseId}:${item.status}:${item.detail ?? ""}`)
    .join("|");
  if (container.dataset.sig === sig) {
    return; // membership unchanged — dots keep animating, ticker owns clocks
  }
  container.dataset.sig = sig;
  container.replaceChildren();
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "strip-agent";
    const dots = document.createElement("span");
    dots.className = "strip-agent-dots";
    for (let i = 0; i < 3; i += 1) {
      dots.append(document.createElement("i"));
    }
    const name = document.createElement("span");
    name.className = "strip-agent-name";
    name.textContent = item.name;
    row.append(dots, name);
    if (item.agentType && item.agentType !== "agent") {
      const type = document.createElement("span");
      type.className = "strip-agent-type";
      type.textContent = item.agentType;
      row.append(type);
    }
    const elapsed = document.createElement("span");
    elapsed.className = "strip-agent-elapsed";
    elapsed.dataset.startedAt = item.startedAt;
    elapsed.textContent = formatLiveElapsed(item.startedAt);
    row.append(elapsed);
    container.append(row);
  }
}
