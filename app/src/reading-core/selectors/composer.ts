/**
 * Composer selectors for the Reading window: slash-picker scoring/filtering,
 * the composer placeholder + send-button title, the session model summary,
 * and the option-prompt (AskUserQuestion) receipt builders.
 *
 * reading-core layer rules: plain data in, plain data out — no DOM, no
 * Electron, no renderer state. Selectors that read the active view take it
 * as a parameter (the shell passes `activeTaskView()` / draft state).
 */
import type { ClaudePermissionMode, ReasoningEffort, SlashCommandEntry } from "../../shared/types";
import type { OptionPromptDetectedEvent } from "../../shared/types/events";
import type { OptionPromptAnswers, OptionPromptSelection } from "../../shared/types/option-prompt";
import type {
  OptionPromptDraft,
  OptionPromptReceiptLine,
  RendererState,
  TaskLaunchDraft,
  TaskViewState,
} from "../state";
import { providerLabel } from "./formatters";
import { modelValueLabel, reasoningValueLabel } from "../config";

/**
 * Ownership protection has two grains (D1, 2026-07-14). This selector picks the
 * NARROW grain: the lifecycle phases that actually MOVE the visible composer
 * draft (snapshot on entry, restore on exit) and therefore must disable the
 * textarea. The BROAD grain — operation mutual exclusion (no second lifecycle,
 * no attachment-list mutation, no selection change) — stays with
 * `isSessionLifecycleActive` and does NOT disable typing: a live `sending`,
 * `attaching`, or a background `session-mutation`/`project-mutation` leaves the
 * composer usable, and the double-submit is blocked by the claim guard at
 * `submitPrompt` entry rather than by a disabled textarea.
 *
 * Disabling a focused textarea blurs it with nothing to restore focus — the
 * confirmed live-send regression — so the set here is exactly the phases where
 * the draft is being parked/restored anyway: `starting`, `preparing-resume`,
 * and `resuming`. The resume CHOICE no longer holds a lifecycle phase (D3,
 * 2026-07-14): it lives on `view.resumeChoice` with the app fully interactive
 * and the composer typable, so there is no `awaiting-resume-choice` arm here.
 */
export function lifecycleFreezesComposerText(state: RendererState): boolean {
  switch (state.sessionLifecycle.phase) {
    case "starting":
    case "preparing-resume":
    case "resuming":
      return true;
    default:
      return false;
  }
}

/** Lower score sorts first; null means no match. */
export function slashFilterScore(entry: SlashCommandEntry, query: string): number | null {
  if (query.length === 0) {
    return 0;
  }
  const name = entry.name.toLowerCase();
  if (name === query) {
    return 0;
  }
  if (name.startsWith(query)) {
    return 1;
  }
  if (name.includes(query)) {
    return 2;
  }
  if (entry.description.toLowerCase().includes(query)) {
    return 3;
  }
  return null;
}

export function filteredSlashItems(picker: {
  entries: SlashCommandEntry[];
  query: string;
}): SlashCommandEntry[] {
  const scored: Array<{ entry: SlashCommandEntry; score: number; order: number }> = [];
  picker.entries.forEach((entry, order) => {
    if (!entry.listed) {
      return;
    }
    const score = slashFilterScore(entry, picker.query);
    if (score !== null) {
      scored.push({ entry, score, order });
    }
  });
  scored.sort((a, b) => {
    // Commands before skills, then match quality, then registry order.
    const kindDelta = Number(a.entry.kind === "skill") - Number(b.entry.kind === "skill");
    if (kindDelta !== 0) {
      return kindDelta;
    }
    return a.score - b.score || a.order - b.order;
  });
  return scored.map((item) => item.entry);
}

/** The New Chat model chip's label: model + effort (+ Fast), from the draft's
 *  launch settings. Fast is offered per provider — every Codex model, Claude
 *  only on Opus — but the label rule is uniform: append "Fast" whenever the
 *  active provider's draft speed is `fast`. The session twin is
 *  sessionModelSummaryLabel. */
export function draftModelSummaryLabel(draft: TaskLaunchDraft): string {
  const provider = draft.provider;
  const parts = [
    modelValueLabel(provider, draft.model[provider]) ?? "Default",
    reasoningValueLabel(provider, draft.reasoningEffort[provider]) ?? "Default",
  ];
  if (draft.speedMode[provider] === "fast") {
    parts.push("Fast");
  }
  return parts.join(" ");
}

