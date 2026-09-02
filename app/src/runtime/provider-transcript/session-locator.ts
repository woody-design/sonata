import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeProvider } from "../../shared/types/domain";
import type { TranscriptSourceRef } from "../../shared/types/transcript";

/**
 * Locates the provider-owned session file backing a Sonata Task.
 *
 * Claude Code writes one JSONL per session under
 *   <projectsDir>/<some directory>/<session-id>.jsonl
 * Codex writes one rollout JSONL per session under
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<local-time>-<id>.jsonl
 *
 * **The Claude directory name is deliberately NOT modelled here** (D2 U2,
 * 2026-09-02). It used to be: `claudeProjectSlug` re-implemented upstream's
 * cwd → directory rule (`cwd.replace(/[^a-zA-Z0-9]/g,"-")`) and a realpath
 * variant chased the macOS `/tmp` → `/private/tmp` split. Upstream then changed
 * the rule, and the new one cannot be re-implemented at all — MEASURED at
 * 2.1.258 (`spikes/upstream-sync-2026-09/claude/p1-project-dir-name.capture.txt`,
 * arms 2a/2b/2c): a slug of 200 characters or fewer is used as-is, and a longer
 * one is truncated to 200 and suffixed with `-<hash>` where the hash is computed
 * INSIDE the binary over the original cwd (`v5abde` for the 300-character arm).
 * A Sonata task in a long working directory therefore looked for its transcript
 * in a directory the CLI never wrote.
 *
 * What replaced the rule is identity. Sonata knows a Claude session's id before
 * the file exists (every fresh spawn pins `--session-id`, every resume knows its
 * `resumeRef`), and the filename IS that id. So the contract this module now
 * depends on is exactly two facts, both stable across the naming change:
 *
 *   1. the file is named `<session-id>.jsonl`;
 *   2. it lives one level below the projects root.
 *
 * The directory in between is whatever upstream wants it to be.
 *
 * **Where this module sits in the whole memory.** It is the SECOND half of a
 * two-part design, and the first half is not here: `transcript-sources.json`
 * already persists every adopted `TranscriptSourceRef` — path included — and
 * `openTask` re-attaches those directly, before discovery ever starts. That file
 * IS the path memory an offline reopen uses; a reopened session opens its
 * transcript without consulting this module at all. (A manifest-level copy of the
 * same path was built during D2 U2 and removed in review: `openTask` puts every
 * re-attached path into `excludePaths`, so the copy was shadowed by the original
 * on every reachable path — see finding F81.)
 *
 * So the locator answers the cases the sources file cannot: a session whose file
 * did not exist when it was last persisted, one whose id the CLI changed under a
 * live PTY, and a first spawn. Two layers, in order: an id-anchored scan (one
 * exact-path `stat` per project directory) and, only for a caller that opts in,
 * the newest-by-mtime fallback below. Cost MEASURED through this module —
 * 0.83 ms hit / 3.46 ms full miss / 10–36 ms for the id-less path over an
 * 859-directory root; the count moves, the shape (linear, one `stat` per
 * directory) does not. Source of truth for every number quoted here:
 * `spikes/upstream-sync-2026-09/claude/p1-scan-cost.capture.txt`, produced by
 * its sibling `.mjs`, which calls this module from `dist/`.
 *
 * Codex is untouched by all of this: its rollout path carries a date tree and its
 * own `session_meta` record names the cwd, so it needs no directory rule.
 */

const LOCATE_SLACK_MS = 20_000;
const HEAD_SCAN_BYTES = 256 * 1024;

export interface LocateSessionOptions {
  provider: RuntimeProvider;
  providerCwd: string;
  notBefore: string;
  excludePaths?: ReadonlySet<string>;
  /**
   * The session id this Task already owns. When set, identity wins over
   * recency: only the file whose id matches exactly may be adopted. This is
   * the anti-rebind anchor — a sibling session in the same cwd (a different
   * conversation the user resumed by hand) can never be mistaken for ours.
   */
  expectedSessionId?: string | null;
  /**
   * When false, never fall back to newest-by-mtime: return null unless the
   * expected session id is found. Resume passes false so a failed/diverged
   * resume cannot silently re-point the Task at whatever file is freshest.
   * Defaults to true (fresh spawns still discover their id by recency).
   */
  allowMtimeFallback?: boolean;
  /**
   * Claude's transcript root. Threaded from the CLI's own
   * `claude auth status --json` → `projectsDirectory` when the readiness probe
   * has read one; {@link claudeProjectsRoot} derives it otherwise.
   */
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
}

