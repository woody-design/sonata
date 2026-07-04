// The Reading window's DOM shell (map §3.1 renderer/dom.ts, D1): the static
// template, the id lookup helper, and the `elements` registry every render
// path reads. No import-time side effects (R4) — main.ts calls initDom() at
// the template-injection point of the boot sequence, and `elements` is a live
// binding that view modules read at call time, never at import time.

function queryElements() {
  return {
    taskTitle: getElement<HTMLHeadingElement>("task-title"),
    runtimeStatus: getElement<HTMLDivElement>("runtime-status"),
    readingSettings: getElement<HTMLButtonElement>("reading-settings"),
    readingPopoverRoot: getElement<HTMLDivElement>("reading-popover-root"),
    taskSettingsPopoverRoot: getElement<HTMLDivElement>("task-settings-popover-root"),
    remoteControlToggle: getElement<HTMLButtonElement>("remote-control-toggle"),
    remoteControlPopoverRoot: getElement<HTMLDivElement>("remote-control-popover-root"),
    openPreviewWindow: getElement<HTMLButtonElement>("open-preview-window"),
    openInspectorWindow: getElement<HTMLButtonElement>("open-inspector-window"),
    toggleTerminalWindow: getElement<HTMLButtonElement>("toggle-terminal-window"),
    sidebar: getElement<HTMLElement>("sidebar"),
    sidebarResizer: getElement<HTMLDivElement>("sidebar-resizer"),
    sidebarNewChat: getElement<HTMLButtonElement>("sidebar-new-chat"),
    sidebarList: getElement<HTMLDivElement>("sidebar-list"),
    sidebarToggle: getElement<HTMLButtonElement>("sidebar-toggle"),
    sidebarCollapse: getElement<HTMLButtonElement>("sidebar-collapse"),
    sidebarMenuRoot: getElement<HTMLDivElement>("sidebar-menu-root"),
    settingsOverlayRoot: getElement<HTMLDivElement>("settings-overlay-root"),
    sessionMenuTrigger: getElement<HTMLButtonElement>("session-menu-trigger"),
    approvalBanner: getElement<HTMLDivElement>("approval-banner"),
    approvalKindBadge: getElement<HTMLSpanElement>("approval-kind-badge"),
    approvalTitle: getElement<HTMLElement>("approval-title"),
    approvalSummary: getElement<HTMLParagraphElement>("approval-summary"),
    approvalContext: getElement<HTMLDivElement>("approval-context"),
    denyApproval: getElement<HTMLButtonElement>("deny-approval"),
    approveSessionApproval: getElement<HTMLButtonElement>("approve-session-approval"),
    approveApproval: getElement<HTMLButtonElement>("approve-approval"),
    optionPromptCard: getElement<HTMLDivElement>("option-prompt-card"),
    attentionBannerRoot: getElement<HTMLDivElement>("attention-banner-root"),
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
    attachmentStrip: getElement<HTMLDivElement>("attachment-strip"),
    addAttachment: getElement<HTMLButtonElement>("add-attachment"),
    permissionChip: getElement<HTMLButtonElement>("permission-chip"),
    modelChip: getElement<HTMLButtonElement>("model-chip"),
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
  <section class="shell" aria-label="Duet">
    <aside id="sidebar" class="sidebar" aria-label="Sessions">
      <div class="sidebar-top">
        <div class="sidebar-rail">
          <button id="sidebar-collapse" class="chrome-icon-button" type="button" title="Collapse sidebar" aria-label="Collapse sidebar"></button>
        </div>
        <button id="sidebar-new-chat" class="sidebar-new-chat" type="button" title="New chat">
          <span class="sidebar-new-chat-icon"></span><span>New chat</span>
        </button>
      </div>
      <nav id="sidebar-sections" class="sidebar-sections" aria-label="Session list">
        <div id="sidebar-list"></div>
      </nav>
    </aside>
    <div id="sidebar-resizer" class="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize · double-click to reset"></div>
    <div class="main-pane">
    <header class="task-chrome">
      <div class="chrome-left">
        <button id="sidebar-toggle" class="chrome-icon-button" type="button" title="Toggle sidebar" aria-label="Toggle sidebar"></button>
        <h1 id="task-title" class="header-title">No active session</h1>
        <button id="session-menu-trigger" class="chrome-icon-button session-menu-trigger hidden" type="button" title="Session actions" aria-haspopup="menu" aria-label="Session actions"></button>
      </div>
      <div class="chrome-center">
      </div>
      <div class="topbar-actions chrome-actions">
        <button id="toggle-terminal-window" class="secondary" type="button" aria-pressed="true" title="Close the terminal window">Close Terminal</button>
        <button
          id="reading-settings"
          class="secondary reading-settings-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-expanded="false"
          title="Reading Controls"
        >Aa</button>
        <button id="remote-control-toggle" class="chrome-icon-button" type="button" aria-haspopup="dialog" aria-expanded="false" title="Remote control" aria-label="Remote control"></button>
        <button id="open-preview-window" class="chrome-icon-button" type="button" title="Preview" aria-label="Open Preview"></button>
        <button id="open-inspector-window" class="chrome-icon-button" type="button" title="Inspector" aria-label="Open Inspector"></button>
      </div>
    </header>
    <div id="reading-popover-root"></div>
    <div id="remote-control-popover-root"></div>
    <div id="task-settings-popover-root"></div>

    <section class="workspace">
      <section id="run-column" class="run-column" aria-label="Run reading surface">
        <div id="approval-banner" class="approval-banner hidden">
          <div class="approval-copy">
            <div class="approval-heading">
              <p class="eyebrow">Approval</p>
              <span id="approval-kind-badge" class="approval-kind-badge">Unknown</span>
            </div>
            <strong id="approval-title">Native approval requested</strong>
            <p id="approval-summary" class="approval-summary"></p>
            <div id="approval-context" class="approval-context"></div>
          </div>
          <div class="approval-actions">
            <button id="deny-approval" class="secondary" type="button">Deny</button>
            <button id="approve-session-approval" class="secondary hidden" type="button">Allow Session</button>
            <button id="approve-approval" class="primary" type="button">Approve</button>
          </div>
        </div>

        <!-- Native option prompt (AskUserQuestion). Built dynamically by
             renderOptionPrompt() — N questions, each a single-select group. -->
        <div id="option-prompt-card" class="option-prompt-card hidden"></div>

        <!-- Attention banners (S5): passive "waiting for you in the Terminal"
             pointers — one family, display-only, click focuses the terminal
             window, never drives runtime state. -->
        <div id="attention-banner-root" class="attention-banner-root"></div>

        <!-- Status strip (S5; moved into the reading flow 2026-07-03): the
             slim live-activity surface — spinner region verbatim (display-only,
             StatusRegionTracker) + running-subagent roster (transcript-derived).
             It lives INSIDE the scroll container as the run list's LAST child:
             the conversation's typing indicator — "the next content is being
             written here" — so completion materializes the reply exactly where
             the activity stood. A persistent node like the sticky rail: the
             keyed reconcile and the empty-state path both skip it, so the ~3Hz
             ticks keep updating it in place and its animations never restart. -->
        <div id="run-list" class="run-list">
          <section id="status-strip" class="status-strip hidden" aria-label="Live activity">
            <div id="status-strip-status" class="status-strip-status"></div>
            <div id="status-strip-agents" class="status-strip-agents hidden"></div>
          </section>
        </div>

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

        <form id="composer" class="composer">
          <div id="attachment-strip" class="attachment-strip hidden" aria-label="Attachments"></div>
          <textarea id="prompt-input" placeholder="Start or open a Task"></textarea>
          <div class="composer-control-row">
            <div class="composer-control-left">
              <button id="add-attachment" class="composer-icon-button" type="button" aria-label="Add photos & files">+</button>
              <button id="permission-chip" class="composer-chip hidden" type="button"></button>
            </div>
            <div class="composer-actions">
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
          <div id="runtime-status" class="composer-status hidden" role="status"></div>
          <div id="composer-popover-root"></div>
        </form>
      </section>

    </section>
    </div>
    <div id="sidebar-menu-root"></div>
    <div id="settings-overlay-root"></div>
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
