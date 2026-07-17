import fs from "node:fs";
import path from "node:path";
import type { HookPayload } from "../../shared/types/cli-signal";

const DEFAULT_POLL_MS = 250;

export interface HookWatcherOptions {
  pollMs?: number;
  /** Resolves the sink dir to poll for a watched workspace. Injected rather than
   *  imported so the watcher stays provider-neutral — the caller passes the
   *  provider's edge (e.g. Claude's `claudeHooksDirectory`). */
  sinkDir: (workspace: string) => string;
  /** Called once per hook payload, in filename (≈ emission) order, with the
   *  RUNTIME DIR it was observed under (~/.sonata/data/runtime/<taskId> since D8;
   *  route by runtime dir → task — NOT the agent cwd). */
  onPayload: (payload: HookPayload, runtimeDir: string) => void;
  onError?: (error: Error, filePath?: string) => void;
}

/**
 * Polls Sonata-owned hook sink dirs (`.sonata/hooks/`), mirroring the statusline
 * watcher's per-workspace poll. Each `hook-*.json` is a single hook payload
 * written via tmp+rename; the watcher reads it in name order, hands it off, then
 * DELETES it (the dir is a queue, not a log — bounded growth). Provider-neutral:
 * the sink-dir resolver is injected via options.
 */
export class HookWatcher {
  private readonly options: HookWatcherOptions;
  private readonly pollMs: number;
  private readonly workspaceRefs = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: HookWatcherOptions) {
    this.options = options;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  watchWorkspace(cwd: string): void {
    const workspace = path.resolve(cwd);
    const firstRef = !this.workspaceRefs.has(workspace);
    this.workspaceRefs.set(workspace, (this.workspaceRefs.get(workspace) ?? 0) + 1);
    if (firstRef) {
      // Crash-residue guard: a prior session that died without dispose/prune may
      // have left hook files here. Hooks fire only AFTER a turn starts (well
      // after watch begins), so anything present at first-watch is stale — prune
      // it rather than replay it as fresh state. The 250ms timer then picks up
      // this session's real files.
      this.pruneWorkspace(workspace);
    }
    this.ensureTimer();
  }

  unwatchWorkspace(cwd: string): void {
    const workspace = path.resolve(cwd);
    const count = this.workspaceRefs.get(workspace) ?? 0;
    if (count <= 1) {
      this.workspaceRefs.delete(workspace);
      this.pruneWorkspace(workspace);
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
    const dir = this.options.sinkDir(workspace);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    // Filename prefix is Date.now()-hrtime-pid → lexical sort ≈ emission order.
    const files = entries.filter((e) => /^hook-.+\.json$/.test(e)).sort();
    for (const entry of files) {
      this.consumeFile(path.join(dir, entry), workspace);
    }
  }

  private consumeFile(filePath: string, workspace: string): void {
    let contents: string;
    try {
      contents = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      this.options.onError?.(toError(error), filePath);
      return;
    }
    // Delete first: a malformed file must not be re-read every poll.
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // best-effort
    }
    let payload: HookPayload;
    try {
      payload = JSON.parse(contents) as HookPayload;
    } catch (error) {
      this.options.onError?.(toError(error), filePath);
      return;
    }
    this.options.onPayload(payload, workspace);
  }

  private pruneWorkspace(workspace: string): void {
    const dir = this.options.sinkDir(workspace);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (/^hook-.+\.json(\.tmp)?$/.test(entry)) {
        try {
          fs.rmSync(path.join(dir, entry), { force: true });
        } catch {
          // best-effort
        }
      }
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
