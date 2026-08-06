// The transcript reading surface (map §3.1 renderer/view/transcript.ts, D2
// — R1 territory, moved VERBATIM from main.ts). This module owns the run
// list's streaming render path: the keyed reference-identity reconcile, the
// two persistent nodes (sticky-prompt rail FIRST child, status strip LAST
// child — both skipped by the reconcile and setNonRailChildren paths), the
// scroll contract (nearBottom <=64px and previousScrollTop captured BEFORE
// reconcile; finalize then asks reading-core for ONE of restore-a-switch /
// anchor-a-new-segment / leave-a-held-view / tail-follow —
// planReadingFinalizeScroll — and runs restorePromptNavAfterRender then
// scheduleStickyPromptSync, in that order), the turn-card e2e beacons
// (data-key/sig/turnKey/runId/runStatus, .turn-outcome-note, data-block-key),
// and the
// markdown render memo. Shell behavior (mode switch, prompt-nav, T4, the
// entry panel) arrives through the actions seam; state is read through the
// module-bound atom reference (initTranscriptView, bound by main.ts at boot
// before the first render — R4) via the activeTaskView(state) helper
// (D-early ruling 1: one view→state mechanism).

import DOMPurify from "dompurify";
import { marked } from "marked";
import { Check, CircleAlert, Copy, Image as ImageIcon } from "lucide";
import { planKeyedReconcile } from "../../shared/keyed-reconcile";
import type { TranscriptBlock } from "../../shared/types/transcript";
import type { RuntimeRunReport } from "../../shared/schemas";
import {
  assistantReplyContent,
  buildReadingTurns,
  createTurnSignatureTracker,
  imageAttachmentLabel,
  isCompactionTurn,
  isDegradedCompactionBlock,
  isDegradedCompactionTurn,
  userPromptDisplay,
  type ReadingTurn,
} from "../../reading-core/selectors/turns";
import {
  completionErrorExcerpt,
  isActiveRunStatus,
  runOutcome,
  runTone,
} from "../../reading-core/selectors/runs";
import {
  formatTranscriptTimestamp,
  providerLabel,
} from "../../reading-core/selectors/formatters";
import {
  activeTaskView,
  type RendererState,
  type TaskViewState,
} from "../../reading-core/state";
import {
  isReadingNearBottom,
  planReadingAnchorTarget,
  planReadingFinalizeScroll,
  type ReadingFinalizeScroll,
  type ReadingBottomIntentStore,
  type ReadingScrollMemoryStore,
} from "../../reading-core/reading-scroll";
import { elements } from "../dom";
import { actions } from "../actions";
import { lucideIcon } from "./icons";
import {
  readingScrollHoldTop,
  releaseReadingScrollHold,
  scrollReadingBlockToTop,
} from "./reading-scroll-control";

/** The shell's state atom, bound once at boot for the surface's read paths. */
let state: RendererState;
/** Cross-view composition dep (D-early ruling 2 refined at review 2026-07-04):
 *  the no-task empty state composes the New Chat entry panel, but view→view
 *  imports stay outside the fence — main.ts provides the composer at boot.
 *  An init-bound DEP, not an Action: composition is wiring, not behavior. */
let composeEntryPanel: () => HTMLElement;
/** The shared scroll-to-bottom intent (owned by the navigation surface). While
 *  it is live, finalize must leave scrollTop alone — see resolveReadingFinalizeScrollTop. */
let bottomIntent: ReadingBottomIntentStore;
/** The task this surface last rendered. A change means the transcript was
 *  replaced under any running ride, so the intent is stale — cleared here, in
 *  the synchronous render path AHEAD of finalize, so the new task's first
 *  tail-follow pin is not suppressed (the navigation surface's own sync runs
 *  after finalize and would clear a frame too late). */
let lastRenderedTaskId: string | null = null;
/** The per-session reading positions (owned by reading-core, written by the
 *  switch flow). This surface is the reader: a task-switch render consumes the
 *  incoming session's snapshot. */
let scrollMemory: ReadingScrollMemoryStore;

/** Reply-top anchoring bookkeeping (S3 D4) for the DISPLAYED session only: the
 *  answer segments present at the last render. Re-seeded from scratch whenever
 *  the rendered task changes, which is exactly the rule that entering a session
 *  must never anchor inside it — a session's blocks that landed while it was in
 *  the background are "seen" the moment it is displayed again, and only what
 *  arrives in front of the reader can move their view.
 *
 *  There is deliberately NO carried-forward anchor intent beside it: a segment
 *  is whole when it arrives (see the corpus measurement in reading-core), so an
 *  anchor is this render's business or nobody's. An intent that outlived its
 *  render could only ever be completed by somebody else's content — the next
 *  turn's prompt bubble arriving below it — and would pull the reader backwards
 *  into a reply they had already left (review 1, blocking 1). The position a
 *  landed anchor establishes lives in reading-scroll-control's hold, next to
 *  the writes that invalidate it. */
let seenAnswerSegments: ReadonlySet<string> = new Set();

export function initTranscriptView(
  stateRef: RendererState,
  deps: {
    composeEntryPanel: () => HTMLElement;
    bottomIntent: ReadingBottomIntentStore;
    scrollMemory: ReadingScrollMemoryStore;
  },
): void {
  state = stateRef;
  composeEntryPanel = deps.composeEntryPanel;
  bottomIntent = deps.bottomIntent;
  scrollMemory = deps.scrollMemory;
}

