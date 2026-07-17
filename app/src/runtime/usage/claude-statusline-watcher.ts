import fs from "node:fs";
import path from "node:path";
import { claudeUsageDirectory } from "./claude-statusline";

const DEFAULT_POLL_MS = 600;

export interface ClaudeStatuslineUsageWatcherOptions {
  pollMs?: number;
  onPayload: (payload: unknown, filePath: string, mtimeMs: number) => void;
  onError?: (error: Error, filePath?: string) => void;
}

interface FileState {
  size: number;
  mtimeMs: number;
}

/**
 * Polls Sonata-owned Claude statusline sink files. Polling mirrors JsonlTailer:
 * cheap, predictable, and insensitive to tmp+rename behavior.
 */
export class ClaudeStatuslineUsageWatcher {
  private readonly options: ClaudeStatuslineUsageWatcherOptions;
  private readonly pollMs: number;
  private readonly workspaceRefs = new Map<string, number>();
  private readonly fileStates = new Map<string, FileState>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ClaudeStatuslineUsageWatcherOptions) {
    this.options = options;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  watchWorkspace(cwd: string): void {
    const workspace = path.resolve(cwd);
    this.workspaceRefs.set(workspace, (this.workspaceRefs.get(workspace) ?? 0) + 1);
    this.pollWorkspace(workspace);
    this.ensureTimer();
  }

  unwatchWorkspace(cwd: string): void {
    const workspace = path.resolve(cwd);
    const count = this.workspaceRefs.get(workspace) ?? 0;
    if (count <= 1) {
      this.workspaceRefs.delete(workspace);
      this.pruneFileStates(workspace);
    } else {
      this.workspaceRefs.set(workspace, count - 1);
    }
    if (this.workspaceRefs.size === 0) {
      this.stop();
    }
  }

  dispose(): void {
    this.stop();
    this.workspaceRefs.clear();
    this.fileStates.clear();
  }

  private ensureTimer(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private poll(): void {
    for (const workspace of this.workspaceRefs.keys()) {
      this.pollWorkspace(workspace);
    }
  }

  private pollWorkspace(workspace: string): void {
    const usageDirectory = claudeUsageDirectory(workspace);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(usageDirectory);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!/^claude-.+\.json$/.test(entry)) {
        continue;
      }
      const filePath = path.join(usageDirectory, entry);
      this.pollFile(filePath);
    }
  }

  private pollFile(filePath: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      this.options.onError?.(toError(error), filePath);
      return;
    }
    if (!stat.isFile()) {
      return;
    }

    const previous = this.fileStates.get(filePath);
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
      return;
    }

    this.fileStates.set(filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });

    try {
      this.options.onPayload(
        JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown,
        filePath,
        stat.mtimeMs,
      );
    } catch (error) {
      this.options.onError?.(toError(error), filePath);
    }
  }

  private pruneFileStates(workspace: string): void {
    const usageDirectory = `${claudeUsageDirectory(workspace)}${path.sep}`;
    for (const filePath of this.fileStates.keys()) {
      if (filePath.startsWith(usageDirectory)) {
        this.fileStates.delete(filePath);
      }
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