function claudeRef(filePath: string): TranscriptSourceRef {
  const id = path.basename(filePath, ".jsonl");
  return {
    sourceId: `claude:${id}`,
    provider: "claude",
    format: "claude-session-jsonl",
    path: filePath,
    providerSessionId: id,
    locatedAt: new Date().toISOString(),
  };
}

export function locateSessionFile(options: LocateSessionOptions): TranscriptSourceRef | null {
  if (options.provider === "claude") {
    return locateClaudeSession(options);
  }
  return locateCodexSession(options);
}

/**
 * Where Claude keeps transcripts, in the order of decreasing authority:
 *
 *   1. what the CLI itself said (`claude auth status --json` →
 *      `projectsDirectory`, threaded in by the caller);
 *   2. `$CLAUDE_CONFIG_DIR/projects` — the CLI's own composition for a user who
 *      redirected their config directory;
 *   3. `~/.claude/projects`.
 *
 * (2) and (3) are a DERIVATION, and deriving is the habit this slice exists to
 * break — so they are the fallback, not the rule. They are also currently
 * correct: at 2.1.258 the binary composes the root as `join(configDir,
 * "projects")` with `configDir = $CLAUDE_CONFIG_DIR ?? ~/.claude` (STATIC, read
 * off the 2.1.258 binary). Taking (1) when it is available means the day that
 * composition changes, Sonata follows for free instead of shipping a fix.
 */
function claudeProjectsRoot(explicit?: string): string {
  if (explicit) {
    return explicit;
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configDir
    ? path.join(configDir, "projects")
    : path.join(os.homedir(), ".claude", "projects");
}

/** The project directories under the root. One `readdir`; no naming assumption
 *  beyond "a project directory is a directory". */
function claudeProjectDirectories(projectsDir: string): string[] {
  try {
    return fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectsDir, entry.name));
  } catch {
    return [];
  }
}

/**
 * The id-anchored scan: `<projectsDir>/<any directory>/<session-id>.jsonl`, by
 * exact-path `stat` per project directory. No recursion, no directory listing per project,
 * no content read, and — the point — no model of how the directory is named.
 *
 * Cost, MEASURED through this function over a real 859-directory projects root
 * by `spikes/upstream-sync-2026-09/claude/p1-scan-cost.mjs` (which imports this
 * module from `dist/`; capture committed alongside it): **0.83 ms when it hits,
 * 3.46 ms for a full miss**, medians of 12 warm runs. It replaces a
 * single-directory read, so this is the price of the decoupling and it is stated
 * rather than assumed — including the fact that the MISS is the common case
 * before a session's first turn, because the transcript is written lazily
 * (findings F74/F76).
 *
 * First hit wins. Two project directories holding the SAME session id would need
 * a file to have been copied by hand — upstream renames move a directory, they
 * do not duplicate ids — and either copy names the same conversation, so paying
 * for a newest-wins tiebreak would buy nothing.
 */
function findClaudeSessionById(
  projectsDir: string,
  sessionId: string,
  excludePaths?: ReadonlySet<string>,
): string | null {
  for (const directory of claudeProjectDirectories(projectsDir)) {
    const candidate = path.join(directory, `${sessionId}.jsonl`);
    if (excludePaths?.has(candidate)) {
      continue;
    }
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Not this project directory.
    }
  }
  return null;
}

