// The Reading window's DOM shell (map §3.1 renderer/dom.ts, D1): the static
// template, the id lookup helper, and the `elements` registry every render
// path reads. No import-time side effects (R4) — main.ts calls initDom() at
// the template-injection point of the boot sequence, and `elements` is a live
// binding that view modules read at call time, never at import time.

function queryElements() {
  return {
    taskTitleSlot: getElement<HTMLDivElement>("task-title-slot"),
    taskTitle: getElement<HTMLHeadingElement>("task-title"),
    headerRenameNotice: getElement<HTMLDivElement>("header-rename-notice"),
    runtimeStatus: getElement<HTMLDivElement>("runtime-status"),
    readingSettings: getElement<HTMLButtonElement>("reading-settings"),
    readingPopoverRoot: getElement<HTMLDivElement>("reading-popover-root"),
    taskSettingsPopoverRoot: getElement<HTMLDivElement>("task-settings-popover-root"),
    remoteControlToggle: getElement<HTMLButtonElement>("remote-control-toggle"),
    remoteControlPopoverRoot: getElement<HTMLDivElement>("remote-control-popover-root"),
    openPreviewWindow: getElement<HTMLButtonElement>("open-preview-window"),
    toggleTerminalWindow: getElement<HTMLButtonElement>("toggle-terminal-window"),
    sidebar: getElement<HTMLElement>("sidebar"),
    sidebarResizer: getElement<HTMLDivElement>("sidebar-resizer"),
    sidebarNewChat: getElement<HTMLButtonElement>("sidebar-new-chat"),
    sidebarList: getElement<HTMLDivElement>("sidebar-list"),
    sidebarRenameNotice: getElement<HTMLDivElement>("sidebar-rename-notice"),
    sidebarToggle: getElement<HTMLButtonElement>("sidebar-toggle"),
    sidebarCollapse: getElement<HTMLButtonElement>("sidebar-collapse"),
    sidebarMenuRoot: getElement<HTMLDivElement>("sidebar-menu-root"),
    sidebarSettings: getElement<HTMLButtonElement>("sidebar-settings"),
    sidebarUpdateSlot: getElement<HTMLDivElement>("sidebar-update-slot"),
    sidebarHoverCardRoot: getElement<HTMLDivElement>("sidebar-hover-card-root"),
    quoteCommentRoot: getElement<HTMLDivElement>("quote-comment-root"),
    settingsOverlayRoot: getElement<HTMLDivElement>("settings-overlay-root"),
    quitConfirmRoot: getElement<HTMLDivElement>("quit-confirm-root"),
    sessionMenuTrigger: getElement<HTMLButtonElement>("session-menu-trigger"),
    approvalBanner: getElement<HTMLDivElement>("approval-banner"),
    approvalKindBadge: getElement<HTMLSpanElement>("approval-kind-badge"),
    approvalTitle: getElement<HTMLElement>("approval-title"),
    approvalSummary: getElement<HTMLParagraphElement>("approval-summary"),
    approvalContext: getElement<HTMLDivElement>("approval-context"),
    approvalActions: getElement<HTMLDivElement>("approval-actions"),
    approvalExpiredRow: getElement<HTMLDivElement>("approval-expired-row"),
    approvalOpenCli: getElement<HTMLButtonElement>("approval-open-cli"),
    denyApproval: getElement<HTMLButtonElement>("deny-approval"),
    approveSessionApproval: getElement<HTMLButtonElement>("approve-session-approval"),
    approveApproval: getElement<HTMLButtonElement>("approve-approval"),
    optionPromptCard: getElement<HTMLDivElement>("option-prompt-card"),
    controlConfirmCard: getElement<HTMLDivElement>("control-confirm-card"),
    attentionBannerRoot: getElement<HTMLDivElement>("attention-banner-root"),
    cliReadinessCardRoot: getElement<HTMLDivElement>("cli-readiness-card-root"),
    statusStrip: getElement<HTMLElement>("status-strip"),
    statusStripStatus: getElement<HTMLDivElement>("status-strip-status"),
    statusStripAgents: getElement<HTMLDivElement>("status-strip-agents"),
    runList: getElement<HTMLDivElement>("run-list"),
    resumeChoice: getElement<HTMLElement>("resume-choice"),
    resumeChoiceBody: getElement<HTMLParagraphElement>("resume-choice-body"),
    resumeBridgeNote: getElement<HTMLParagraphElement>("resume-bridge-note"),
    resumeBridgeRevert: getElement<HTMLButtonElement>("resume-bridge-revert"),
    resumeRemember: getElement<HTMLInputElement>("resume-remember"),
    resumeFull: getElement<HTMLButtonElement>("resume-full"),
    resumeSummary: getElement<HTMLButtonElement>("resume-summary"),
    composer: getElement<HTMLFormElement>("composer"),
    promptInput: getElement<HTMLTextAreaElement>("prompt-input"),
    scrollToBottom: getElement<HTMLButtonElement>("scroll-to-bottom"),
    attachmentStrip: getElement<HTMLDivElement>("attachment-strip"),
    addAttachment: getElement<HTMLButtonElement>("add-attachment"),
    permissionChip: getElement<HTMLButtonElement>("permission-chip"),
    providerChip: getElement<HTMLButtonElement>("provider-chip"),
    modelChip: getElement<HTMLButtonElement>("model-chip"),
    composerContextRow: getElement<HTMLDivElement>("composer-context-row"),
    projectChip: getElement<HTMLButtonElement>("project-chip"),
    usageIndicator: getElement<HTMLButtonElement>("usage-indicator"),
    composerPopoverRoot: getElement<HTMLDivElement>("composer-popover-root"),
    sendPrompt: getElement<HTMLButtonElement>("send-prompt"),
    runColumn: getElement<HTMLElement>("run-column"),
  };
}

