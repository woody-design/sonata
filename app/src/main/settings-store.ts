import fs from "node:fs";
import path from "node:path";
import { sonataConfigDir } from "./sonata-paths";
import {
  type ClaudeSettings,
  normalizeClaudeSettings,
} from "../shared/types/claude-settings";
import {
  type CodexSettings,
  normalizeCodexSettings,
} from "../shared/types/codex-settings";
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
import {
  type TerminalWindowSettings,
  normalizeTerminalWindowSettings,
} from "../shared/types/terminal-window-settings";
import {
  type WindowStateDocument,
  normalizeWindowStateDocument,
} from "../shared/types/window-state";
import {
  type PreviewSessionsDocument,
  normalizePreviewSessionsDocument,
} from "../shared/types/preview-sessions";

/**
 * A settings file backed by JSON: read-with-normalize-fallback and
 * atomic temp-file write. Each concrete store differs only in its type and
 * normalize function, so the invariant lives here (the abstraction was
 * extracted once three instances shared the concept; more have since followed).
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
  return path.join(process.env.SONATA_SETTINGS_DIR || sonataConfigDir(), "reading-settings.json");
}

export class ResumeSettingsStore extends JsonSettingsStore<ResumeSettings> {
  constructor(filePath: string) {
    super(filePath, normalizeResumeSettings);
  }
}

export function resumeSettingsPath(): string {
  return path.join(process.env.SONATA_SETTINGS_DIR || sonataConfigDir(), "resume-settings.json");
}

export class LocalApiSettingsStore extends JsonSettingsStore<LocalApiSettings> {
  constructor(filePath: string) {
    super(filePath, normalizeLocalApiSettings);
  }
}

export function localApiSettingsPath(): string {
  return path.join(process.env.SONATA_SETTINGS_DIR || sonataConfigDir(), "local-api-settings.json");
}

export class ClaudeSettingsStore extends JsonSettingsStore<ClaudeSettings> {
  constructor(filePath: string) {
    super(filePath, normalizeClaudeSettings);
  }
}

export function claudeSettingsPath(): string {
  return path.join(process.env.SONATA_SETTINGS_DIR || sonataConfigDir(), "claude-settings.json");
}

export class CodexSettingsStore extends JsonSettingsStore<CodexSettings> {
  constructor(filePath: string) {
    super(filePath, normalizeCodexSettings);
  }
}

export function codexSettingsPath(): string {
  return path.join(process.env.SONATA_SETTINGS_DIR || sonataConfigDir(), "codex-settings.json");
}

export class WindowStateStore extends JsonSettingsStore<WindowStateDocument> {
  constructor(filePath: string) {
    super(filePath, normalizeWindowStateDocument);
  }
}

export function windowStatePath(): string {
  return path.join(process.env.SONATA_SETTINGS_DIR || sonataConfigDir(), "window-state.json");
}

export class TerminalWindowSettingsStore extends JsonSettingsStore<TerminalWindowSettings> {
  constructor(filePath: string) {
    super(filePath, normalizeTerminalWindowSettings);
  }
}

export function terminalWindowSettingsPath(): string {
  return path.join(
    process.env.SONATA_SETTINGS_DIR || sonataConfigDir(),
    "terminal-window-settings.json",
  );
}

export class PreviewSessionsStore extends JsonSettingsStore<PreviewSessionsDocument> {
  constructor(filePath: string) {
    super(filePath, normalizePreviewSessionsDocument);
  }
}

export function previewSessionsPath(): string {
  return path.join(process.env.SONATA_SETTINGS_DIR || sonataConfigDir(), "preview-sessions.json");
}