// The turn-signature tracker is process-local (block render versions live in
// a WeakMap keyed by block reference) — the renderer holds this singleton;
// fixtures create fresh instances (map §2.4).
const turnSignatureTracker = createTurnSignatureTracker();

// T19 — copy feedback, success AND failure. The deadline lives outside the
// button DOM: a streaming block can replace its whole turn card every ~160 ms,
// but the promised three-second Check (or failure notice) must survive that
// replacement. Ephemeral shell truth only — never reducer state, never
// persistence.
const COPY_FEEDBACK_MS = 3_000;
type CopyFeedbackState = "copied" | "error";
const copyFeedbackByTarget = new Map<string, { state: CopyFeedbackState; until: number }>();
const copyResetTimerByTarget = new Map<string, number>();

function refreshTurnCardCheap(card: HTMLElement, view: TaskViewState, turn: ReadingTurn): void {
  if (turn.runId) {
    card.classList.toggle("highlighted", turn.runId === view.highlightedRunId);
  }
}

// R3: the sticky-prompt rail is a persistent node — created once, kept as the
// runList's first child — so a streaming batch never tears it down.
function ensureStickyPromptRail(runList: HTMLElement): HTMLElement {
  let rail = runList.querySelector<HTMLElement>(".sticky-prompt-rail");
  if (!rail) {
    rail = renderStickyPromptRail();
    runList.prepend(rail);
  } else if (runList.firstChild !== rail) {
    runList.prepend(rail);
  }
  return rail;
}

// The no-task (entry panel) path is not the streaming path and needs no reconcile:
// drop everything after the persistent rail and set the given nodes. The
// status strip is the run list's second persistent node (its live LAST child)
// — never removed, content always inserted before it.
function setNonRailChildren(runList: HTMLElement, rail: HTMLElement, nodes: HTMLElement[]): void {
  const strip = elements.statusStrip;
  let cursor = rail.nextSibling;
  while (cursor) {
    const next = cursor.nextSibling;
    if (cursor !== strip) {
      runList.removeChild(cursor);
    }
    cursor = next;
  }
  for (const node of nodes) {
    runList.insertBefore(node, strip);
  }
}

interface ReconcileChild {
  key: string;
  sig: string;
  render: () => HTMLElement;
  refresh?: (node: HTMLElement) => void;
}

// Keyed DOM reconcile of the runList's turn cards against the desired turns.
// Reused nodes already in order are never detached → their text selection
// survives across streaming batches. Non-reused nodes (stale, changed, or
// non-keyed leftovers like the entry panel) are removed up front so the
// positioning cursor only ever references nodes that stay.
function reconcileKeyedChildren(
  parent: HTMLElement,
  rail: HTMLElement,
  items: ReconcileChild[],
): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(parent.children) as HTMLElement[]) {
    if (child === rail || child === elements.statusStrip) {
      continue;
    }
    const key = child.dataset.key;
    if (key !== undefined) {
      existing.set(key, child);
    }
  }
  const plan = planKeyedReconcile(
    Array.from(existing, ([key, node]) => ({ key, sig: node.dataset.sig ?? "" })),
    items.map((item) => ({ key: item.key, sig: item.sig })),
  );
  const reuseKeys = new Set(
    plan.ordered.filter((step) => step.action === "reuse").map((step) => step.key),
  );
  for (const child of Array.from(parent.children) as HTMLElement[]) {
    if (child === rail || child === elements.statusStrip) {
      continue;
    }
    const key = child.dataset.key;
    if (key === undefined || !reuseKeys.has(key)) {
      child.remove();
    }
  }
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  let cursor: ChildNode | null = rail.nextSibling;
  for (const step of plan.ordered) {
    const item = itemByKey.get(step.key);
    if (!item) {
      continue;
    }
    let node: HTMLElement;
    if (step.action === "reuse") {
      node = existing.get(step.key)!;
      item.refresh?.(node);
    } else {
      node = item.render();
      node.dataset.key = item.key;
      node.dataset.sig = item.sig;
    }
    if (node === cursor) {
      cursor = node.nextSibling;
    } else {
      parent.insertBefore(node, cursor);
    }
  }
}

