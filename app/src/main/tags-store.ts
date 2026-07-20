import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  assignTagColor,
  normalizeTagsDocument,
  type TagDefinition,
  type TagGroup,
  type TagsDocumentV1,
} from "../shared/types/tags";
import { JsonSettingsStore } from "./settings-store";
import { sonataConfigDir } from "./sonata-paths";

export class TagsStore extends JsonSettingsStore<TagsDocumentV1> {
  constructor(filePath: string) {
    super(filePath, normalizeTagsDocument);
  }

  list(): TagDefinition[] {
    return this.read().tags;
  }

  create(label: string, group: TagGroup): TagDefinition {
    const canonicalLabel = label.trim();
    if (!canonicalLabel) {
      throw new Error("Tag label must not be empty.");
    }
    const data = this.read();
    if (
      data.tags.some(
        (tag) =>
          tag.group === group &&
          tag.label.toLowerCase() === canonicalLabel.toLowerCase(),
      )
    ) {
      throw new Error("A tag with this label already exists in the group.");
    }
    const definition: TagDefinition = {
      id: randomUUID(),
      label: canonicalLabel,
      group,
      color: assignTagColor(data.tags, group),
      createdAt: new Date().toISOString(),
    };
    this.write({ ...data, tags: [...data.tags, definition] });
    return definition;
  }

  delete(id: string): void {
    const data = this.read();
    const definition = data.tags.find((tag) => tag.id === id);
    if (!definition) {
      return;
    }
    if (definition.builtin) {
      throw new Error("Built-in tags cannot be deleted.");
    }
    this.write({ ...data, tags: data.tags.filter((tag) => tag.id !== id) });
  }
}

export function tagsStorePath(): string {
  return path.join(process.env.SONATA_SETTINGS_DIR || sonataConfigDir(), "tags.json");
}
