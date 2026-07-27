import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Dirent } from "node:fs";
import type {
  PreviewDocument,
  PreviewDocumentKind,
  TaskId,
  WorkspaceDirEntry,
  WorkspaceStatResult,
} from "../shared/types";

/**
 * WorkspaceFiles — the single seam that observes disk truth for a task's
 * workspace (design record §6.1). Every read (`stat` / `readDir` / `readDoc` /
 * `readImage`) and every external-open target resolves through ONE audited
 * path+symlink guard (`resolveInside`), which retired the guard triplicate that
 * once lived in the artifact-preview and workspace-preview readers and main.ts
 * (both readers deleted in S5). The renderer never
 * sniffs bytes: the classification ladder (absent → empty → image → binary →
 * too-large → markdown/html/text) runs HERE and the renderer presents by
 * `kind`.
 *
 * The workspace root for a task is resolved lazily through an injected
 * `resolveRoot` (main wires it to the runtime controller's
 * `sessionWorkingDirectory`, which answers for dormant sessions too — disk
 * truth does not need a live PTY). A null root ⇒ the task is gone; reads
 * surface as `absent`/empty rather than throwing, so the window shows a
 * tombstone or its empty state instead of an error.
 */

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
/** Media the reader never renders — video / audio / HEIC photo. Routed to macOS
 *  Quick Look BY EXTENSION (no content probe): the OS is the right viewer, and
 *  deciding by extension keeps these formats structurally out of the reading
 *  surface (Preview 分工 standing decision, plan v0 §3). */
const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".mov", ".m4v", ".webm",
  ".mp3", ".m4a", ".wav", ".flac", ".aiff",
  ".heic",
]);

/** Text head-slice cutoff: a file larger than this is `too-large` and only its
 *  head is decoded (GitHub's graduated degradation, §4). */
const TEXT_MAX_BYTES = 1024 * 1024;
/** Git's binary heuristic: a NUL byte in the first 8000 bytes. */
const BINARY_PROBE_BYTES = 8000;
/** Chip resolution is batched per turn, but a single chatty reply must not fan
 *  out an unbounded stat storm — the renderer already dedupes; this is the
 *  main-side backstop (§8 S4, "per-call cap ~64 candidates"). */
const RESOLVE_PATHS_CAP = 64;

export type ResolveWorkspaceRoot = (taskId: TaskId) => string | null;

/**
 * Where an openPreview target routes, decided at main's ONE seam BEFORE a
 * Preview tab is opened (design record §6.1; plan v0). `preview` opens (or
 * tombstones) a tab exactly as today; `browser` and `quicklook` hand the file
 * to the OS and open NO tab. This never crosses IPC — it is produced and
 * consumed inside the main process — so it lives here beside the classifier.
 */
export type PreviewRoute =
  | { target: "preview" }
  | { target: "browser"; absolutePath: string }
  | { target: "quicklook"; absolutePath: string };

export class WorkspaceFiles {
  private readonly resolveRoot: ResolveWorkspaceRoot;

  constructor(resolveRoot: ResolveWorkspaceRoot) {
    this.resolveRoot = resolveRoot;
  }

  stat(taskId: TaskId, relativePath: string): WorkspaceStatResult {
    const absolute = this.tryResolve(taskId, relativePath);
    if (!absolute) {
      return { exists: false, isFile: false, isDirectory: false, size: 0 };
    }
    try {
      const stat = fs.statSync(absolute);
      return {
        exists: true,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        size: stat.size,
      };
    } catch {
      return { exists: false, isFile: false, isDirectory: false, size: 0 };
    }
  }