export function renderRuns(): void {
  const runList = elements.runList;
  const nearBottom = isReadingNearBottom(runList);
  const previousScrollTop = runList.scrollTop;
  const rail = ensureStickyPromptRail(runList);

  const view = activeTaskView(state);
  const taskId = view?.task?.id ?? null;
  const taskSwitch = taskId !== lastRenderedTaskId;
  if (taskSwitch) {
    lastRenderedTaskId = taskId;
    bottomIntent.clear();
  }
  if (!view?.task) {
    setNonRailChildren(runList, rail, [composeEntryPanel()]);
    const anchorKey = syncReadingAnchorState(taskSwitch, []);
    finalizeReadingSurfaceRender({ nearBottom, previousScrollTop, taskSwitch, taskId, anchorKey });
    return;
  }

  const turns = buildReadingTurns(view);
  // Zero turns on an active task is normally just the sub-second gap before the
  // first run lands (deferred creation) — but a failed first delivery or a
  // persisted empty session can leave it durably empty too. Either way the keyed
  // reconcile below clears to just the rail + strip on an empty list, so 0 turns
  // renders as nothing. No placeholder: an "empty" banner only ever flashed, and
  // blank is the honest render for a genuinely empty task (removed 2026-07-05).
  reconcileKeyedChildren(
    runList,
    rail,
    turns.map((turn) => ({
      key: turn.key,
      sig: turnSignatureTracker.turnSignature(turn),
      // A compaction-boundary turn is not a conversation card — it renders as a
      // calm state-register separator between the turns it sits between (never a
      // husk card, never folded into a reply).
      render: () =>
        isCompactionTurn(turn)
          ? renderCompactionMarker({ degraded: isDegradedCompactionTurn(turn) })
          : renderTurn(view, turn),
      refresh: (node) => refreshTurnCardCheap(node, view, turn),
    })),
  );

  const anchorKey = syncReadingAnchorState(taskSwitch, answerSegmentKeys(turns));
  finalizeReadingSurfaceRender({ nearBottom, previousScrollTop, taskSwitch, taskId, anchorKey });
}

/** The answer blocks a turn renders into its body — ONE definition, used both
 *  by the card builder and by the segment-key collector below, so the DOM's key
 *  set and the anchor's candidate list can never be two independently
 *  maintained predicates that merely happen to agree (review 1, minor 3). A
 *  compaction-boundary turn draws a separator instead of a card, so it
 *  contributes no addressable segments at all. */
function answerBlocksForTurn(turn: ReadingTurn): TranscriptBlock[] {
  return isCompactionTurn(turn) ? [] : turn.blocks.filter(isAnswerBlock);
}

/** The reply segments a new arrival can anchor, in document order. Only
 *  assistant text: the other two answer-block kinds are Sonata's own state
 *  register (a system note, a degraded-compaction marker), and a reading
 *  surface anchors the reader to what the assistant SAID, not to a notice
 *  about the session. Both still carry a block key — the DOM stays addressable
 *  either way; they are simply never the target. Every key here therefore names
 *  a node that renderTurn did put in the DOM (isAnswerBlock admits assistant
 *  text unconditionally), so an anchor can only miss its node in the window
 *  where the transcript changed under it — which applyReadingFinalizeScroll
 *  handles by retiring the anchor. */
function answerSegmentKeys(turns: ReadingTurn[]): string[] {
  const keys: string[] = [];
  for (const turn of turns) {
    for (const block of answerBlocksForTurn(turn)) {
      if (block.kind === "assistant-text") {
        keys.push(block.id);
      }
    }
  }
  return keys;
}

/** Fold this render's segments into the seen set and report the ONE segment (if
 *  any) that appeared in it. The answer is good for this render only. */
function syncReadingAnchorState(taskSwitch: boolean, segmentKeys: string[]): string | null {
  if (taskSwitch) {
    seenAnswerSegments = new Set(segmentKeys);
    return null;
  }
  const plan = planReadingAnchorTarget(segmentKeys, seenAnswerSegments);
  seenAnswerSegments = plan.seen;
  return plan.anchorKey;
}

function finalizeReadingSurfaceRender(input: {
  nearBottom: boolean;
  previousScrollTop: number;
  taskSwitch: boolean;
  taskId: string | null;
  anchorKey: string | null;
}): void {
  const runList = elements.runList;
  // One decision point — the precedence, and the reason for each claimant, is
  // stated once in reading-core: planReadingFinalizeScroll. The reader's own
  // position (attending / held) is judged there too, from the metrics captured
  // BEFORE this render touched anything.
  applyReadingFinalizeScroll(
    planReadingFinalizeScroll({
      taskSwitch: input.taskSwitch,
      // Consumed only on the render that switches in, so a session's remembered
      // place answers exactly the return it was taken for.
      switchSnapshot: input.taskSwitch ? scrollMemory.take(input.taskId) : null,
      anchorKey: input.anchorKey,
      holdTop: readingScrollHoldTop(),
      hasBottomIntent: bottomIntent.current() !== null,
      nearBottom: input.nearBottom,
      previousScrollTop: input.previousScrollTop,
      scrollTop: runList.scrollTop,
      scrollHeight: runList.scrollHeight,
      clientHeight: runList.clientHeight,
    }),
  );
  actions.restorePromptNavAfterRender();
  actions.scheduleStickyPromptSync();
}

function applyReadingFinalizeScroll(action: ReadingFinalizeScroll): void {
  if (action.kind === "none") {
    return;
  }
  if (action.kind === "top") {
    elements.runList.scrollTop = action.top;
    // A switch restore or a tail-follow pin is not a reading position: the view
    // is no longer where a landed anchor put it, so nothing is held any more.
    releaseReadingScrollHold();
    return;
  }
  // Re-resolve by selector, never from a held node: the streaming reconcile
  // destroys and rebuilds a live turn's card every ~160 ms. A segment that
  // vanished between the plan and the write simply does not anchor — there is
  // no intent to retire, because the anchor was only ever for this render.
  const target = answerSegmentNode(action.blockKey);
  if (target) {
    scrollReadingBlockToTop(target);
  }
}

function answerSegmentNode(blockKey: string): HTMLElement | null {
  const segments = elements.runList.querySelectorAll<HTMLElement>(
    ".turn-answer > [data-block-key]",
  );
  return Array.from(segments).find((node) => node.dataset.blockKey === blockKey) ?? null;
}

