import fs from "node:fs";
import path from "node:path";
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
 * workspace (design record §6.1). Every read (`stat` / `readDir` / `readDoc`)
 * and every external-open target resolves through ONE audited path+symlink
 * guard (`resolveInside`), retiring the triplicate that lived in
 * artifact-preview.ts, workspace-preview.ts and main.ts. The renderer never
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

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

/** Text head-slice cutoff: a file larger than this is `too-large` and only its
 *  head is decoded (GitHub's graduated degradation, §4). */
const TEXT_MAX_BYTES = 1024 * 1024;
/** Above this an image is `too-large` rather than inlined as a data URL (S1;
 *  duet-file:// streaming lands in S2). */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Git's binary heuristic: a NUL byte in the first 8000 bytes. */
const BINARY_PROBE_BYTES = 8000;

export type ResolveWorkspaceRoot = (taskId: TaskId) => string | null;

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
      if (stat.size > IMAGE_MAX_BYTES) {
        return { ...base, kind: "too-large" };
      }
      const bytes = fs.readFileSync(absolute);
      return {
        ...base,
        kind: "image",
        dataUrl: `data:${imageMime(ext)};base64,${bytes.toString("base64")}`,
      };
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
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