  /**
   * Batch-resolve path-like inline-code mentions (S4 transcript chips) against
   * disk truth: return the workspace-relative paths of the candidates that are
   * real files. A candidate may be workspace-relative or absolute — an absolute
   * inside the root is relativized; anything outside the root, a directory, or
   * nonexistent is omitted (existence is a projection, not an error). Capped at
   * RESOLVE_PATHS_CAP. Every candidate routes through the ONE audited guard
   * (`resolveInside`); a guard violation on a single candidate is an omission,
   * never a throw — resolution is best-effort entry-point discovery, not a
   * security decision the caller can observe.
   */
  resolvePaths(taskId: TaskId, candidates: string[]): string[] {
    const root = this.resolveRoot(taskId);
    if (!root) {
      return [];
    }
    const resolvedRoot = path.resolve(root);
    const existing: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates.slice(0, RESOLVE_PATHS_CAP)) {
      const relative = toWorkspaceRelative(resolvedRoot, candidate);
      if (relative === null || seen.has(relative)) {
        continue;
      }
      seen.add(relative);
      let absolute: string;
      try {
        absolute = this.resolveInside(resolvedRoot, relative);
      } catch {
        continue; // escapes the workspace → omit, never throw across the batch
      }
      try {
        if (fs.statSync(absolute).isFile()) {
          existing.push(relative);
        }
      } catch {
        // nonexistent → omit
      }
    }
    return existing;
  }

  /**
   * One level of a directory, render-ready: dirs-first, case-insensitive
   * natural sort (editor consensus), hidden-flagged (dot-prefixed, shown
   * de-emphasized per R4). No ignore list and no entry cap — R4 shows
   * everything, lazily; symlinks are dropped (they can't be guarded past one
   * hop and the reader never needs them).
   */
  readDir(taskId: TaskId, relativePath = ""): WorkspaceDirEntry[] {
    const root = this.resolveRoot(taskId);
    if (!root) {
      return [];
    }
    const absolute = relativePath ? this.resolveInside(root, relativePath) : path.resolve(root);
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .sort(compareEntries)
      .map((entry) => {
        const childAbsolute = path.join(absolute, entry.name);
        return {
          path: toRelative(root, childAbsolute),
          name: entry.name,
          type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
          hidden: entry.name.startsWith("."),
        };
      });
  }

  /**
   * Read one file as a CLASSIFIED document. Absence is a projection, not an
   * error path (§6.0): a missing/deleted file — or a task whose root no longer
   * resolves — returns `kind: "absent"` so the renderer draws a tombstone.
   * Only a guard violation (a path escaping the workspace) throws.
   */
  readDoc(taskId: TaskId, relativePath: string): PreviewDocument {
    const root = this.resolveRoot(taskId);
    const name = path.basename(relativePath);
    const extension = path.extname(relativePath).replace(".", "").toLowerCase();
    const normalized = normalizeRelative(relativePath);
    const absent = (): PreviewDocument => ({
      path: normalized,
      name,
      extension,
      size: 0,
      kind: "absent",
    });
    if (!root) {
      return absent();
    }

    const absolute = this.resolveInside(root, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return absent();
    }
    if (!stat.isFile()) {
      return absent();
    }

    const base = { path: normalized, name, extension, size: stat.size };
    if (stat.size === 0) {
      return { ...base, kind: "empty" };
    }

    const ext = `.${extension}`;
    if (IMAGE_EXTENSIONS.has(ext)) {
      // Image bytes no longer ride the IPC as a base64 data URL — the renderer
      // points the <img> at `sonata-file://<taskId>/<path>` and this seam streams
      // the file through the protocol handler (S2). That drops the old size cap
      // (a direct image tab is now served from disk, not inlined).
      return { ...base, kind: "image" };
    }

    // Text-ish: probe for binary on the head only (never decode a large blob),
    // then head-slice when too large, else decode and classify by extension.
    const fd = fs.openSync(absolute, "r");
    try {
      const probeLength = Math.min(BINARY_PROBE_BYTES, stat.size);
      const probe = Buffer.alloc(probeLength);
      fs.readSync(fd, probe, 0, probeLength, 0);
      if (probe.includes(0)) {
        return { ...base, kind: "binary" };
      }

      if (stat.size > TEXT_MAX_BYTES) {
        const head = Buffer.alloc(TEXT_MAX_BYTES);
        const read = fs.readSync(fd, head, 0, TEXT_MAX_BYTES, 0);
        return {
          ...base,
          kind: "too-large",
          text: head.subarray(0, read).toString("utf8"),
          truncated: true,
        };
      }

      const text = fs.readFileSync(absolute).toString("utf8");
      return { ...base, kind: textKind(ext), text };
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Normalize an openPreview target to a GUARDED workspace-relative path, or
   * null when it is not routable inside the workspace. A chip already passes a
   * workspace-relative path (a no-op here); a transcript link passes a raw href
   * that may be relative OR absolute — an absolute inside the root is relativized
   * (reusing `toWorkspaceRelative`), and anything that escapes the root (an
   * absolute path outside it, or a `../` climb) returns null: the principled
   * sandbox boundary, a no-op at the seam. Existence is NOT checked — a
   * nonexistent in-workspace path still resolves so the caller opens a tombstone
   * tab (three-truths: the chip/link is a claim, the disk is the truth).
   *
   * A task with no root is the one asymmetry: an absolute path can't be
   * relativized against a missing root (null → no-op), but a relative path
   * passes through so the caller still opens a tombstone — today's behavior for a
   * task whose workspace is gone.
   */
  resolveRelative(taskId: TaskId, rawPath: string): string | null {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      return null;
    }
    const root = this.resolveRoot(taskId);
    if (path.isAbsolute(trimmed)) {
      if (!root) {
        return null; // no root to relativize an absolute path against → no-op
      }
      const resolvedRoot = path.resolve(root);
      const relative = toWorkspaceRelative(resolvedRoot, trimmed);
      if (relative === null) {
        return null; // absolute path outside the workspace → no-op
      }
      try {
        this.resolveInside(resolvedRoot, relative);
      } catch {
        return null; // escapes through a symlink → no-op
      }
      return relative;
    }
    const relative = normalizeRelative(trimmed);
    if (root) {
      try {
        this.resolveInside(path.resolve(root), relative);
      } catch {
        return null; // a `../` climb out of the workspace → no-op
      }
    }
    return relative;
  }

  /**
   * Classify an openPreview target for routing at main's seam (plan v0). A LIGHT
   * classifier — stat + extension sets + a head-only NUL probe; it NEVER reads
   * full contents (that is `readDoc`'s job once a tab is open). Resolution goes
   * through the ONE audited guard. Mirrors `readDoc`'s ladder, collapsed to a
   * routing decision:
   *
   *   - `.html` / `.htm`  → `browser`   (the system default browser; L0)
   *   - media by extension (video/audio/HEIC) OR binary-probe-positive
   *                       → `quicklook` (macOS Quick Look)
   *   - markdown / image / non-binary text (incl. empty & too-large)
   *                       → `preview`   (a Preview tab, as today)
   *
   * Anything that is not an existing file — a gone root, a guard violation, a
   * missing path, or a directory — routes to `preview` so the caller opens
   * today's tombstone tab (three-truths; do not regress it).
   */
  classifyRoute(taskId: TaskId, relativePath: string): PreviewRoute {
    const root = this.resolveRoot(taskId);
    if (!root) {
      return { target: "preview" };
    }
    let absolute: string;
    try {
      absolute = this.resolveInside(root, relativePath);
    } catch {
      return { target: "preview" };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return { target: "preview" }; // nonexistent → tombstone
    }
    if (!stat.isFile()) {
      return { target: "preview" }; // directory / special → tombstone
    }

    const ext = path.extname(absolute).toLowerCase();
    if (HTML_EXTENSIONS.has(ext)) {
      return { target: "browser", absolutePath: absolute };
    }
    if (MEDIA_EXTENSIONS.has(ext)) {
      return { target: "quicklook", absolutePath: absolute };
    }
    if (IMAGE_EXTENSIONS.has(ext) || MARKDOWN_EXTENSIONS.has(ext)) {
      return { target: "preview" };
    }

    // Text-ish: a head-only NUL probe (git's binary heuristic, mirroring
    // readDoc) separates previewable text from a binary blob that belongs in
    // Quick Look. An empty file has no bytes to probe → previewable (readDoc
    // classifies it `empty`).
    const probeLength = Math.min(BINARY_PROBE_BYTES, stat.size);
    if (probeLength === 0) {
      return { target: "preview" };
    }
    const fd = fs.openSync(absolute, "r");
    try {
      const probe = Buffer.alloc(probeLength);
      fs.readSync(fd, probe, 0, probeLength, 0);
      return probe.includes(0)
        ? { target: "quicklook", absolutePath: absolute }
        : { target: "preview" };
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Serve a workspace file as image bytes for the `sonata-file://` protocol (§4,
   * S2). Returns null — the handler answers 404 — for ANYTHING that is not a
   * real, in-workspace image: a guard violation (path escape), a non-image
   * extension, a missing file, or a directory. This is the whole security
   * contract of the protocol: it serves image content-types ONLY, so a script
   * (or any non-image payload) can never ride this channel into the reader.
   * SVG is included deliberately — it is rendered inside an <img>, where its
   * scripts never execute. Resolution goes through the ONE audited guard.
   *
   * The body is a STREAM (`fs.createReadStream` → web ReadableStream), never a
   * whole-file buffer: a large image must not synchronously load into — or be
   * copied within — the main process. This is what actually makes "streamed from
   * disk" true and lets the direct-image tab drop the old size cap safely (the
   * bytes flow to the renderer chunk by chunk; the fd closes on cancel).
   */
  readImage(taskId: TaskId, relativePath: string): { mime: string; body: ReadableStream } | null {
    const root = this.resolveRoot(taskId);
    if (!root) {
      return null;
    }
    let absolute: string;
    try {
      absolute = this.resolveInside(root, relativePath);
    } catch {
      return null; // guard violation → 404, never throw across the protocol
    }
    const ext = path.extname(absolute).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return null;
    }
    try {
      const stat = fs.statSync(absolute); // cheap validation only — no read
      if (!stat.isFile()) {
        return null;
      }
    } catch {
      return null;
    }
    const body = Readable.toWeb(fs.createReadStream(absolute)) as unknown as ReadableStream;
    return { mime: imageMime(ext), body };
  }

  /**
   * Resolve an external-open target (Finder/Cursor) through the same audited
   * guard as reads. A bare `relativePath` targets the workspace root itself.
   * Throws on a guard violation — external-open must never escape the sandbox.
   */
  resolveExternalTarget(taskId: TaskId, relativePath?: string): string {
    const root = this.resolveRoot(taskId);
    if (!root) {
      throw new Error("Workspace is not available for this task.");
    }
    if (!relativePath) {
      return path.resolve(root);
    }
    return this.resolveInside(root, relativePath);
  }

  private tryResolve(taskId: TaskId, relativePath: string): string | null {
    const root = this.resolveRoot(taskId);
    if (!root) {
      return null;
    }
    try {
      return this.resolveInside(root, relativePath);
    } catch {
      return null;
    }
  }

  /**
   * THE security boundary (consolidated from the old triplicate): reject
   * absolute paths, reject a lexical escape from the resolved root, then reject
   * an escape through a symlink (realpath both sides). Returns the absolute
   * path when — and only when — it is genuinely inside the workspace.
   */
  private resolveInside(root: string, relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error("Workspace path must be relative to the workspace.");
    }
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, relativePath);
    const rootWithSep = `${resolvedRoot}${path.sep}`;
    if (target !== resolvedRoot && !target.startsWith(rootWithSep)) {
      throw new Error("Workspace path escapes the workspace.");
    }
    const realRoot = safeRealpath(resolvedRoot);
    const realTarget = safeRealpath(target);
    const realRootWithSep = `${realRoot}${path.sep}`;
    if (realTarget !== realRoot && !realTarget.startsWith(realRootWithSep)) {
      throw new Error("Workspace path escapes the workspace through a symlink.");
    }
    return target;
  }
}

