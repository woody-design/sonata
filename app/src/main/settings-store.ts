import fs from "node:fs";
import path from "node:path";
import {
  type ReadingSettings,
  normalizeReadingSettings,
} from "../shared/types/reading-settings";

export class ReadingSettingsStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  read(): ReadingSettings {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      return normalizeReadingSettings(JSON.parse(raw));
    } catch {
      return normalizeReadingSettings(null);
    }
  }

  write(nextSettings: unknown): ReadingSettings {
    const settings = normalizeReadingSettings(nextSettings);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, this.filePath);
    return settings;
  }
}

export function readingSettingsPath(userDataPath: string): string {
  return path.join(process.env.DUET_SETTINGS_DIR || userDataPath, "reading-settings.json");
}