function locateClaudeSession(options: LocateSessionOptions): TranscriptSourceRef | null {
  const projectsDir = claudeProjectsRoot(options.claudeProjectsDir);
  const notBeforeMs = Date.parse(options.notBefore) - LOCATE_SLACK_MS;
  const allowFallback = options.allowMtimeFallback ?? true;
  const expectedSessionId = options.expectedSessionId ?? null;

  // Identity over recency. When the Task knows which session it owns, only the
  // file with that exact id may be adopted — a sibling session in the same
  // folder (a different conversation the user resumed by hand) can never be
  // mistaken for ours, because the id is the filename.
  if (expectedSessionId) {
    const found = findClaudeSessionById(projectsDir, expectedSessionId, options.excludePaths);
    if (found) {
      return claudeRef(found);
    }
  }
  // The mtime fallback is authoritative whether or not an id was expected:
  // fallback OFF + no exact id match ⇒ null, wait for the id (or the hook
  // handshake) to land. Checked HERE, not only inside the id branch, so a
  // NULL expected id (a provider that cannot pin one up front — Codex) also
  // honors it instead of silently cross-binding by recency.
  //
  // Every production Claude spawn passes fallback OFF (runtime-controller's
  // `assembleTaskRuntime`, both entry points), so what follows is reachable only
  // from a caller that opts in — which today is the smoke suite.
  if (!allowFallback) {
    return null;
  }

  // The id-less path. With no directory rule to narrow it, this reads every
  // project directory, so it is ordered to do the expensive part last: mtime
  // filter (cheap, and by far the most selective — a not-before window of
  // seconds), then newest-first, then the head read that confirms the cwd,
  // stopping at the FIRST confirmation. Same answer as filtering-then-sorting,
  // one head read instead of one per candidate.
  const match = claudeProjectDirectories(projectsDir)
    .flatMap((directory) => listFiles(directory, ".jsonl"))
    .filter((candidate) => !options.excludePaths?.has(candidate.path))
    .filter((candidate) => candidate.mtimeMs >= notBeforeMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .find((candidate) => claudeSessionMatchesCwd(candidate.path, options.providerCwd));

  return match ? claudeRef(match.path) : null;
}

function locateCodexSession(options: LocateSessionOptions): TranscriptSourceRef | null {
  const sessionsDir = options.codexSessionsDir ?? path.join(os.homedir(), ".codex", "sessions");
  const notBeforeMs = Date.parse(options.notBefore) - LOCATE_SLACK_MS;
  const allowFallback = options.allowMtimeFallback ?? true;

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

  const codexRef = (candidate: { path: string; sessionId: string | null }): TranscriptSourceRef => ({
    sourceId: `codex:${candidate.sessionId ?? path.basename(candidate.path, ".jsonl")}`,
    provider: "codex",
    format: "codex-rollout-jsonl",
    path: candidate.path,
    providerSessionId: candidate.sessionId,
    locatedAt: new Date().toISOString(),
  });

  // Identity over recency (mirrors the Claude path): a known session id may
  // only be matched exactly; resume refuses to fall back to a sibling rollout.
  if (options.expectedSessionId) {
    const exact = candidates.find((candidate) => candidate.sessionId === options.expectedSessionId);
    if (exact) {
      return codexRef(exact);
    }
  }
  // Authoritative regardless of expectedSessionId (see the Claude path): Codex
  // cannot pin an id up front, so it passes a NULL id + fallback OFF and relies
  // wholly on the SessionStart hook handshake. Returning null here (instead of
  // the recency sort below) is what actually closes the same-cwd cross-bind.
  if (!allowFallback) {
    return null;
  }

  const match = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return match ? codexRef(match) : null;
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

/**
 * Does this session file's own head declare our cwd?
 *
 * This used to end with `return !head.includes('"cwd"')` — accept a file that
 * names no cwd at all, "because the directory slug already encodes the cwd".
 * That clause WAS the slug coupling, in its most load-bearing form: it was only
 * ever safe because the caller had already narrowed the search to one directory
 * whose name meant the cwd. The caller now searches every project directory, so
 * the same clause would make any cwd-less session file in any folder a match for
 * any Task — a cross-bind, not a convenience. A file that does not say where it
 * ran no longer qualifies.
 */
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
  return false;
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