/** Realpath the deepest existing ancestor: a not-yet-created target (e.g. a
 *  tombstoned path being re-checked) still resolves against a real root, so the
 *  symlink guard holds without throwing on ENOENT. */
function safeRealpath(filePath: string): string {
  let current = filePath;
  for (;;) {
    try {
      const real = fs.realpathSync.native
        ? fs.realpathSync.native(current)
        : fs.realpathSync(current);
      if (current === filePath) {
        return real;
      }
      // Re-attach the non-existent tail to the realpath'd ancestor.
      return path.join(real, path.relative(current, filePath));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return filePath;
      }
      current = parent;
    }
  }
}

function toRelative(root: string, absolute: string): string {
  return normalizeRelative(path.relative(path.resolve(root), absolute));
}

/**
 * Map a chip candidate to a workspace-relative path, or null if it can't be
 * one. Absolute candidates are kept only when they land inside the root, and
 * are returned RELATIVE so `resolveInside` (which rejects absolutes) can
 * re-validate them through the audited guard. Separators normalize to "/"; a
 * leading "./" is fine and "../" escapes fall through to `resolveInside`.
 */
function toWorkspaceRelative(resolvedRoot: string, candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  if (path.isAbsolute(trimmed)) {
    const rel = path.relative(resolvedRoot, path.resolve(trimmed));
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      return null; // the root itself (a directory) or outside it
    }
    return normalizeRelative(rel);
  }
  return normalizeRelative(trimmed);
}

function normalizeRelative(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/** Dirs-first, then case-insensitive natural compare (numeric-aware) — the VS
 *  Code / Zed editor consensus, a constant not a setting (§4). */
function compareEntries(a: Dirent, b: Dirent): number {
  if (a.isDirectory() !== b.isDirectory()) {
    return a.isDirectory() ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function textKind(ext: string): PreviewDocumentKind {
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return "markdown";
  }
  if (HTML_EXTENSIONS.has(ext)) {
    return "html";
  }
  return "text";
}

function imageMime(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
