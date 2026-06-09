import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeProvider } from "../../shared/types/domain";
import type { TranscriptSourceRef } from "../../shared/types/transcript";

/**
 * Locates the provider-owned session file backing a Duet Task.
 *
 * Claude Code writes one JSONL per session under
 *   ~/.claude/projects/<cwd-slug>/<session-id>.jsonl
 * Codex writes one rollout JSONL per session under
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<local-time>-<id>.jsonl
 *
 * Both are matched by provider cwd plus a not-before timestamp, so a Task
 * only claims sessions started for it.
 */

const LOCATE_SLACK_MS = 20_000;
const HEAD_SCAN_BYTES = 256 * 1024;

export interface LocateSessionOptions {
  provider: RuntimeProvider;
  providerCwd: string;
  notBefore: string;
  excludePaths?: ReadonlySet<string>;
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
}

export function locateSessionFile(options: LocateSessionOptions): TranscriptSourceRef | null {
  if (options.provider === "claude") {
    return locateClaudeSession(options);
  }
  return locateCodexSession(options);
}

export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function claudeCwdVariants(cwd: string): string[] {
  const resolved = path.resolve(cwd);
  const variants = new Set<string>([resolved]);
  try {
    // Claude Code keys its project directories by the realpath of the cwd
    // (macOS: /var/... becomes /private/var/...).
    variants.add(
      fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved),
    );
  } catch {
    // Keep the resolved path only.
  }
  return [...variants];
}

function locateClaudeSession(options: LocateSessionOptions): TranscriptSourceRef | null {
  const projectsDir = options.claudeProjectsDir ?? path.join(os.homedir(), ".claude", "projects");
  const notBeforeMs = Date.parse(options.notBefore) - LOCATE_SLACK_MS;

  const candidates = claudeCwdVariants(options.providerCwd)
    .flatMap((variant) => listFiles(path.join(projectsDir, claudeProjectSlug(variant)), ".jsonl"))
    .filter((candidate) => !options.excludePaths?.has(candidate.path))
    .filter((candidate) => candidate.mtimeMs >= notBeforeMs)
    .filter((candidate) => claudeSessionMatchesCwd(candidate.path, options.providerCwd))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const match = candidates[0];
  if (!match) {
    return null;
  }

  return {
    sourceId: `claude:${path.basename(match.path, ".jsonl")}`,
    provider: "claude",
    format: "claude-session-jsonl",
    path: match.path,
    providerSessionId: path.basename(match.path, ".jsonl"),
    locatedAt: new Date().toISOString(),
  };
}

function locateCodexSession(options: LocateSessionOptions): TranscriptSourceRef | null {
  const sessionsDir = options.codexSessionsDir ?? path.join(os.homedir(), ".codex", "sessions");
  const notBeforeMs = Date.parse(options.notBefore) - LOCATE_SLACK_MS;

  const candidates: Array<{ path: string; mtimeMs: number; sessionId: string | null }> = [];
  for (const dayDir of codexDayDirectories(sessionsDir, notBeforeMs)) {
    for (const candidate of listFiles(dayDir, ".jsonl")) {
      if (options.excludePaths?.has(candidate.path) || candidate.mtimeMs < notBeforeMs) {
        continue;
      }
      const meta = codexSessionMeta(candidate.path);
      if (!meta || !pathsRefereToSameCwd(meta.cwd, options.providerCwd)) {
        continue;
      }
      if (meta.timestampMs !== null && meta.timestampMs < notBeforeMs) {
        continue;
      }
      candidates.push({ ...candidate, sessionId: meta.sessionId });
    }
  }

  const match = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!match) {
    return null;
  }

  return {
    sourceId: `codex:${match.sessionId ?? path.basename(match.path, ".jsonl")}`,
    provider: "codex",
    format: "codex-rollout-jsonl",
    path: match.path,
    providerSessionId: match.sessionId,
    locatedAt: new Date().toISOString(),
  };
}

function codexDayDirectories(sessionsDir: string, notBeforeMs: number): string[] {
  // Rollout paths use local dates; cover the not-before day through today.
  const directories: string[] = [];
  const start = new Date(Math.max(notBeforeMs, Date.now() - 7 * 24 * 60 * 60 * 1000));
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const end = new Date();
  while (cursor.getTime() <= end.getTime()) {
    const year = String(cursor.getFullYear());
    const month = String(cursor.getMonth() + 1).padStart(2, "0");
    const day = String(cursor.getDate()).padStart(2, "0");
    directories.push(path.join(sessionsDir, year, month, day));
    cursor.setDate(cursor.getDate() + 1);
  }
  return directories;
}

function claudeSessionMatchesCwd(filePath: string, providerCwd: string): boolean {
  const head = readHead(filePath);
  if (head === null) {
    return false;
  }
  for (const line of head.split("\n").slice(0, 40)) {
    const record = parseJsonObject(line);
    const cwd = record?.cwd;
    if (typeof cwd === "string" && pathsRefereToSameCwd(cwd, providerCwd)) {
      return true;
    }
  }
  // Session files start with housekeeping records that carry no cwd; the
  // directory slug already encodes the cwd, so accept slug-only matches.
  return !head.includes('"cwd"');
}

function codexSessionMeta(
  filePath: string,
): { cwd: string; sessionId: string | null; timestampMs: number | null } | null {
  const head = readHead(filePath);
  const firstLine = head?.split("\n", 1)[0];
  const record = parseJsonObject(firstLine ?? "");
  if (!record || record.type !== "session_meta") {
    return null;
  }
  const payload = record.payload as Record<string, unknown> | undefined;
  const cwd = payload?.cwd;
  if (typeof cwd !== "string") {
    return null;
  }
  const timestamp = typeof payload?.timestamp === "string" ? Date.parse(payload.timestamp) : NaN;
  return {
    cwd,
    sessionId: typeof payload?.id === "string" ? payload.id : null,
    timestampMs: Number.isNaN(timestamp) ? null : timestamp,
  };
}

function pathsRefereToSameCwd(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    // macOS reports /var/... and /private/var/... for the same location.
    return resolved.startsWith("/private/") ? resolved.slice("/private".length) : resolved;
  };
  return normalize(left) === normalize(right);
}

function listFiles(directory: string, extension: string): Array<{ path: string; mtimeMs: number }> {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return [];
  }

  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(extension)) {
      continue;
    }
    const filePath = path.join(directory, entry);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        files.push({ path: filePath, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // Skip files that disappear while scanning.
    }
  }
  return files;
}

function readHead(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(HEAD_SCAN_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