function renderStickyPromptRail(): HTMLElement {
  const rail = document.createElement("div");
  rail.className = "sticky-prompt-rail";

  const header = document.createElement("button");
  header.id = "sticky-prompt-header";
  header.className = "sticky-prompt-header hidden";
  header.type = "button";
  header.setAttribute("aria-label", "Scroll to the prompt for this reply");
  header.addEventListener("click", () => {
    const turnKey = header.dataset.turnKey;
    if (!turnKey) {
      return;
    }
    actions.scrollToPromptTurn(turnKey);
  });

  rail.append(header);
  return rail;
}

function renderTurn(view: TaskViewState, turn: ReadingTurn): HTMLElement {
  const card = document.createElement("article");
  card.className = "turn-card";
  card.dataset.turnKey = turn.key;
  if (turn.runId) {
    card.dataset.runId = turn.runId;
    card.classList.toggle("highlighted", turn.runId === view.highlightedRunId);
  }

  // A continuation turn (background-workflow reply): transcript blocks with
  // no user-message — the "user" was the CLI's own task-notification, not a
  // person. No user bubble; the muted system-note in the body names what
  // came back.
  const hasUserVoice =
    turn.blocks.length === 0 || turn.blocks.some((block) => block.kind === "user-message");
  if (hasUserVoice) {
    card.append(renderTurnUser(turn));
  }

  const answerBlocks = answerBlocksForTurn(turn);
  const noAssistantOutput = turnCompletedWithoutAssistantOutput(turn);
  const liveRun = Boolean(turn.run && isActiveRunStatus(turn.run.status));
  // Machine-readable run state on the card itself: the e2e suite's completion
  // beacon (was `.turn-outcome` in the retired footer) and a debugging hook.
  if (turn.run) {
    card.dataset.runStatus = turn.run.status;
    if (turn.run.completionSource) {
      card.dataset.completionSource = turn.run.completionSource;
    }
  }

  const body = document.createElement("div");
  body.className = "turn-body turn-answer";
  for (const block of answerBlocks) {
    const node = renderTranscriptBlock(block);
    // Segment identity on the DOM (S3 D4). The block id is already
    // source-scoped (`<sourceId>:text-<seq>` / `<sourceId>:<uuid>:<suffix>`) and
    // deterministic, so re-reading a transcript from disk mints the same key for
    // the same content — a re-hydrate is not a stream of new segments.
    node.dataset.blockKey = block.id;
    body.append(node);
  }
  // A reply-less completed turn speaks ONLY when it has something actionable
  // to say (an API error excerpt). The plain "returned to the prompt without
  // a reply" self-narration retired 2026-07-03: it was Sonata reporting an
  // observation gap (idle-heuristic completion, zero blocks), not user
  // information — the co-visible Terminal already shows what happened, and a
  // slash command producing no reply is simply normal.
  const noAssistantErrorExcerpt = completionErrorExcerpt(turn.run);
  if (body.childElementCount === 0 && noAssistantOutput && noAssistantErrorExcerpt) {
    body.append(renderNoAssistantOutput(turn.run));
  }
  // A settled turn with terminal output but no structured transcript: state
  // the degradation instead of impersonating the reply with a scrape dump
  // (retired 2026-07-03 — Reading = reply + state; the real text is in the
  // co-visible Terminal). While the run is still live this stays silent: the
  // status strip owns "working", and blocks usually land moments later.
  if (body.childElementCount === 0 && turn.blocks.length === 0 && turn.fallbackText && !liveRun) {
    body.append(renderTurnFallback());
  }
  if (body.childElementCount > 0) {
    card.append(body);
  }

  // This is ONE whole-reply control, intentionally outside `.turn-answer`:
  // timestamps and controls must not enter answer text selection, quote-copy,
  // or the load-bearing transcript-selection fence. A live response is not a
  // whole response yet; show this row only once the attributed run settles.
  const replyContent = assistantReplyContent(turn.blocks);
  if (replyContent && !liveRun) {
    card.append(renderAssistantMeta(turn.key, replyContent.markdown, replyContent.completedAt));
  }

  // Reading shows the reply and the state, not the process (2026-07-03): the
  // work trace, turn footer, and artifact strip retired — the co-visible
  // Terminal carries process detail live, and forensics live in the provider
  // transcript. What survives per turn: an attention note when a settled run
  // did NOT complete (stopped / failed / denied / pty-exited) — failure IS
  // state, and without it a stopped run would be indistinguishable from a
  // completed one. Live and waiting states belong to the status strip.
  if (turn.run && !liveRun && turn.run.status !== "completed") {
    card.append(renderRunOutcomeNote(turn.run));
  }
  return card;
}

// The degraded variant's copy (SL-7 / codex #36642). Every clause is something
// Sonata MEASURED or knows structurally, and nothing more:
//   · "summary missing" — the record's replacement history carried no summary
//     item. That is the observation, stated as an observation.
//   · "may have lost" — the summary is encrypted, so Sonata can see that none
//     was written, never what the model actually still remembers. A signature is
//     not an outcome; the copy must not promote it to one.
//   · "the transcript above is unaffected" — true and load-bearing: only the
//     model's working memory is in question, the rollout Reading renders from is
//     whole. Same rule as the calm variant — never say the conversation was
//     cleared/reset/lost.
const COMPACTION_DEGRADED_LABEL = "Context compacted — summary missing";
const COMPACTION_DEGRADED_NOTE =
  "No summary was written, so the replies below may have lost the earlier context. The transcript above is unaffected.";

