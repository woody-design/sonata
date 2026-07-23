import type { Task } from "./types/domain";
import type { TagDefinition } from "./types/tags";

export function canonicalTagIds(tagIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const canonical: string[] = [];
  for (const value of tagIds) {
    const id = value.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      canonical.push(id);
    }
  }
  return canonical;
}

/** Renderer-facing selection semantics: Status/Priority replace within their
 * group, Type accumulates, and selecting an applied option toggles it off. */
export function replaceTagSelection(
  currentTagIds: readonly string[],
  selectedTagId: string,
  definitions: readonly TagDefinition[],
): string[] {
  const current = canonicalTagIds(currentTagIds);
  if (current.includes(selectedTagId)) {
    return current.filter((id) => id !== selectedTagId);
  }

  const selected = definitions.find((definition) => definition.id === selectedTagId);
  if (!selected) {
    return current;
  }
  if (selected.group === "type") {
    return [...current, selected.id];
  }

  const groups = new Map(definitions.map((definition) => [definition.id, definition.group]));
  return [
    ...current.filter((id) => groups.get(id) !== selected.group),
    selected.id,
  ];
}

/** Drop tag ids that are not in the live vocabulary before they are written into
 *  a task manifest. A stale renderer can send a just-deleted tag id: the
 *  delete-time manifest scrub (planTagRemovalFromManifests) has already run, so
 *  persisting that id would strand a permanent orphan no later scrub reaches.
 *  Tolerate-orphans posture, matching the selectors (replaceTagSelection ignores
 *  an unknown id rather than throwing) — a stale renderer is not an error. */
export function retainKnownTagIds(
  tagIds: readonly string[],
  definitions: readonly TagDefinition[],
): string[] {
  const known = new Set(definitions.map((definition) => definition.id));
  return canonicalTagIds(tagIds).filter((id) => known.has(id));
}

export function withTaskTags(task: Task, tagIds: readonly string[]): Task {
  const tags = canonicalTagIds(tagIds);
  if (tags.length === 0) {
    const next = { ...task };
    delete next.tags;
    return next;
  }
  return { ...task, tags };
}

export function withoutTaskTag(task: Task, tagId: string): Task {
  if (!task.tags?.includes(tagId)) {
    return task;
  }
  return withTaskTags(task, task.tags.filter((id) => id !== tagId));
}
