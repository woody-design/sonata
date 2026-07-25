import fs from "node:fs";
import path from "node:path";
import {
  ANSWERED_PREFIX,
  APPROVAL_WATCHER_POLL_MS,
  ASK_PREFIX,
  EXPIRED_PREFIX,
  REPLY_PREFIX,
  approvalsDirectory,
} from "./approval-protocol";
import type { HookPayload } from "../../shared/types/cli-signal";

const DEFAULT_POLL_MS = APPROVAL_WATCHER_POLL_MS;

// Match the broker's control files by the SHARED prefixes (single-sourced with
// the producers via approval-protocol — a prefix rename can never desync).
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ASK_FILE_RE = new RegExp(`^${esc(ASK_PREFIX)}.+\\.json$`);
const EXPIRED_FILE_RE = new RegExp(`^${esc(EXPIRED_PREFIX)}.+\\.json$`);
const PROTOCOL_FILE_RE = new RegExp(
  `^(?:${[ASK_PREFIX, REPLY_PREFIX, EXPIRED_PREFIX, ANSWERED_PREFIX].map(esc).join("|")}).+\\.json(?:\\.\\d+\\.tmp)?$`,
);

export interface ApprovalAsk {
  id: string;
  receivedAt: string;
  payload: HookPayload;
}

export interface ApprovalWatcherOptions {
  pollMs?: number;
  /** A broker surfaced a permission request (once per id). Route by runtime dir → task. */
  onAsk: (ask: ApprovalAsk, runtimeDir: string) => void;
  /** A broker gave up (timeout) → the CLI's native panel is taking over. Clear the card. */
  onExpired: (id: string, runtimeDir: string) => void;
  onError?: (error: Error, filePath?: string) => void;
}

/**
 * Polls Sonata-owned approval control dirs (`<runtimeDir>/approvals`) for the
 * broker's `ask-<id>.json` (surface a card, once per id) and `expired-<id>.json`
 * (the broker gave up → native panel). Sonata answers by writing `reply-<id>.json`
 * (see `writeApprovalReply`), which the broker consumes and deletes along with
 * the ask; a vanished ask therefore needs no watcher action. Mirrors
 * HookWatcher's per-workspace refcount + crash-residue prune.
 *
 * Provider-NEUTRAL: both Claude and Codex brokers write the identical
 * ask/reply/expired protocol into the SAME `<runtimeDir>/approvals` layout, so
 * one watcher serves both. The dir + file prefixes come from the neutral
 * `approval-protocol` module (no provider module owns the layout); the only
 * per-provider difference is the reply JSON shape, chosen by the caller at
 * reply-write time.
 */
export class ApprovalWatcher {
  private readonly options: ApprovalWatcherOptions;
  private readonly pollMs: number;
  private readonly workspaceRefs = new Map<string, number>();
  private readonly seenAsks = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ApprovalWatcherOptions) {
    this.options = options;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  watchWorkspace(runtimeDir: string): void {
    const workspace = path.resolve(runtimeDir);
    const firstRef = !this.workspaceRefs.has(workspace);
    this.workspaceRefs.set(workspace, (this.workspaceRefs.get(workspace) ?? 0) + 1);
    if (firstRef) {
      // Crash residue: a prior session that died mid-approval may have left
      // ask/reply/expired files. They belong to a dead broker — prune, don't
      // replay them as a fresh approval.
      this.pruneWorkspace(workspace);
    }
    this.ensureTimer();
  }

  unwatchWorkspace(runtimeDir: string): void {
    const workspace = path.resolve(runtimeDir);
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
    this.seenAsks.clear();
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
    const dir = approvalsDirectory(workspace);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ASK_FILE_RE.test(entry)) {
        this.consumeAsk(dir, entry, workspace);
      } else if (EXPIRED_FILE_RE.test(entry)) {
        this.consumeExpired(dir, entry, workspace);
      }
    }
  }

  private consumeAsk(dir: string, entry: string, workspace: string): void {
    const id = entry.slice(ASK_PREFIX.length, -".json".length);
    if (this.seenAsks.has(id)) {
      return; // surface each ask exactly once; the broker owns the file's lifecycle
    }
    let ask: ApprovalAsk;
    try {
      ask = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as ApprovalAsk;
    } catch (error) {
      // A partial write (mid tmp+rename is rare, but a truncated read is not) —
      // leave it; next poll re-reads once complete. Do NOT mark seen.
      this.options.onError?.(toError(error), path.join(dir, entry));
      return;
    }
    this.seenAsks.add(id);
    this.options.onAsk({ ...ask, id }, workspace);
  }

  private consumeExpired(dir: string, entry: string, workspace: string): void {
    const id = entry.slice(EXPIRED_PREFIX.length, -".json".length);
    try {
      fs.rmSync(path.join(dir, entry), { force: true });
    } catch {
      // best-effort
    }
    this.seenAsks.delete(id);
    this.options.onExpired(id, workspace);
  }

  private pruneWorkspace(workspace: string): void {
    const dir = approvalsDirectory(workspace);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (PROTOCOL_FILE_RE.test(entry)) {
        try {
          fs.rmSync(path.join(dir, entry), { force: true });
        } catch {
          // best-effort
        }
      }
    }
  }
}

/**
 * Sonata's answer to a held approval: write `reply-<id>.json` (the decision JSON
 * the broker emits verbatim to the CLI) via tmp+rename so the broker only reads
 * a complete file.
 */
export function writeApprovalReply(runtimeDir: string, id: string, decision: unknown): void {
  const dir = approvalsDirectory(runtimeDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${REPLY_PREFIX}${id}.json`);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(decision), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