// The context-compaction boundary (S7), design A: a full-width hairline with a
// small centered muted label interrupting the line. A calm state-register — it
// draws LESS eye than a reply. The copy states only what happened to the model's
// working memory; it NEVER says cleared/reset/lost (the full transcript stays
// above the line). `role="separator"` + `aria-label` name it for assistive tech;
// the two hairline halves are decorative geometry (aria-hidden). Static in v1
// (summary disclosure is v2, likely Claude-only). All line/spacing treatment is
// one CSS block (`.compaction-marker*`) so a variant tweak stays CSS-only.
//
// `degraded` (SL-7) draws the SAME separator with the label escalated: the
// geometry, placement, and hairlines are untouched, and chroma lands only on the
// words that carry the signal — the design system's rule that attention red is
// the one kept status chroma, and that its force comes from how rarely it
// appears (`.approval.dangerous` escalates the same way). This is the only
// surface the warning gets: a compaction boundary is where the user's eye
// already is when history vanishes, and a second channel would say the same
// thing further from the evidence.
//
// `inCard` is the SAME marker rendered inside a turn card, for the mid-turn
// auto-compaction that has no boundary turn of its own (the majority shape —
// see isDegradedCompactionBlock). Only the vertical rhythm changes: 36px of
// breath is right between two cards, too much inside one.
function renderCompactionMarker(options: {
  degraded: boolean;
  inCard?: boolean;
}): HTMLElement {
  const { degraded, inCard = false } = options;
  const marker = document.createElement("div");
  marker.className = ["compaction-marker", degraded ? "degraded" : "", inCard ? "in-card" : ""]
    .filter(Boolean)
    .join(" ");
  marker.setAttribute("role", "separator");
  marker.setAttribute(
    "aria-label",
    degraded ? `${COMPACTION_DEGRADED_LABEL}. ${COMPACTION_DEGRADED_NOTE}` : "Context compacted",
  );

  const lineBefore = document.createElement("span");
  lineBefore.className = "compaction-marker-line";
  lineBefore.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "compaction-marker-label";
  label.textContent = degraded ? COMPACTION_DEGRADED_LABEL : "Context compacted";

  const lineAfter = document.createElement("span");
  lineAfter.className = "compaction-marker-line";
  lineAfter.setAttribute("aria-hidden", "true");

  marker.append(lineBefore, label, lineAfter);
  // The note is a SIBLING of the rule, not part of the label: the hairline row
  // must stay the one-line separator it is in the calm variant (a two-line label
  // between two hairlines reads as text crowding a rule). CSS wraps it onto its
  // own centered line below.
  if (degraded) {
    const note = document.createElement("span");
    note.className = "compaction-marker-note";
    note.textContent = COMPACTION_DEGRADED_NOTE;
    marker.append(note);
  }
  return marker;
}

function renderRunOutcomeNote(run: RuntimeRunReport): HTMLElement {
  const note = document.createElement("div");
  note.className = `turn-outcome-note ${runTone(run)}`;
  note.textContent = runOutcome(run, activeProviderLabel());
  return note;
}

// The attachment affordance for the reading bubble. Decorative (icon + count)
// when the turn also has text or a command; the SOLE prompt affordance when the
// prompt was images only — then it carries `.turn-prompt` + a real label so
// prompt-nav can target it and the sticky header shows words, not a bare count
// (review 2026-07-05 P2). Same lucide icon the composer's attachment chip uses.
function imageChip(turnKey: string, count: number, asPrompt = false): HTMLElement {
  const chip = document.createElement("span");
  chip.className = asPrompt ? "turn-image-chip turn-prompt" : "turn-image-chip";
  chip.dataset.turnKey = turnKey;
  chip.append(lucideIcon(ImageIcon, 14));
  const label = imageAttachmentLabel(count);
  if (asPrompt) {
    chip.tabIndex = -1;
    const text = document.createElement("span");
    text.className = "turn-image-chip-label";
    text.textContent = label;
    chip.append(text);
    chip.setAttribute("aria-label", `Prompt: ${label}`);
  } else {
    if (count > 1) {
      const badge = document.createElement("span");
      badge.className = "turn-image-chip-count";
      badge.textContent = String(count);
      chip.append(badge);
    }
    chip.setAttribute("aria-label", label);
  }
  return chip;
}

