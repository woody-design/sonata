import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Fixture coverage for the named state transitions (map step C3d). Each
// transition is a verbatim lift of a shell handler's mutation lines; these
// fixtures pin the policy-bearing ones — displacement rules on popover open,
// the slash picker's keep-entries/keep-selection rules, the folder-touched
// latch, and the session-index follow. Assertions pin MEASURED behavior
// (A1 lesson).
const require = createRequire(import.meta.url);
const { createInitialState, createTaskView, upsertTaskView } = require("../../dist/reading-core/state");
const popovers = require("../../dist/reading-core/transitions/popovers");
const composer = require("../../dist/reading-core/transitions/composer");
const sidebar = require("../../dist/reading-core/transitions/sidebar");
const rename = require("../../dist/reading-core/transitions/rename");
const session = require("../../dist/reading-core/transitions/session");

const READING_SETTINGS = { theme: "paper", mode: "system", textStep: 0 };
const ANCHOR = { left: 10, top: 20, width: 30 };
const RECT = { left: 1, top: 2, right: 3, bottom: 4, width: 2, height: 2 };

function freshState() {
  return createInitialState({ ...READING_SETTINGS });
}

function task(id, title = `Task ${id}`) {
  return {
    id,
    title,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    provider: "claude",
    status: "ready",
  };
}

// 1) Reading popover toggle — displacement on open; lazy anchor only read on
// the opening branch; close clears both fields.
{
  const state = freshState();
  state.composerMenu = { type: "add", anchor: ANCHOR };
  state.taskDraft.menu = { kind: "launch", anchor: ANCHOR };
  state.remoteControlPopoverOpen = true;
  state.remoteControlPopoverAnchor = ANCHOR;

  let anchorReads = 0;
  const anchor = () => {
    anchorReads += 1;
    return ANCHOR;
  };
  popovers.toggleReadingPopover(state, anchor);
  assert.equal(state.readingPopoverOpen, true, "opens");
  assert.equal(anchorReads, 1, "anchor read on open");
  assert.equal(state.composerMenu, null, "open displaces the composer menu");
  assert.equal(state.taskDraft.menu, null, "…and the draft menu");
  assert.equal(state.remoteControlPopoverOpen, false, "…and the RC popover");

  popovers.toggleReadingPopover(state, anchor);
  assert.equal(state.readingPopoverOpen, false, "toggles closed");
  assert.equal(state.readingPopoverAnchor, null, "anchor cleared");
  assert.equal(anchorReads, 1, "anchor NOT read on the closing branch");
}

// 2) Composer menu toggle — same type closes; open displaces slash picker +
// usage popover. Usage popover open keeps a previous pin (pinned || previous).
{
  const state = freshState();
  state.slashPicker = { provider: "claude", entries: [], query: "", selectedIndex: 0 };
  state.taskDraft.menu = { kind: "provider", anchor: ANCHOR };
  popovers.toggleComposerMenu(state, "add", ANCHOR);
  assert.deepEqual(state.composerMenu, { type: "add", anchor: ANCHOR }, "opens with anchor");
  assert.equal(state.slashPicker, null, "open displaces the slash picker");
  assert.equal(state.taskDraft.menu, null, "…and the draft chip menu (review P2)");
  popovers.toggleComposerMenu(state, "add", ANCHOR);
  assert.equal(state.composerMenu, null, "same type toggles closed");

  popovers.openUsagePopover(state, true);
  popovers.openUsagePopover(state, false);
  assert.equal(state.usagePopover.pinned, true, "a hover open never unpins a pinned popover");
  assert.equal(popovers.closeUsagePopover(state), true, "close reports the change");
  assert.equal(popovers.closeUsagePopover(state), false, "…and the no-op");
}

// 3) Settings overlay — open is a no-op when already open (in-flight reads
// survive); close drops the whole overlay state.
{
  const state = freshState();
  assert.equal(popovers.openSettingsOverlay(state), true, "first open");
  state.settingsOverlay.policyMenuOpen = true;
  assert.equal(popovers.openSettingsOverlay(state), false, "second open is a no-op");
  assert.equal(state.settingsOverlay.policyMenuOpen, true, "…and does not reset the overlay");
  popovers.closeSettingsOverlay(state);
  assert.equal(state.settingsOverlay, null, "closed");
}

