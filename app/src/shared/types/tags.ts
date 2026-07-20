export const TAG_GROUPS = ["status", "type", "priority"] as const;
export type TagGroup = (typeof TAG_GROUPS)[number];

export const TAG_COLORS = [
  "gray",
  "steel",
  "sky",
  "blue",
  "cyan",
  "teal",
  "green",
  "olive",
  "yellow",
  "amber",
  "orange",
  "red",
  "brown",
  "purple",
  "pink",
  "magenta",
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export interface TagDefinition {
  id: string;
  label: string;
  group: TagGroup;
  color: TagColor;
  builtin?: boolean;
  createdAt: string;
}

export interface TagsDocumentV1 {
  version: 1;
  tags: TagDefinition[];
}

const BUILTIN_CREATED_AT = "2026-07-20T00:00:00.000Z";

export const BUILTIN_TAGS: readonly TagDefinition[] = [
  builtin("status.backlog", "Backlog", "status", "steel"),
  builtin("status.todo", "Todo", "status", "sky"),
  builtin("status.needs-review", "Needs Review", "status", "blue"),
  builtin("status.done", "Done", "status", "green"),
  builtin("status.cancelled", "Cancelled", "status", "gray"),
  builtin("type.research", "Research", "type", "purple"),
  builtin("type.design", "Design", "type", "pink"),
  builtin("type.coding", "Coding", "type", "cyan"),
  builtin("type.bug", "Bug", "type", "brown"),
  builtin("type.automation", "Automation", "type", "teal"),
  builtin("type.writing", "Writing", "type", "olive"),
  builtin("type.marketing", "Marketing", "type", "magenta"),
  builtin("priority.p0", "P0", "priority", "red"),
  builtin("priority.p1", "P1", "priority", "orange"),
  builtin("priority.p2", "P2", "priority", "amber"),
  builtin("priority.p3", "P3", "priority", "yellow"),
];

const GROUP_COLOR_PREFIXES: Record<TagGroup, readonly TagColor[]> = {
  status: ["steel", "sky", "blue", "cyan", "teal", "gray"],
  priority: ["yellow", "amber", "orange", "red"],
  type: ["purple", "pink", "magenta", "cyan", "teal", "brown", "olive", "green"],
};

export const TAG_COLOR_CANDIDATES: Record<TagGroup, readonly TagColor[]> = {
  status: completeColorPool(GROUP_COLOR_PREFIXES.status),
  priority: completeColorPool(GROUP_COLOR_PREFIXES.priority),
  type: completeColorPool(GROUP_COLOR_PREFIXES.type),
};

export function defaultTagsDocument(): TagsDocumentV1 {
  return { version: 1, tags: BUILTIN_TAGS.map((tag) => ({ ...tag })) };
}

export function normalizeTagsDocument(value: unknown): TagsDocumentV1 {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tags)) {
    return defaultTagsDocument();
  }

  const tags: TagDefinition[] = [];
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const candidate of value.tags) {
    const normalized = normalizeTagDefinition(candidate);
    if (!normalized) {
      return defaultTagsDocument();
    }
    const labelKey = `${normalized.group}:${normalized.label.toLowerCase()}`;
    if (ids.has(normalized.id) || labels.has(labelKey)) {
      return defaultTagsDocument();
    }
    ids.add(normalized.id);
    labels.add(labelKey);
    tags.push(normalized);
  }
  return { version: 1, tags };
}

export function assignTagColor(definitions: readonly TagDefinition[], group: TagGroup): TagColor {
  const candidates = TAG_COLOR_CANDIDATES[group];
  const counts = new Map<TagColor, number>(candidates.map((color) => [color, 0]));
  for (const definition of definitions) {
    if (definition.group === group) {
      counts.set(definition.color, (counts.get(definition.color) ?? 0) + 1);
    }
  }
  return candidates.reduce((leastUsed, color) =>
    (counts.get(color) ?? 0) < (counts.get(leastUsed) ?? 0) ? color : leastUsed,
  );
}

function builtin(
  id: string,
  label: string,
  group: TagGroup,
  color: TagColor,
): TagDefinition {
  return { id, label, group, color, builtin: true, createdAt: BUILTIN_CREATED_AT };
}

function completeColorPool(prefix: readonly TagColor[]): readonly TagColor[] {
  const used = new Set(prefix);
  return [...prefix, ...TAG_COLORS.filter((color) => !used.has(color))];
}

function normalizeTagDefinition(value: unknown): TagDefinition | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const label = typeof value.label === "string" ? value.label.trim() : "";
  if (
    !id ||
    !label ||
    !isTagGroup(value.group) ||
    !isTagColor(value.color) ||
    typeof value.createdAt !== "string" ||
    !value.createdAt
  ) {
    return null;
  }
  if (value.builtin !== undefined && typeof value.builtin !== "boolean") {
    return null;
  }
  return {
    id,
    label,
    group: value.group,
    color: value.color,
    ...(value.builtin === undefined ? {} : { builtin: value.builtin }),
    createdAt: value.createdAt,
  };
}

function isTagGroup(value: unknown): value is TagGroup {
  return (TAG_GROUPS as readonly unknown[]).includes(value);
}

function isTagColor(value: unknown): value is TagColor {
  return (TAG_COLORS as readonly unknown[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
