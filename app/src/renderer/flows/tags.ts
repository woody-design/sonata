// Tag CRUD + optimistic-cache flows (S6 — moved verbatim from main.ts): the
// tag-definition read/create/delete IPC, the sidebar-prefs tag normalization,
// and the local task-tag mirror writes that keep the open views + session
// index in step with a persist before the authoritative refresh lands. Follows
// the session-flows pattern: the state atom and the outward view/port calls
// arrive init-bound from the composition root; the flows import render/dom/
// reading-core and a sibling flow (session-flows' index refresh), never a view
// family, the scheduler, or main.

import type { TagDefinition, TagGroup } from "../../shared/types";
import { withTaskTags } from "../../shared/session-tags";
import {
  findSessionSummary,
  normalizeSidebarTagIds,
} from "../../reading-core/selectors/sidebar";
import * as sidebarTransitions from "../../reading-core/transitions/sidebar";
import { type RendererState } from "../../reading-core/state";
import { refreshSessionIndex } from "./session-flows";

interface TagFlowDeps {
  /** Full sidebar repaint (view/sidebar) — a definition/prefs change reflows
   *  the list. */
  renderSidebar(): void;
  /** Targeted sidebar-menu repaint (view/sidebar) — the open filter / session
   *  tag menu follows a live definition change. */
  renderSidebarMenu(): void;
  /** Persist the sidebar prefs to localStorage (the main.ts port; a tag
   *  normalization can drop stale ids from the saved filter). */
  saveSidebarPrefs(): void;
}

let state: RendererState;
let deps: TagFlowDeps;

/** Bound once by main.ts at boot, before the first render (R4). */
export function initTagFlows(boundState: RendererState, boundDeps: TagFlowDeps): void {
  state = boundState;
  deps = boundDeps;
}

export async function refreshTagDefinitions(): Promise<void> {
  const definitions = await window.sonataRuntime.listTags();
  const definitionsChanged = !tagDefinitionsEqual(state.tagDefinitions, definitions);
  if (definitionsChanged) {
    state.tagDefinitions = definitions;
  }
  const tagsChanged = normalizePersistedSidebarTags(definitions);
  if (tagsChanged || (definitionsChanged && state.sidebar.prefs.tags.length > 0)) {
    deps.renderSidebar();
    return;
  }
  if (
    definitionsChanged &&
    (state.sidebar.menu?.kind === "filter" ||
      (state.sidebar.menu?.kind === "session" && state.sidebar.menu.tagsOpen))
  ) {
    deps.renderSidebarMenu();
  }
}

function normalizePersistedSidebarTags(definitions: readonly TagDefinition[]): boolean {
  const normalized = normalizeSidebarTagIds(state.sidebar.prefs.tags, definitions);
  if (!sidebarTransitions.patchSidebarPrefs(state, { tags: normalized })) {
    return false;
  }
  deps.saveSidebarPrefs();
  return true;
}

function tagDefinitionsEqual(
  left: readonly TagDefinition[],
  right: readonly TagDefinition[],
): boolean {
  return (
    left.length === right.length &&
    left.every((definition, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        definition.id === candidate.id &&
        definition.label === candidate.label &&
        definition.group === candidate.group &&
        definition.color === candidate.color &&
        definition.builtin === candidate.builtin &&
        definition.createdAt === candidate.createdAt
      );
    })
  );
}

export async function createTagDefinition(label: string, group: TagGroup): Promise<TagDefinition> {
  const definition = await window.sonataRuntime.createTag({ label, group });
  state.tagDefinitions = [...state.tagDefinitions, definition];
  return definition;
}

export async function deleteTagDefinition(id: string): Promise<void> {
  await window.sonataRuntime.deleteTag({ id });
  state.tagDefinitions = state.tagDefinitions.filter((definition) => definition.id !== id);
  removeLocalTaskTag(id);
  if (normalizePersistedSidebarTags(state.tagDefinitions)) {
    deps.renderSidebar();
  }
}

export async function persistSessionTags(taskId: string, tagIds: readonly string[]): Promise<void> {
  updateLocalTaskTags(taskId, tagIds);
  try {
    await window.sonataRuntime.setSessionTags({ taskId, tagIds: [...tagIds] });
  } catch (error) {
    await refreshSessionIndex();
    throw error;
  }
}

function updateLocalTaskTags(taskId: string, tagIds: readonly string[]): void {
  for (const view of state.taskViews) {
    if (view.task?.id === taskId) {
      view.task = withTaskTags(view.task, tagIds);
    }
  }
  // The index mirror (m3): a task id is unique across the index, so the one
  // findSessionSummary hit is exactly the session the old chats+projects scan
  // would have found (and mutated in place).
  const found = state.sessionIndex ? findSessionSummary(state.sessionIndex, taskId) : null;
  if (found) {
    found.session.task = withTaskTags(found.session.task, tagIds);
  }
}

function removeLocalTaskTag(id: string): void {
  for (const view of state.taskViews) {
    if (view.task?.tags?.includes(id)) {
      updateLocalTaskTags(view.task.id, view.task.tags.filter((tagId) => tagId !== id));
    }
  }
  if (!state.sessionIndex) {
    return;
  }
  for (const session of [
    ...state.sessionIndex.chats,
    ...state.sessionIndex.projects.flatMap((project) => project.sessions),
  ]) {
    if (session.task.tags?.includes(id)) {
      updateLocalTaskTags(session.task.id, session.task.tags.filter((tagId) => tagId !== id));
    }
  }
}