// 4) Slash picker — keep entries for the same provider, fall back on a
// provider switch (lazy, only when needed); keep the selection for the same
// query, reset it on a new one; clamp bounds the selection to the filtered
// list; move wraps modulo.
{
  const entry = (name) => ({
    invocation: `/${name}`,
    name,
    description: `${name} command`,
    provider: "claude",
    kind: "builtin",
    listed: true,
  });
  const cached = [entry("alpha"), entry("beta"), entry("gamma")];
  const state = freshState();

  let fallbackReads = 0;
  const fallback = () => {
    fallbackReads += 1;
    return cached;
  };
  state.taskDraft.menu = { kind: "access", anchor: ANCHOR };
  composer.openOrRefreshSlashPicker(state, "claude", "", fallback);
  assert.equal(fallbackReads, 1, "fresh open pulls the fallback entries");
  assert.equal(state.slashPicker.selectedIndex, 0);
  assert.equal(state.taskDraft.menu, null, "picker open displaces the draft chip menu (review P2)");

  composer.moveSlashSelection(state, -1);
  assert.equal(state.slashPicker.selectedIndex, 2, "move wraps modulo");

  composer.openOrRefreshSlashPicker(state, "claude", "", fallback);
  assert.equal(fallbackReads, 1, "same provider keeps entries (no fallback read)");
  assert.equal(state.slashPicker.selectedIndex, 2, "same query keeps the selection");

  composer.openOrRefreshSlashPicker(state, "claude", "alp", fallback);
  assert.equal(state.slashPicker.selectedIndex, 0, "new query resets the selection");

  composer.installSlashEntries(state, [entry("alpha")]);
  assert.equal(state.slashPicker.entries.length, 1, "fresh entries install");
  assert.equal(state.slashPicker.selectedIndex, 0, "…and re-clamp");

  assert.equal(composer.closeSlashPicker(state), true, "close reports the change");
  assert.equal(composer.closeSlashPicker(state), false, "…and the no-op");
  assert.equal(composer.moveSlashSelection(state, 1), false, "move without a picker is a no-op");
}

// 5) parkComposerDraft — slot follows the owner: active view's composerDraft,
// else the New Chat slot.
{
  const state = freshState();
  composer.parkComposerDraft(state, "new chat words");
  assert.equal(state.newChatComposerDraft, "new chat words", "no active task → New Chat slot");

  const view = createTaskView(task("t1"), "Ready");
  upsertTaskView(state, view);
  state.activeTaskId = "t1";
  composer.parkComposerDraft(state, "task words");
  assert.equal(state.taskViews[0].composerDraft, "task words", "active task → its own slot");
  assert.equal(state.newChatComposerDraft, "new chat words", "New Chat slot untouched");
}

// 6) Sidebar transitions — menu open/close/section-toggle, prefs patch,
// collapse toggle, rename start/end.
{
  const state = freshState();
  assert.equal(sidebar.closeSidebarMenu(state), false, "close with no menu is a no-op");
  assert.equal(sidebar.toggleFilterMenuSection(state, "status"), false, "…so is a section toggle");

  sidebar.openFilterMenu(state, RECT);
  assert.deepEqual(state.sidebar.menu, { kind: "filter", anchor: RECT, openSection: null });
  assert.equal(sidebar.toggleFilterMenuSection(state, "status"), true);
  assert.equal(state.sidebar.menu.openSection, "status", "section opens");
  sidebar.toggleFilterMenuSection(state, "status");
  assert.equal(state.sidebar.menu.openSection, null, "same section toggles closed");

  sidebar.openSessionMenu(state, "t1", "Title", false, RECT);
  assert.equal(state.sidebar.menu.kind, "session");
  sidebar.openProjectMenu(state, "/p", "P", true, RECT);
  assert.equal(state.sidebar.menu.kind, "project");
  assert.equal(sidebar.closeSidebarMenu(state), true);

  sidebar.patchSidebarPrefs(state, { status: "all" });
  assert.equal(state.sidebar.prefs.status, "all", "patch merges");
  assert.equal(state.sidebar.prefs.groupBy, "project", "…and keeps the rest");

  sidebar.toggleProjectCollapsed(state, "/p");
  assert.equal(state.sidebar.collapsedProjects.has("/p"), true);
  sidebar.toggleProjectCollapsed(state, "/p");
  assert.equal(state.sidebar.collapsedProjects.has("/p"), false);

  assert.equal(rename.startSessionRename(state, "t1", "sidebar", "Title"), true);
  assert.equal(state.sidebar.renameEditor.taskId, "t1");
  assert.equal(rename.cancelRename(state), true);
  assert.equal(state.sidebar.renameEditor, null);
  assert.equal(rename.startProjectRename(state, "/p", "P"), true);
  assert.equal(state.sidebar.renameEditor.path, "/p");
  assert.equal(rename.cancelRename(state), true);
  assert.equal(state.sidebar.renameEditor, null);
}

