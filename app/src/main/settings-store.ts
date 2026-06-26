import fs from "node:fs";
import path from "node:path";
import { duetConfigDir } from "./duet-paths";
import {
  type ClaudeSettings,
  normalizeClaudeSettings,
} from "../shared/types/claude-settings";
import {
  type LocalApiSettings,
  normalizeLocalApiSettings,
} from "../shared/types/local-api";
import {
  type ReadingSettings,
  normalizeReadingSettings,
} from "../shared/types/reading-settings";
import {
  type ResumeSettings,
  normalizeResumeSettings,
} from "../shared/types/resume-settings";

/**
 * A settings file backed by JSON: read-with-normalize-fallback and
 * atomic temp-file write. The three concrete stores differ only in
 * their type and normalize function, so the invariant lives here
 * (project heuristic: three instances with a shared concept → extract).
 */
export class JsonSettingsStore<T> {
  readonly filePath: string;
  private readonly normalize: (value: unknown) => T;

  constructor(filePath: string, normalize: (value: unknown) => T) {
    this.filePath = filePath;
    this.normalize = normalize;
  }

  read(): T {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      return this.normalize(JSON.parse(raw));
    } catch {
      return this.normalize(null);
    }
  }

  write(nextSettings: unknown): T {
    const settings = this.normalize(nextSettings);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, this.filePath);
    return settings;
  }
}

export class ReadingSettingsStore extends JsonSettingsStore<ReadingSettings> {
  constructor(filePath: string) {
    super(filePath, normalizeReadingSettings);
  }
}

export function readingSettingsPath(): string {
  return path.join(process.env.DUET_SETTINGS_DIR || duetConfigDir(), "reading-settings.json");
}

export class ResumeSettingsStore extends JsonSettingsStore<ResumeSettings> {
  constructor(filePath: string) {
    super(filePath, normalizeResumeSettings);
  }
}

export function resumeSettingsPath(): string {
  return path.join(process.env.DUET_SETTINGS_DIR || duetConfigDir(), "resume-settings.json");
}

export class LocalApiSettingsStore extends JsonSettingsStore<LocalApiSettings> {
  constructor(filePath: string) {
    super(filePath, normalizeLocalApiSettings);
  }
}

export function localApiSettingsPath(): string {
  return path.join(process.env.DUET_SETTINGS_DIR || duetConfigDir(), "local-api-settings.json");
}

export class ClaudeSettingsStore extends JsonSettingsStore<ClaudeSettings> {
  constructor(filePath: string) {
    super(filePath, normalizeClaudeSettings);
  }
}

export function claudeSettingsPath(): string {
  return path.join(process.env.DUET_SETTINGS_DIR || duetConfigDir(), "claude-settings.json");
}