export type Elements = ReturnType<typeof queryElements>;

/** The registry of persistent shell nodes. Live binding — populated by
 *  initDom() during boot, before any render path runs. */
export let elements: Elements;

/** Inject the shell template into #app and populate `elements`. Called once
 *  by main.ts at the template-injection point of the boot sequence (R4). */
export function initDom(): void {
  const appElement = document.querySelector<HTMLDivElement>("#app");

  if (!appElement) {
    throw new Error("Renderer mount point was not found.");
  }

  appElement.innerHTML = `
  <section class="shell" aria-label="Sonata">
    <aside id="sidebar" class="sidebar" aria-label="Sessions">
      <div class="sidebar-top">
        <div class="sidebar-rail">
          <button id="sidebar-collapse" class="chrome-icon-button" type="button" title="Collapse sidebar" aria-label="Collapse sidebar"></button>
        </div>
        <button id="sidebar-new-chat" class="sidebar-new-chat" type="button" title="New task">
          <span class="sidebar-new-chat-icon"></span><span>New task</span>
        </button>
      </div>
      <div id="sidebar-rename-notice" class="rename-surface-notice hidden" role="alert"></div>
      <nav id="sidebar-sections" class="sidebar-sections" aria-label="Session list">
        <div id="sidebar-list"></div>
      </nav>
      <!-- Sidebar footer: the always-present bottom row. Settings on the left
           (the app's only visible entry to the settings overlay — the app menu
           and Cmd+, reach the same place), the update pill's slot on the right,
           the two centered against each other. The row sits outside
           #sidebar-sections so the session-list rebuild never clears it. -->
      <div class="sidebar-footer">
        <button id="sidebar-settings" class="chrome-icon-button" type="button" aria-label="Settings" data-tooltip="Settings"></button>
        <!-- Auto-update S2: the update pill's persistent slot. Empty +
             display:none unless an update is staged, so the footer reserves no
             space for it when there is nothing to do (update-button.ts
             render() owns the toggle). The footer itself stays visible. -->
        <div id="sidebar-update-slot" class="sidebar-update-slot hidden"></div>
      </div>
    </aside>
    <div id="sidebar-resizer" class="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize · double-click to reset"></div>
    <div class="main-pane">
    <header class="task-chrome">
      <div class="chrome-left">
        <button id="sidebar-toggle" class="chrome-icon-button" type="button" title="Toggle sidebar" aria-label="Toggle sidebar"></button>
        <div id="task-title-slot" class="header-title-slot">
          <h1 id="task-title" class="header-title">No active session</h1>
        </div>
        <button id="session-menu-trigger" class="chrome-icon-button session-menu-trigger hidden" type="button" title="Session actions" aria-haspopup="menu" aria-label="Session actions"></button>
        <div id="header-rename-notice" class="rename-surface-notice hidden" role="alert"></div>
      </div>
      <div class="chrome-center">
      </div>
      <div class="topbar-actions chrome-actions">
        <button
          id="reading-settings"
          class="chrome-icon-button reading-settings-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-expanded="false"
          aria-label="Themes"
          data-tooltip="Themes"
        ></button>
        <button id="remote-control-toggle" class="chrome-icon-button" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Remote control" data-tooltip="Remote control"></button>
        <button id="toggle-terminal-window" class="chrome-icon-button" type="button" aria-pressed="true" aria-label="Toggle Terminal (CLI)" data-tooltip="Toggle Terminal (CLI)"></button>
        <button id="open-preview-window" class="chrome-icon-button" type="button" aria-label="Toggle Preview" data-tooltip="Toggle Preview"></button>
      </div>
    </header>
    <div id="reading-popover-root"></div>
    <div id="remote-control-popover-root"></div>
    <div id="task-settings-popover-root"></div>

    <section class="workspace">
      <section id="run-column" class="run-column" aria-label="Run reading surface">
        <!-- Status strip (S5; moved into the reading flow 2026-07-03): the
             slim live-activity surface — spinner region verbatim (display-only,
             StatusRegionTracker) + running-subagent roster (transcript-derived).
             It lives INSIDE the scroll container as the run list's LAST child:
             the conversation's typing indicator — "the next content is being
             written here" — so completion materializes the reply exactly where
             the activity stood. A persistent node like the sticky rail: the
             keyed reconcile and setNonRailChildren both skip it, so the ~3Hz
             ticks keep updating it in place and its animations never restart. -->
        <div id="run-list" class="run-list">
          <section id="status-strip" class="status-strip hidden" aria-label="Live activity">
            <div id="status-strip-status" class="status-strip-status"></div>
            <div id="status-strip-agents" class="status-strip-agents hidden"></div>
          </section>
        </div>

        <div class="scroll-to-bottom-anchor">
          <button
            id="scroll-to-bottom"
            class="scroll-to-bottom hidden"
            type="button"
            aria-label="Scroll to bottom"
            aria-hidden="true"
            tabindex="-1"
            title="Scroll to bottom"
          ></button>
        </div>

        <!-- Bottom zone (drawer S2), three intensity tiers stacked above the
             composer slot: attention banners (passive pointers) → resume-choice
             (ignorable decision) → the ACTION DRAWER, which REPLACES the
             composer card in its own slot (inside the #composer form below). -->
        <div id="attention-banner-root" class="attention-banner-root"></div>

        <section id="resume-choice" class="resume-choice hidden" aria-label="Resume choice">
          <div class="resume-choice-copy">
            <strong id="resume-choice-title">Resume this session?</strong>
            <p id="resume-choice-body"></p>
            <p id="resume-bridge-note" class="resume-bridge-note hidden">
              Claude's own resume warning is currently turned off (an earlier temporary bridge).
              <button id="resume-bridge-revert" class="link-button" type="button">Restore it</button>
            </p>
          </div>
          <div class="resume-choice-actions">
            <label class="resume-remember"><input type="checkbox" id="resume-remember" /> Remember my choice</label>
            <button id="resume-full" class="secondary" type="button">Resume full session</button>
            <button id="resume-summary" class="primary" type="button">Resume from summary</button>
          </div>
        </section>

        <form id="composer" class="composer" aria-label="Composer" tabindex="-1">
          <!-- Action drawer (drawer S2): blocking interactions transform the
               composer in place — same slot, same width. While either drawer
               is visible, #composer carries .drawer-active which hides the
               composer card (physically closing the type-into-the-TUI-form
               hole). Only one drawer shows at a time. -->
          <div id="approval-banner" class="action-drawer approval-drawer hidden">
            <div class="drawer-head">
              <span id="approval-kind-badge" class="drawer-kind">Unknown</span>
            </div>
            <strong id="approval-title" class="drawer-title">Approve this action?</strong>
            <!-- Codex asks carry a human-written description (the "why") —
                 shown as a sub-line; Claude summaries are derived from the
                 command and stay redundant with the code block (S2 review F5). -->
            <p id="approval-summary" class="drawer-summary hidden"></p>
            <div id="approval-context" class="drawer-code hidden"></div>
            <div id="approval-actions" class="drawer-actions">
              <button id="deny-approval" class="secondary" type="button">Deny</button>
              <button id="approve-session-approval" class="secondary hidden" type="button">Allow Session</button>
              <button id="approve-approval" class="primary" type="button">Approve</button>
            </div>
            <!-- Expired variant (drawer S2): the broker hold lapsed — same
                 drawer, honest state change. Content stays; actions swap. -->
            <div id="approval-expired-row" class="drawer-expired hidden">
              <span class="drawer-expired-copy">Timed out — this request is now waiting in the CLI</span>
              <button id="approval-open-cli" class="attention-open-terminal" type="button">Answer in CLI →</button>
            </div>
          </div>

          <!-- Native option prompt (AskUserQuestion) — the question drawer.
               Built dynamically by renderOptionPrompt(): stepped 1/N + Review. -->
          <div id="option-prompt-card" class="action-drawer question-drawer hidden"></div>

          <!-- Recognized-confirm relay (S7 revision 3) — the CLI raised a whitelisted
               confirm dialog (claude cache-miss / codex Full Access consent) and
               Sonata PARKED on it. Built dynamically by renderControlConfirm(): the
               dialog's verbatim rows as answer buttons. Its home turf: the CLI asks,
               the user answers here, the choice is relayed into the parked dialog. -->
          <div id="control-confirm-card" class="action-drawer question-drawer hidden"></div>

          <!-- New Chat readiness card (CLI readiness S2, D9): the preselected
               provider's CLI is missing or not signed in, so the composer cannot
               start a session yet. Its own slot ABOVE the composer card, never in
               place of it: the card's copy states the fact, while the card below
               keeps the provider / model / access chips reachable so the user can
               switch to a working CLI (D6). Empty and shrunk to nothing whenever
               there is nothing wrong. -->
          <div id="cli-readiness-card-root" class="cli-readiness-card-root"></div>

          <!-- The white card: the message and its controls. The context row
               below is a SEPARATE tinted layer (ref parity, 2026-07-04):
               "where this runs" is the stage the card sits on, not a line
               inside the message. -->
          <div class="composer-card">
            <div id="attachment-strip" class="attachment-strip hidden" aria-label="Attachments"></div>
            <textarea id="prompt-input" placeholder="Start or open a Task"></textarea>
            <div class="composer-control-row">
              <div class="composer-control-left">
                <button id="add-attachment" class="composer-icon-button" type="button" aria-label="Add photos & files">+</button>
                <button id="permission-chip" class="composer-chip hidden" type="button"></button>
              </div>
              <div class="composer-actions">
                <button id="provider-chip" class="composer-chip hidden" type="button" aria-haspopup="menu" aria-expanded="false"></button>
                <button id="model-chip" class="composer-chip hidden" type="button"></button>
                <button
                  id="usage-indicator"
                  class="usage-indicator empty"
                  type="button"
                  aria-label="Usage data"
                  aria-haspopup="dialog"
                  aria-expanded="false"
                  disabled
                >
                  <svg class="usage-ring" viewBox="0 0 20 20" aria-hidden="true">
                    <circle class="usage-ring-track" cx="10" cy="10" r="7.5"></circle>
                    <circle class="usage-ring-fill" cx="10" cy="10" r="7.5" pathLength="100"></circle>
                  </svg>
                </button>
                <button
                  id="send-prompt"
                  class="primary send-button"
                  type="button"
                  disabled
                  aria-label="Send prompt"
                >↑</button>
              </div>
            </div>
          </div>
          <!-- New-chat context row: the project chip — where this session will
               work — on the tinted band beneath the card. Hidden for live and
               dormant sessions (cwd is fixed). -->
          <div id="composer-context-row" class="composer-context-row hidden">
            <button id="project-chip" class="composer-chip project-chip" type="button" aria-haspopup="menu" aria-expanded="false"></button>
          </div>
          <!-- Action feedback ONLY (2026-07-04 ruling): lifecycle narration
               never renders here — composerNotice suppresses it. -->
          <div id="runtime-status" class="composer-status hidden" role="status"></div>
          <div id="composer-popover-root"></div>
        </form>
      </section>

    </section>
    </div>
    <div id="sidebar-menu-root"></div>
    <div id="sidebar-hover-card-root"></div>
    <div id="quote-comment-root"></div>
    <div id="settings-overlay-root"></div>
    <!-- The quit confirmation stacks above every other surface in this window
         (S4) — including the Settings overlay, whose scrim it must cover. -->
    <div id="quit-confirm-root"></div>
  </section>
`;

  elements = queryElements();
}

export function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing renderer element: ${id}`);
  }
  return element as T;
}