// 7) syncTaskViewsFromIndex — open views follow the index's title/archived/live;
// only an ACTIVE view's change requests the full re-render.
{
  const state = freshState();
  upsertTaskView(state, createTaskView(task("t1", "Old"), "Ready"));
  upsertTaskView(state, createTaskView(task("t2", "Stable"), "Ready"));
  state.activeTaskId = "t1";

  const index = {
    projects: [
      {
        path: "/p",
        name: "P",
        archived: false,
        sessions: [
          { task: { ...task("t1", "New"), archived: false }, archived: false, live: true },
          { task: task("t2", "Stable"), archived: false, live: true },
        ],
      },
    ],
    chats: [],
  };
  assert.equal(session.syncTaskViewsFromIndex(state, index), true, "active title change → full");
  assert.equal(state.taskViews[0].task.title, "New");

  state.activeTaskId = "t2";
  index.projects[0].sessions[0].task.title = "Newer";
  assert.equal(
    session.syncTaskViewsFromIndex(state, index),
    false,
    "background-only change → no full render request",
  );
  assert.equal(state.taskViews[0].task.title, "Newer", "…but the view still follows");

  index.projects[0].sessions[1].live = false;
  assert.equal(
    session.syncTaskViewsFromIndex(state, index),
    true,
    "active live→dormant transition → full render request",
  );
  assert.equal(state.taskViews[1].live, false, "active view follows dormant index state");

  index.projects[0].sessions[1].live = true;
  assert.equal(
    session.syncTaskViewsFromIndex(state, index),
    true,
    "active dormant→live transition → full render request",
  );
  assert.equal(state.taskViews[1].live, true, "active view follows resumed index state");
}

// 8) removeTaskView / markViewSeen — active close hands the composer over
// (caller restores); background close leaves the active surface alone.
{
  const state = freshState();
  upsertTaskView(state, createTaskView(task("t1"), "Ready"));
  upsertTaskView(state, createTaskView(task("t2"), "Ready"));
  state.activeTaskId = "t1";
  state.usagePopover = { pinned: true };

  assert.equal(session.removeTaskView(state, "t2"), false, "background close");
  assert.equal(state.activeTaskId, "t1");
  assert.ok(state.usagePopover, "active surface untouched");

  assert.equal(session.removeTaskView(state, "t1"), true, "active close");
  assert.equal(state.activeTaskId, null);
  assert.equal(state.usagePopover, null);
  assert.equal(state.taskViews.length, 0);

  const view = createTaskView(task("t3"), "Ready");
  view.unread = true;
  view.completedUnseen = true;
  session.markViewSeen(view);
  assert.equal(view.unread, false);
  assert.equal(view.completedUnseen, false);
}

// 9) The launch-draft folder policy — the touched latch and its consumers.
{
  const state = freshState();
  state.sessionIndex = { projects: [], chats: [], lastUsedFolder: "/last" };
  state.remoteControlDefault = true;
  state.taskDraft.remoteControl = false;
  state.taskDraft.message = { tone: "info", text: "old" };

  session.resetTaskDraftForNewChat(state);
  assert.equal(state.taskDraft.cwd, "/last", "untouched draft follows lastUsedFolder");
  assert.equal(state.taskDraftFolderTouched, false, "…without setting the latch");
  assert.equal(state.taskDraft.message, null, "message cleared");
  assert.equal(state.taskDraft.remoteControl, true, "RC re-seeded from the global default");

  session.resetTaskDraftForNewChat(state, "/explicit");
  assert.equal(state.taskDraft.cwd, "/explicit", "explicit folder wins");
  assert.equal(state.taskDraftFolderTouched, true, "…and sets the latch");

  state.sessionIndex.lastUsedFolder = "/other";
  session.resetTaskDraftForNewChat(state);
  assert.equal(state.taskDraft.cwd, "/explicit", "touched draft ignores lastUsedFolder");

  const s2 = freshState();
  session.chooseDraftFolder(s2, "/quick");
  assert.deepEqual(
    [s2.taskDraft.cwd, s2.taskDraftFolderTouched, s2.taskDraft.message],
    ["/quick", true, null],
    "quick pick",
  );
  session.clearDraftFolder(s2);
  assert.equal(s2.taskDraft.cwd, null);
  assert.equal(s2.taskDraftFolderTouched, true, "clearing also counts as touching");
  assert.equal(
    s2.taskDraft.message,
    null,
    "no draft message — the greeting + project chip restate the choice (2026-07-04)",
  );
  session.applyPickedTaskFolder(s2, "/Users/x/proj");
  assert.equal(s2.taskDraft.cwd, "/Users/x/proj");
  assert.equal(s2.status, "Selected proj", "status uses the folder's basename");
  assert.equal(s2.taskDraft.message, null, "picked folder shows on the chip, not as a message");
}

console.log("reading-transitions: 9 fixture groups pass");