export function sessionModelSummaryLabel(view: TaskViewState | null): string | null {
  const task = view?.task ?? null;
  if (!task) {
    return null;
  }
  // The live statusline value wins (contract §2: mid-session /model and
  // effort switching happens in the Terminal; Reading only DISPLAYS it —
  // same shape as the S4 permission_mode wiring). Spawn settings are the
  // fallback before the first statusline event, and for codex, whose
  // snapshots never carry a model.
  const live = view?.usageSnapshot ?? null;
  const model = live?.modelDisplayName ?? modelValueLabel(task.provider, task.model);
  const effortValue = (live?.reasoningEffort ?? task.reasoningEffort) as ReasoningEffort | null;
  const parts = [model, reasoningValueLabel(task.provider, effortValue)].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The permission modes the live-session access menu offers (S2; D4 revised by
 *  the 2026-07-18 field test). default / acceptEdits / plan / **auto** are always
 *  offered — a session spawned Manual never OBSERVES auto, so the old observed-only
 *  rule made Auto permanently unreachable (a dead END, worse than a dead step). An
 *  account whose Shift+Tab cycle lacks auto now fails GRACEFULLY when Auto is
 *  picked (the stepping engine seeks, exhausts, returns home, and raises
 *  needs-attention) — rare, honest, and the accepted trade. `bypassPermissions`
 *  stays gated to a session that was SPAWNED into it (observed, seeded from the
 *  spawn mode) — a Sonata launch never offers it, so it is non-dead by
 *  construction and must not appear as a dead step. Order follows the vocabulary. */
const PERMISSION_MENU_BASE: readonly ClaudePermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
];
const PERMISSION_MENU_GATED: readonly ClaudePermissionMode[] = ["bypassPermissions"];

export function sessionPermissionMenuModes(view: TaskViewState): ClaudePermissionMode[] {
  const observed = view.observedPermissionModes;
  const gated = PERMISSION_MENU_GATED.filter((mode) => observed.includes(mode));
  return [...PERMISSION_MENU_BASE, ...gated];
}

/**
 * The boot-narration yield (CLI readiness S4).
 *
 * Two strings below promise a boot: the send title's "sends as soon as it accepts
 * input" and the placeholder's "will send when it's ready". Both are true of a CLI
 * that is merely slow, and both become the eternal pin this program exists to
 * remove once the CLI is parked on a first-run screen nobody in Reading can see —
 * because `bootLatched` never opens and neither string ever changes.
 *
 * `sessionStartBlocked` is the S4 diagnosis for this task: the probe has confirmed
 * the CLI cannot start. When it is set these two functions must stop predicting a
 * boot. The send title yields by SUBTRACTION — skipping the optimistic arm drops
 * it onto the truthful "Queued — delivers when X is ready", which is exactly what
 * happens (the queue holds, and finishing the CLI's setup releases it). The
 * placeholder gets the one new sentence, because the arm it would otherwise fall
 * through to ("Continue, correct, or redirect this Task") reads oblivious directly
 * beneath a banner saying the CLI is not there.
 */
export function sendPromptTitle(
  view: TaskViewState | null,
  activeRun: boolean,
  pendingApproval: boolean,
  promptHasText: boolean,
  sessionStartBlocked = false,
): string {
  if (!view?.task) {
    return "";
  }
  const providerName = providerLabel(view.task.provider);
  if (activeRun) {
    return `Stop ${providerName}`;
  }
  if (!promptHasText) {
    return "Type a message before sending.";
  }
  if (pendingApproval) {
    return `Queued — delivers after ${providerName} approval is resolved.`;
  }
  if (view.live && !view.deliveryState?.bootLatched && !sessionStartBlocked) {
    return `${providerName} is starting — your message sends as soon as it accepts input.`;
  }
  if (view.deliveryState && !view.deliveryState.deliverable) {
    return `Queued — delivers when ${providerName} is ready.`;
  }
  return `Send to ${providerName}`;
}

/** The composer line's editorial policy (2026-07-04 ruling): it speaks ONLY
 *  when the user's own action needs a response — a failure report ("Attached
 *  3 of 4 — …", "Couldn't restore …", free-form errors) or an actionable
 *  point-of-action hint. The hint arm has no live user: its one caller, the
 *  slash submit guard, retired on 2026-07-27 when submit became verbatim and
 *  stopped having anything to caution about. The policy is unchanged — a
 *  future hint belongs here. Lifecycle narration ("Starting Claude", "Queued",
 *  "Selected proj", …) never renders: liveness already lives in the status
 *  strip, outcomes on the turn cards. Returns "" for suppressed messages. */
export function composerNotice(status: string): string {
  const narration: RegExp[] = [
    /^(Idle|Ready|Running|Queued|Stopping|Stopped|Failed)$/,
    /^\S+ (is working|is starting)$/,
    /^Starting /,
    /^Delivering to /,
    /^Waiting for /,
    // The spawn receipt ("Claude PTY 12345") is boot plumbing, not a message.
    /^\S+ PTY \d+$/,
    /^Opening session$/,
    /^Choosing Task Folder$/,
    /^Selected /,
    /^Resuming session$/,
    /^Resumed — /,
    /^Choose how to resume$/,
    /^Answer sent$/,
    // Drawer states narrate themselves in the drawer (S2) — the red action-
    // feedback line must not double them (and never in the attention voice).
    /^\S+ is asking$/,
    /^Waiting in the CLI$/,
    /^Questions dismissed$/,
    /^Answered$/,
    // Dead affordance: send is disabled while the composer is empty.
    /^Type a message before sending$/,
  ];
  if (narration.some((pattern) => pattern.test(status))) {
    return "";
  }
  return status;
}

