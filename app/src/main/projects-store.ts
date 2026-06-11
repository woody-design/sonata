import fs from "node:fs";
import path from "node:path";

/**
 * Thin overlay for project (working folder) metadata that cannot be derived
 * from session manifests: display-name overrides, archived flags, and the
 * last-used folder that New Chat preselects. Deleting this file loses only
 * cosmetic metadata — the project list itself always rebuilds from the
 * session manifests.
 */

export interface ProjectOverlayEntry {
  displayName?: string;
  archived?: boolean;
  lastUsedAt?: string;
}

export interface ProjectsFileV1 {
  version: 1;
  lastUsedFolder: string | null;
  folders: Record<string, ProjectOverlayEntry>;
}

const EMPTY: ProjectsFileV1 = { version: 1, lastUsedFolder: null, folders: {} };

export class ProjectsStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  read(): ProjectsFileV1 {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as ProjectsFileV1;
      if (raw.version !== 1 || typeof raw.folders !== "object" || raw.folders === null) {
        return { ...EMPTY };
      }
      return {
        version: 1,
        lastUsedFolder: typeof raw.lastUsedFolder === "string" ? raw.lastUsedFolder : null,
        folders: raw.folders,
      };
    } catch {
      return { ...EMPTY };
    }
  }

  noteFolderUsed(folderPath: string): void {
    const data = this.read();
    data.lastUsedFolder = folderPath;
    data.folders[folderPath] = {
      ...data.folders[folderPath],
      lastUsedAt: new Date().toISOString(),
    };
    this.write(data);
  }

  setDisplayName(folderPath: string, displayName: string | null): void {
    const data = this.read();
    const entry = { ...data.folders[folderPath] };
    if (displayName && displayName.trim()) {
      entry.displayName = displayName.trim();
    } else {
      delete entry.displayName;
    }
    data.folders[folderPath] = entry;
    this.write(data);
  }

  setArchived(folderPath: string, archived: boolean): void {
    const data = this.read();
    data.folders[folderPath] = { ...data.folders[folderPath], archived };
    if (archived && data.lastUsedFolder === folderPath) {
      data.lastUsedFolder = null;
    }
    this.write(data);
  }

  private write(data: ProjectsFileV1): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, this.filePath);
  }
}

export function projectsStorePath(userDataPath: string): string {
  return path.join(process.env.DUET_SETTINGS_DIR || userDataPath, "projects.json");
}
