/**
 * Composer selectors for the Reading window: slash-picker scoring/filtering,
 * the composer placeholder + send-button title, the session model summary,
 * and the option-prompt (AskUserQuestion) receipt builders.
 *
 * reading-core layer rules: plain data in, plain data out — no DOM, no
 * Electron, no renderer state. Selectors that read the active view take it
 * as a parameter (the shell passes `activeTaskView()` / draft state).
 */
import type {
  ReasoningEffort,
  RuntimeProvider,
  SlashCommandEntry,
} from "../../shared/types";
import type { OptionPromptDetectedEvent } from "../../shared/types/events";
import type { OptionPromptAnswers } from "../../shared/types/option-prompt";
import type { OptionPromptReceiptLine, TaskLaunchDraft, TaskViewState } from "../state";
import { providerLabel } from "./formatters";
import { modelValueLabel, reasoningValueLabel } from "../config";

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

/** The New Chat model chip's label: model + effort (+ Fast, Codex), from the
 *  draft's launch settings. The session twin is sessionModelSummaryLabel. */
export function draftModelSummaryLabel(draft: TaskLaunchDraft): string {
  const provider = draft.provider;
  const parts = [
    modelValueLabel(provider, draft.model[provider]) ?? "Default",
    reasoningValueLabel(provider, draft.reasoningEffort[provider]) ?? "Default",
  ];
  if (provider === "codex" && draft.speedMode.codex === "fast") {
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

/** The live model chip's tooltip: mid-session model/effort switching is a
 *  terminal action, and each CLI names it its own way. Claude's /model swaps
 *  the model; Codex's /model ("Select Model and Effort") covers both — the
 *  chip is display-only either way (contract §2), so the copy points at the
 *  native command instead of implying an in-composer switch. */
export function sessionModelSwitchHint(provider: RuntimeProvider): string {
  return provider === "codex"
    ? "Switch model and effort in the terminal — /model"
    : "Switch models in the terminal — /model";
}

/** The live permission chip's tooltip. Claude cycles modes with Shift+Tab or
 *  /permissions; Codex has no Shift+Tab cycle — only /permissions ("choose
 *  what Codex is allowed to do"). Naming Shift+Tab for a Codex session would
 *  point at an affordance that doesn't exist. */
export function sessionPermissionSwitchHint(provider: RuntimeProvider): string {
  return provider === "codex"
    ? "Switch permissions in the terminal — /permissions"
    : "Switch modes in the terminal — Shift+Tab or /permissions";
}

export function sendPromptTitle(
  view: TaskViewState | null,
  activeRun: boolean,
  pendingApproval: boolean,
  promptHasText: boolean,
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
  if (view.live && !view.deliveryState?.bootLatched) {
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
 *  guard hint (unknown slash: "press Enter again"). Lifecycle narration
 *  ("Starting Claude", "Queued", "Selected proj", …) never renders: liveness
 *  already lives in the status strip, outcomes on the turn cards. Returns ""
 *  for suppressed messages. */
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
): string {
  // New chat: the first message births the session; the placeholder invites
  // intent (ruled 2026-07-04) instead of narrating the mechanism.
  if (!view?.task) {
    return "Describe a task or ask a question";
  }
  const providerName = providerLabel(view.task.provider);
  if (pendingApproval) {
    return `${providerName} approval is waiting — Enter queues your message`;
  }
  if (activeRun) {
    return `${providerName} is working — Enter queues your message`;
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

/** Optimistic receipt lines from the local single-select choice (pre-reconcile). */
export function optimisticReceiptLines(
  prompt: OptionPromptDetectedEvent["payload"],
  selections: number[],
): OptionPromptReceiptLine[] {
  return prompt.questions.map((q, i) => {
    const idx = selections[i] ?? -1;
    const label = idx >= 0 ? q.options[idx]?.label ?? "" : "";
    return { header: q.header, question: q.question, labels: label ? [label] : [] };
  });
}