function renderTurnUser(turn: ReadingTurn): HTMLElement {
  const header = document.createElement("header");
  header.className = "turn-user";
  header.dataset.turnKey = turn.key;

  const userBlock = turn.blocks.find(
    (block): block is Extract<TranscriptBlock, { kind: "user-message" }> =>
      block.kind === "user-message",
  );
  // Bubble text + attachment count derive in the pure selector (reading-core);
  // the view only builds DOM from them. Marker stripping there is display-only
  // and attachment-gated — matching reads through markers separately.
  const { text: displayText, imageCount } = userPromptDisplay(userBlock, turn.run?.prompt ?? "");
  // "Images, no words": the chip must BE the prompt affordance (nav target +
  // sticky label), not a decoration beside a text bubble that isn't there.
  const imageOnly = imageCount > 0 && !displayText && !userBlock?.command;
  if (imageCount > 0) {
    header.append(imageChip(turn.key, imageCount, imageOnly));
  }

  if (userBlock?.command) {
    // A slash command. Claude logs the whole invocation as `<name> <args>`, and
    // for a skill like `/architect <brief>` the args ARE the user's prompt. Show
    // the command name as a small provenance chip, but render that body as the
    // normal growing bubble — full text, the user's own words, never crammed
    // into a fixed-size mono pill. Bare commands (no body) stay as just the chip.
    // The split runs on displayText (markers already stripped) so an image
    // attached to a slash command no longer hides the body behind the prefix.
    const name = userBlock.command;
    const body = displayText.startsWith(name) ? displayText.slice(name.length).trim() : "";
    const chip = document.createElement("span");
    chip.className = body ? "turn-command-chip" : "turn-command-chip turn-prompt";
    chip.tabIndex = -1;
    chip.dataset.turnKey = turn.key;
    chip.textContent = name;
    chip.setAttribute("aria-label", body ? `Command: ${name}` : `Prompt: ${name}`);
    header.append(chip);
    if (body) {
      const prompt = document.createElement("div");
      prompt.className = "turn-user-text turn-prompt";
      prompt.tabIndex = -1;
      prompt.dataset.turnKey = turn.key;
      prompt.textContent = body;
      prompt.setAttribute("aria-label", `Prompt: ${body}`);
      header.append(prompt);
    }
  } else if (!imageOnly) {
    // The text bubble. `(empty prompt)` shows only when there was neither text
    // nor image; an image-only turn is served by the chip affordance above.
    const prompt = document.createElement("div");
    prompt.className = "turn-user-text turn-prompt";
    prompt.tabIndex = -1;
    prompt.dataset.turnKey = turn.key;
    prompt.textContent = displayText || "(empty prompt)";
    prompt.setAttribute("aria-label", `Prompt: ${prompt.textContent}`);
    header.append(prompt);
  }

  const promptTimestamp = userBlock?.ts ?? turn.run?.startedAt ?? null;
  const meta = renderUserPromptMeta(turn.key, displayText, promptTimestamp);
  if (meta) {
    header.append(meta);
  }
  return header;
}

function renderUserPromptMeta(
  turnKey: string,
  copyText: string,
  timestampIso: string | null,
): HTMLElement | null {
  const timestamp = timestampIso ? formatTranscriptTimestamp(timestampIso) : null;
  if (!timestamp && !copyText) {
    return null;
  }
  const meta = document.createElement("div");
  meta.className = "transcript-message-meta turn-user-meta";
  if (timestamp) {
    meta.append(renderMessageTime(timestamp.display, timestamp.dateTime, "Prompt sent"));
  }
  // Image-only and genuinely empty prompts disclose time but no misleading
  // text-copy action. A slash invocation stays whole in displayText, including
  // its command name, even though its visual bubble splits chip from body.
  if (copyText) {
    meta.append(
      transcriptCopyButton({
        targetKey: `${turnKey}:prompt`,
        text: copyText,
        label: "Copy prompt",
      }),
    );
  }
  return meta;
}

function renderAssistantMeta(
  turnKey: string,
  markdown: string,
  completedAt: string,
): HTMLElement {
  const meta = document.createElement("div");
  meta.className = "transcript-message-meta turn-assistant-meta";
  meta.append(
    transcriptCopyButton({
      targetKey: `${turnKey}:reply`,
      text: markdown,
      label: "Copy response",
    }),
  );
  const timestamp = formatTranscriptTimestamp(completedAt);
  if (timestamp) {
    meta.append(renderMessageTime(timestamp.display, timestamp.dateTime, "Response completed"));
  }
  return meta;
}

function renderMessageTime(display: string, dateTime: string, label: string): HTMLTimeElement {
  const time = document.createElement("time");
  time.className = "transcript-message-time";
  time.dateTime = dateTime;
  time.textContent = display;
  time.setAttribute("aria-label", `${label} ${display}`);
  return time;
}

// Reading renders the reply and the state, never the process. A DEGRADED
// compaction marker is state of exactly the kind `system-note` already carries —
// and it must reach the card, because the compaction that produces it usually
// happens mid-turn, where there is no boundary turn to draw a separator between
// (isDegradedCompactionBlock). A calm compaction marker is deliberately NOT an
// answer block: in a mixed turn it still degrades to nothing, per S7.
function isAnswerBlock(
  block: TranscriptBlock,
): block is Extract<TranscriptBlock, { kind: "assistant-text" | "system-note" | "compaction" }> {
  return (
    block.kind === "assistant-text" || block.kind === "system-note" || isDegradedCompactionBlock(block)
  );
}

function turnCompletedWithoutAssistantOutput(turn: ReadingTurn): boolean {
  return Boolean(
    turn.run?.status === "completed" &&
      turn.run.completionSource === "terminal-idle-heuristic" &&
      !turn.blocks.some((block) => block.kind !== "user-message"),
  );
}

