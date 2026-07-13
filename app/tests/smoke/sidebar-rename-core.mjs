import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Slice 4 pure rename fence: one state-backed editor, synchronous single-flight
// claim, IME suppression, validation/cancel/retry/stale-version behavior, and
// canonical synchronization before close. No DOM or IPC participates here.
const require = createRequire(import.meta.url);
const { createInitialState } = require("../../dist/reading-core/state");
const rename = require("../../dist/reading-core/transitions/rename");
const renameFlow = require("../../dist/reading-core/rename-flow");

function freshState() {
  return createInitialState({ theme: "duet", mode: "light", textStep: 16 });
}

function task(id, title) {
  return {
    id,
    title,
    provider: "claude",
    model: null,
    reasoningEffort: null,
    speedMode: null,
    sandbox: null,
    approval: null,
    permissionMode: null,
    runtimeSessionId: `runtime-${id}`,
    providerSessionRef: null,
    providerCwd: "/workspace/alpha",
    workingDirectory: "/workspace/alpha",
    status: "idle",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

function summary(value) {
  return {
    task: value,
    storageRoot: `/records/${value.id}`,
    archived: false,
    live: false,
    liveStatus: null,
    lastActivityAt: value.updatedAt,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// 1) Exactly one editor owns origin, draft, lifecycle, and request generation.
{
  const state = freshState();
  assert.equal(rename.startSessionRename(state, "s1", "header", "Original"), true);
  assert.deepEqual(state.sidebar.renameEditor, {
    kind: "session",
    taskId: "s1",
    surface: "header",
    original: "Original",
    draft: "Original",
    status: "editing",
    requestVersion: 0,
    errorMessage: null,
    composing: false,
  });
  assert.equal(
    rename.startProjectRename(state, "/workspace/alpha", "Alpha"),
    false,
    "a second intent cannot silently replace the active editor",
  );
  assert.equal(state.sidebar.renameEditor.kind, "session");
}

// 2) Composition and legacy keyCode 229 suppress commands; composition-end
// stores the final draft before commit.
{
  const state = freshState();
  rename.startSessionRename(state, "s1", "sidebar", "Original");
  rename.setRenameComposing(state, true);
  assert.equal(rename.renameCommandSuppressed(state, { isComposing: false, keyCode: 13 }), true);
  assert.deepEqual(rename.requestRenameCommit(state, "enter"), {
    kind: "ignored",
    reason: "composing",
  });
  rename.updateRenameDraft(state, "変換後");
  rename.setRenameComposing(state, false);
  assert.equal(rename.renameCommandSuppressed(state, { isComposing: true, keyCode: 13 }), true);
  assert.equal(rename.renameCommandSuppressed(state, { isComposing: false, keyCode: 229 }), true);
  assert.equal(rename.renameCommandSuppressed(state, { isComposing: false, keyCode: 13 }), false);
  const decision = rename.requestRenameCommit(state, "enter");
  assert.equal(decision.kind, "commit");
  assert.equal(decision.request.title, "変換後");
}

// 3) First trigger claims the slot synchronously; Enter + blur + window blur
// share one request/version. Canonical data lands in every local projection
// before the editor closes.
{
  const state = freshState();
  const original = task("s1", "Original");
  state.taskViews = [{ task: original }];
  state.sessionIndex = {
    projects: [
      {
        path: "/workspace/alpha",
        name: "Alpha",
        archived: false,
        lastActivityAt: original.updatedAt,
        sessions: [summary(original)],
      },
    ],
    chats: [summary(original)],
    lastUsedFolder: "/workspace/alpha",
  };
  rename.startSessionRename(state, "s1", "sidebar", "Original");
  rename.updateRenameDraft(state, "  Canonical title  ");
  const first = rename.requestRenameCommit(state, "enter");
  assert.equal(first.kind, "commit");
  assert.equal(first.request.requestVersion, 1);
  assert.equal(first.request.title, "Canonical title");
  assert.deepEqual(rename.requestRenameCommit(state, "blur"), {
    kind: "ignored",
    reason: "committing",
  });
  assert.deepEqual(rename.requestRenameCommit(state, "window-blur"), {
    kind: "ignored",
    reason: "committing",
  });
  assert.equal(rename.cancelRename(state), false, "Escape cannot cancel an in-flight write");

  const canonical = task("s1", "Canonical title");
  rename.synchronizeCanonicalSessionRename(state, canonical);
  assert.equal(state.taskViews[0].task.title, "Canonical title");
  assert.equal(state.sessionIndex.projects[0].sessions[0].task.title, "Canonical title");
  assert.equal(state.sessionIndex.chats[0].task.title, "Canonical title");
  assert.equal(state.sidebar.renameEditor.status, "committing", "editor remains until sync completes");
  assert.equal(rename.completeRenameCommit(state, first.request), true);
  assert.equal(state.sidebar.renameEditor, null);
}

// 4) Enter-empty validates in place; normal focus departure reverts empty;
// unchanged input is a no-op; Escape cancels editing/error.
{
  const state = freshState();
  rename.startProjectRename(state, "/workspace/alpha", "Alpha");
  rename.updateRenameDraft(state, "   ");
  assert.deepEqual(rename.requestRenameCommit(state, "enter"), {
    kind: "invalid",
    errorMessage: rename.EMPTY_RENAME_ERROR,
  });
  assert.equal(state.sidebar.renameEditor.status, "error");
  assert.equal(rename.cancelRename(state), true);

  rename.startProjectRename(state, "/workspace/alpha", "Alpha");
  rename.updateRenameDraft(state, " ");
  assert.deepEqual(rename.requestRenameCommit(state, "blur"), { kind: "reverted-empty" });
  assert.equal(state.sidebar.renameEditor, null);

  rename.startProjectRename(state, "/workspace/alpha", "Alpha");
  rename.updateRenameDraft(state, " Alpha ");
  assert.deepEqual(rename.requestRenameCommit(state, "enter"), { kind: "unchanged" });
  assert.equal(state.sidebar.renameEditor, null);
}

// 5) Failure retains draft/error and retry increments generation. Stale
// completion after entity disappearance cannot mutate or close a new editor.
{
  const state = freshState();
  state.sessionIndex = {
    projects: [
      {
        path: "/workspace/alpha",
        name: "Alpha",
        archived: false,
        lastActivityAt: null,
        sessions: [],
      },
    ],
    chats: [],
    lastUsedFolder: null,
  };
  rename.startProjectRename(state, "/workspace/alpha", "Alpha");
  rename.updateRenameDraft(state, "  Beta  ");
  const first = rename.requestRenameCommit(state, "enter");
  assert.equal(first.kind, "commit");
  assert.equal(rename.failRenameCommit(state, first.request, "Disk full"), true);
  assert.equal(state.sidebar.renameEditor.status, "error");
  assert.equal(state.sidebar.renameEditor.draft, "  Beta  ", "failure preserves exact draft");
  assert.equal(state.sidebar.renameEditor.errorMessage, "Disk full");

  const retry = rename.requestRenameCommit(state, "enter");
  assert.equal(retry.kind, "commit");
  assert.equal(retry.request.requestVersion, 2);
  rename.synchronizeCanonicalProjectRename(state, {
    path: "/workspace/alpha",
    displayName: "Beta",
    name: "Beta",
  });
  assert.equal(state.sessionIndex.projects[0].name, "Beta");
  assert.equal(rename.completeRenameCommit(state, retry.request), true);

  rename.startSessionRename(state, "gone", "sidebar", "Gone");
  rename.updateRenameDraft(state, "New gone");
  const stale = rename.requestRenameCommit(state, "enter");
  assert.equal(stale.kind, "commit");
  const orphan = rename.terminateRenameForMissingEntity(state);
  assert.equal(orphan.taskId, "gone");
  assert.equal(rename.currentRenameRequestMatches(state, stale.request), false);
  assert.equal(rename.completeRenameCommit(state, stale.request), false);
  assert.equal(rename.failRenameCommit(state, stale.request, "late"), false);
}

// 6) The real async flow performs one port call for duplicate triggers, keeps
// failure retryable, synchronizes before close, and ignores a completion that
// became stale while persistence was in flight.
{
  const state = freshState();
  const original = task("async", "Original");
  state.taskViews = [{ task: original }];
  rename.startSessionRename(state, "async", "header", "Original");
  rename.updateRenameDraft(state, "Canonical async");
  const pending = deferred();
  let sessionCalls = 0;
  const ports = {
    renameSession: () => {
      sessionCalls += 1;
      return pending.promise;
    },
    renameProject: async () => {
      throw new Error("unexpected project port");
    },
  };
  const first = renameFlow.commitRename(state, "enter", ports);
  const duplicate = renameFlow.commitRename(state, "blur", ports);
  assert.equal(sessionCalls, 1, "single-flight claim precedes the first await");
  assert.deepEqual(await duplicate, { kind: "ignored", reason: "committing" });
  pending.resolve({ task: task("async", "Canonical async") });
  assert.equal((await first).kind, "succeeded");
  assert.equal(state.taskViews[0].task.title, "Canonical async");
  assert.equal(state.sidebar.renameEditor, null);

  rename.startProjectRename(state, "/workspace/alpha", "Alpha");
  rename.updateRenameDraft(state, "Beta");
  const failed = await renameFlow.commitRename(state, "enter", {
    renameSession: ports.renameSession,
    renameProject: async () => {
      throw new Error("Atomic write failed");
    },
  });
  assert.equal(failed.kind, "failed");
  assert.equal(state.sidebar.renameEditor.status, "error");
  assert.equal(state.sidebar.renameEditor.draft, "Beta");

  const stalePending = deferred();
  const newestPending = deferred();
  let staleCalls = 0;
  rename.cancelRename(state);
  rename.startSessionRename(state, "stale", "sidebar", "Stale");
  rename.updateRenameDraft(state, "Late canonical");
  const stalePorts = {
    renameSession: () => {
      staleCalls += 1;
      return staleCalls === 1 ? stalePending.promise : newestPending.promise;
    },
    renameProject: ports.renameProject,
  };
  const staleFlow = renameFlow.commitRename(state, "enter", {
    ...stalePorts,
  });
  const staleVersion = state.sidebar.renameEditor.requestVersion;
  rename.terminateRenameForMissingEntity(state);
  rename.startSessionRename(state, "stale", "header", "Stale reopened");
  rename.updateRenameDraft(state, "Newest canonical");
  const newestFlow = renameFlow.commitRename(state, "enter", stalePorts);
  const newestVersion = state.sidebar.renameEditor.requestVersion;
  assert.equal(newestVersion > staleVersion, true, "request epoch survives editor reopen");
  stalePending.resolve({ task: task("stale", "Late canonical") });
  assert.equal((await staleFlow).kind, "stale");
  assert.equal(state.sidebar.renameEditor.status, "committing");
  assert.equal(state.sidebar.renameEditor.requestVersion, newestVersion);
  assert.equal(staleCalls, 2);
  newestPending.resolve({ task: task("stale", "Newest canonical") });
  assert.equal((await newestFlow).kind, "succeeded");
  assert.equal(state.sidebar.renameEditor, null);
}

console.log("sidebar-rename-core: 6 lifecycle groups pass");