export function composerPlaceholder(
  view: TaskViewState | null,
  activeRun: boolean,
  pendingApproval: boolean,
  sessionStartBlocked = false,
): string {
  // New chat: the first message births the session; the placeholder invites
  // intent (ruled 2026-07-04) instead of narrating the mechanism.
  if (!view?.task) {
    return "Describe a task or ask a question";
  }
  const providerName = providerLabel(view.task.provider);
  // (No pendingApproval branch: the composer is hidden behind the drawer
  // whenever an approval is pending — drawer S2; the string was dead.)
  if (pendingApproval) {
    return `${providerName} is working — Enter queues your message`;
  }
  if (activeRun) {
    return `${providerName} is working — Enter queues your message`;
  }
  // Ranked ABOVE the dormant arm on purpose: the two shapes of S4 failure land on
  // opposite sides of `live` (a missing binary leaves the pty dead and the session
  // dormant; a signed-out CLI leaves it alive and latch-less), and the diagnosis is
  // the truer thing to say in BOTH. The sentence states the fact and stops —
  // the banner directly above carries the reason and the button, so repeating
  // either here would be the second voice the house does not want. It does not
  // forbid typing: the composer stays live, because in both shapes the message is
  // either queued for a login about to finish or a retry the user may want.
  if (sessionStartBlocked) {
    return `${providerName} can't start yet`;
  }
  if (!view.live) {
    return `Message ${providerName} — resumes this session`;
  }
  if (!view.deliveryState?.bootLatched) {
    return `${providerName} is starting — your message will send when it's ready`;
  }
  if ((view.report?.runs.length ?? 0) === 0) {
    return `Message ${providerName}`;
  }
  return "Continue, correct, or redirect this Task";
}

/** Ordered question metadata, from the live prompt or a prior receipt. */
export function optionPromptQuestionMeta(
  view: TaskViewState,
): { header: string; question: string }[] {
  if (view.pendingOptionPrompt) {
    return view.pendingOptionPrompt.questions.map((q) => ({ header: q.header, question: q.question }));
  }
  if (view.optionPromptReceipt) {
    return view.optionPromptReceipt.lines.map((l) => ({ header: l.header, question: l.question }));
  }
  return [];
}

/** Build receipt lines from the provider's verbatim answers (keyed by question). */
export function reconcileReceiptLines(
  meta: { header: string; question: string }[],
  answers: OptionPromptAnswers,
): OptionPromptReceiptLine[] {
  if (meta.length > 0) {
    return meta.map((m) => ({ header: m.header, question: m.question, labels: answers[m.question] ?? [] }));
  }
  // No card context (e.g. answered natively before a card existed) — derive
  // the lines straight from the answers object.
  return Object.entries(answers).map(([question, labels]) => ({ header: question, question, labels }));
}

/** Map the card's per-question drafts to the wire selections (drawer S1).
 *  Returns null while any question is unanswered (send stays disabled). A
 *  non-empty text wins over stray indices — the UI clears indices when the
 *  free-text row is chosen, this is the belt to that suspender. */
export function optionPromptSelectionsFromDrafts(
  prompt: OptionPromptDetectedEvent["payload"],
  drafts: OptionPromptDraft[],
): OptionPromptSelection[] | null {
  if (drafts.length !== prompt.questions.length) {
    return null;
  }
  const selections: OptionPromptSelection[] = [];
  for (let i = 0; i < prompt.questions.length; i++) {
    const question = prompt.questions[i];
    const draft = drafts[i];
    if (!question || !draft) {
      return null;
    }
    const text = (draft.text ?? "").trim();
    if (text && !question.multiSelect) {
      // Free-text on a MULTI-select question is not injectable (probe P9f:
      // the digit path toggles instead of opening the editor) — fall through
      // to the picked options, or stay unanswered (send disabled).
      selections.push({ kind: "text", text });
    } else if (draft.optionIndices.length === 0) {
      return null;
    } else if (question.multiSelect) {
      selections.push({ kind: "options", indices: [...draft.optionIndices].sort((a, b) => a - b) });
    } else {
      const index = draft.optionIndices[0];
      if (index === undefined || draft.optionIndices.length !== 1) {
        return null;
      }
      selections.push({ kind: "option", index });
    }
  }
  return selections;
}