// Only answer blocks reach the card now — the process blocks (thinking,
// tool calls, plan, agents) stay in the data layer for the status strip and
// the provider transcript; Reading no longer renders them (2026-07-03).
function renderTranscriptBlock(block: TranscriptBlock): HTMLElement {
  if (block.kind === "assistant-text") {
    return markdownBody(block.markdown, block.id);
  }
  // The only compaction block that reaches here is a degraded one (isAnswerBlock),
  // and it draws the same warning separator as the standalone placement — one
  // form for one event, wherever the rollout put it.
  if (isDegradedCompactionBlock(block)) {
    return renderCompactionMarker({ degraded: true, inCard: true });
  }
  const note = document.createElement("div");
  note.className = "turn-system-note";
  note.textContent = block.kind === "system-note" ? block.text : "";
  return note;
}

// The scrape buffer (runTranscripts) remains the EVIDENCE that a reply
// happened — it just no longer renders. Same family as renderNoAssistantOutput.
function renderTurnFallback(): HTMLElement {
  const note = document.createElement("div");
  note.className = "turn-system-note degraded";
  const copy = document.createElement("div");
  copy.textContent = `${activeProviderLabel()} replied, but the reply could not be read structurally — the full text is in the CLI.`;
  const action = document.createElement("button");
  action.className = "secondary turn-terminal-action";
  action.type = "button";
  action.textContent = "Open CLI";
  action.addEventListener("click", () => {
    actions.setViewMode("terminal");
  });
  note.append(copy, action);
  return note;
}

// Only the error-carrying variant survives (the caller gates on a present
// excerpt): a reply-less turn WITH an API error is actionable; without one,
// the card stays quiet — see the renderTurn comment.
function renderNoAssistantOutput(run: RuntimeRunReport | null): HTMLElement {
  const errorExcerpt = completionErrorExcerpt(run);
  const note = document.createElement("div");
  note.className = "turn-system-note attention";

  const copy = document.createElement("div");
  copy.textContent = `${providerLabelForRun(run)} returned to the prompt without a reply. A provider/API error likely occurred.`;
  const excerpt = document.createElement("pre");
  excerpt.className = "turn-error-excerpt";
  excerpt.textContent = errorExcerpt;
  const action = document.createElement("button");
  action.className = "secondary turn-terminal-action";
  action.type = "button";
  action.textContent = "Open CLI";
  action.addEventListener("click", () => {
    actions.setViewMode("terminal");
  });
  note.append(copy, excerpt, action);
  return note;
}

const markdownSanitizerConfig = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "input", "button"],
  // DOMPurify allows data-* by default. The S4 file-chip enhancement adds
  // data-chip-* AFTER sanitize; forbidding them here means raw assistant HTML
  // can never forge a node that looks like a resolver-validated chip (the click
  // trust boundary also lives in chipRegistry — view/transcript-chips.ts).
  FORBID_ATTR: ["data-chip-path", "data-chip-task", "data-chip-state", "data-chip-mention"],
};

// This memo is keyed by FULL markdown text, and streaming hammers it: the
// signature-keyed reconcile re-renders ONLY the changed turn, so a growing
// assistant block inserts one new entry (its full intermediate markdown) every
// ~160 ms T3 tick. Unbounded, a multi-minute stream accumulates thousands of
// superseded near-duplicate strings (tens of MB for one turn, hundreds across a
// session). The bound is a count-capped LRU (a Map's iteration order IS
// insertion order, so it doubles as the recency queue — a hit deletes+re-sets to
// move the key to the newest slot, an overflow evicts the oldest/first key) with
// TWO size gates on top of the count cap (audit F4):
//   (1) a total-size budget in UTF-16 code units (Σ key.length + value.length),
//       so worst case is bounded in BYTES, not just entry count. A count cap
//       alone let the ceiling scale with reply size — 48 × largest reply — and
//       streaming a giant reply converges to 48 copies of ~the tail-length reply
//       (F4: L=1 MB ⇒ ~240 MB). 4M units ≈ 8 MB (2 bytes/unit) is the honest
//       worst case now, independent of reply size.
//   (2) a per-entry char cap: a single reply above ~256 K chars is never cached
//       at all. Huge replies re-parse rarely once settled, and their streaming
//       intermediates are precisely what filled hundreds of MB in the audit;
//       caching one (256 K markdown + ~2.5× HTML ≈ 1.8 MB) would evict a dozen
//       smaller entries for a near-zero hit rate.
// Cap 48 = the working set a task switch re-renders at ~100% hit (it rebuilds
// every visible turn card), with headroom for a long transcript. Typical entries
// (~1–2 KB markdown ≈ 6 KB/entry) sit near ~300 KB, far under both gates. Hit/miss
// only changes WHEN marked.parse re-runs — never the HTML that lands in the DOM.
const MARKDOWN_HTML_CACHE_MAX = 48;
const MARKDOWN_HTML_CACHE_MAX_UNITS = 4_000_000;
const MARKDOWN_HTML_CACHE_MAX_ENTRY_CHARS = 256_000;
const markdownHtmlCache = new Map<string, string>();
let markdownHtmlCacheUnits = 0;

function markdownCacheEntryUnits(key: string, value: string): number {
  return key.length + value.length;
}

function markdownCacheDelete(key: string): void {
  const value = markdownHtmlCache.get(key);
  if (value === undefined) {
    return;
  }
  markdownHtmlCacheUnits -= markdownCacheEntryUnits(key, value);
  markdownHtmlCache.delete(key);
}

function markdownBody(markdown: string, blockId: string): HTMLElement {
  const body = document.createElement("div");
  body.className = "md-body";
  let html = markdownHtmlCache.get(markdown);
  if (html === undefined) {
    html = DOMPurify.sanitize(marked.parse(markdown, { async: false }), markdownSanitizerConfig);
    // Gate (2): parse but do not retain a reply above the per-entry cap.
    if (markdown.length <= MARKDOWN_HTML_CACHE_MAX_ENTRY_CHARS) {
      markdownHtmlCache.set(markdown, html);
      markdownHtmlCacheUnits += markdownCacheEntryUnits(markdown, html);
      // Evict oldest (first) until within BOTH the count cap and the byte budget.
      // The just-inserted entry is newest (last in iteration order), so it is
      // never the eviction target — gate (2) keeps any single entry well under
      // the total budget, so the loop always terminates with it retained.
      while (
        markdownHtmlCache.size > MARKDOWN_HTML_CACHE_MAX ||
        markdownHtmlCacheUnits > MARKDOWN_HTML_CACHE_MAX_UNITS
      ) {
        const oldest = markdownHtmlCache.keys().next().value;
        if (oldest === undefined || oldest === markdown) {
          break;
        }
        markdownCacheDelete(oldest);
      }
    }
  } else {
    // Hit: refresh recency — re-insert moves this key to the newest slot so it
    // outlives colder entries under the cap. Same key + value ⇒ the unit total
    // is unchanged, so only the ordering moves.
    markdownHtmlCache.delete(markdown);
    markdownHtmlCache.set(markdown, html);
  }
  body.innerHTML = html;
  enhanceCodeBlocks(body, blockId);
  return body;
}

function enhanceCodeBlocks(body: HTMLElement, blockId: string): void {
  const codeBlocks = Array.from(body.querySelectorAll<HTMLPreElement>("pre"));
  for (const [index, pre] of codeBlocks.entries()) {
    const wrapper = document.createElement("div");
    wrapper.className = "transcript-code-block";
    pre.before(wrapper);
    wrapper.append(pre);
    const codeText = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
    const copy = transcriptCopyButton({
      targetKey: `${blockId}:code:${index}`,
      text: codeText,
      label: "Copy code",
      className: "code-block-copy",
    });
    wrapper.append(copy);
  }
}

interface TranscriptCopyButtonOptions {
  targetKey: string;
  text: string;
  label: string;
  className?: string;
}

function transcriptCopyButton(options: TranscriptCopyButtonOptions): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = options.className
    ? `transcript-copy-button ${options.className}`
    : "transcript-copy-button";
  button.dataset.copyTarget = options.targetKey;
  button.dataset.copyLabel = options.label;
  syncCopyButton(button);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(options.text);
      setCopyFeedback(options.targetKey, "copied");
    } catch {
      setCopyFeedback(options.targetKey, "error");
    }
  });
  return button;
}

// Address the stable target, not the click-time node: the write Promise may
// settle after streaming reconcile has detached that button and mounted a new
// one. Success and failure get the same treatment — a failure notice wiped by
// the next reconcile would leave the click visually unanswered.
function setCopyFeedback(targetKey: string, state: CopyFeedbackState): void {
  copyFeedbackByTarget.set(targetKey, { state, until: Date.now() + COPY_FEEDBACK_MS });
  syncCopyTarget(targetKey);

  const previousTimer = copyResetTimerByTarget.get(targetKey);
  if (previousTimer !== undefined) {
    window.clearTimeout(previousTimer);
  }
  const timer = window.setTimeout(() => {
    copyResetTimerByTarget.delete(targetKey);
    const feedback = copyFeedbackByTarget.get(targetKey);
    if (feedback !== undefined && feedback.until <= Date.now()) {
      copyFeedbackByTarget.delete(targetKey);
      syncCopyTarget(targetKey);
    }
  }, COPY_FEEDBACK_MS);
  copyResetTimerByTarget.set(targetKey, timer);
}

function syncCopyTarget(targetKey: string): void {
  for (const button of copyButtonsForTarget(targetKey)) {
    syncCopyButton(button);
  }
}

function copyButtonsForTarget(targetKey: string): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(".transcript-copy-button"),
  ).filter((button) => button.dataset.copyTarget === targetKey);
}

function syncCopyButton(button: HTMLButtonElement): void {
  const targetKey = button.dataset.copyTarget ?? "";
  const label = button.dataset.copyLabel ?? "Copy";
  const feedback = copyFeedbackByTarget.get(targetKey);
  const state = feedback !== undefined && feedback.until > Date.now() ? feedback.state : "idle";
  const description =
    state === "copied" ? "Copied" : state === "error" ? "Copy failed. Try again" : label;
  button.dataset.copyState = state;
  button.setAttribute("aria-label", description);
  button.title = description;
  button.replaceChildren(
    lucideIcon(state === "copied" ? Check : state === "error" ? CircleAlert : Copy, 16),
  );
}

function providerLabelForRun(_run: RuntimeRunReport | null): string {
  return activeProviderLabel();
}

function activeProviderLabel(): string {
  const provider = activeTaskView(state)?.task?.provider;
  return provider ? providerLabel(provider) : "Codex";
}
