import fs from "node:fs";
import path from "node:path";
import type { Dirent } from "node:fs";
import type {
  PreviewKind,
  WorkspaceFilePreviewResponse,
  WorkspaceTreeEntry,
} from "../../shared/types/ipc";

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".csv",
  ".htm",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".markdown",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const IGNORED_NAMES = new Set([
  ".DS_Store",
  ".duet",
  ".git",
  "build",
  "dist",
  "node_modules",
]);

const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_TREE_DEPTH = 5;
const MAX_TREE_ENTRIES = 800;

export interface WorkspacePreviewOptions {
  workspaceRoot: string;
}

export class WorkspacePreview {
  private readonly workspaceRoot: string;
  private readonly realWorkspaceRoot: string;
  private emittedEntries = 0;

  constructor(options: WorkspacePreviewOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.realWorkspaceRoot = safeRealpath(this.workspaceRoot);
  }

  readTree(): WorkspaceTreeEntry[] {
    this.emittedEntries = 0;
    return this.readDirectory(this.workspaceRoot, 0);
  }

  readFile(relativePath: string): WorkspaceFilePreviewResponse {
    const absolutePath = this.resolveInsideWorkspace(relativePath);
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      throw new Error("Workspace path is not a file.");
    }

    const ext = path.extname(relativePath).toLowerCase();
    const base = {
      path: normalizeRelativePath(relativePath),
      extension: ext.replace(".", ""),
      size: stat.size,
      truncated: stat.size > MAX_PREVIEW_BYTES,
    };

    if (TEXT_EXTENSIONS.has(ext)) {
      const bytes = fs.readFileSync(absolutePath).subarray(0, MAX_PREVIEW_BYTES);
      return {
        ...base,
        previewKind: previewKindForTextExtension(ext),
        content: bytes.toString("utf8"),
      };
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      const bytes = fs.readFileSync(absolutePath).subarray(0, MAX_PREVIEW_BYTES);
      return {
        ...base,
        previewKind: "image",
        dataUrl: `data:${mimeForExt(ext)};base64,${bytes.toString("base64")}`,
      };
    }

    return {
      ...base,
      previewKind: "metadata",
      content: "Read-only preview is not available for this file type.",
    };
  }

  private readDirectory(directoryPath: string, depth: number): WorkspaceTreeEntry[] {
    if (depth >= MAX_TREE_DEPTH || this.emittedEntries >= MAX_TREE_ENTRIES) {
      return [];
    }

    const entries = fs
      .readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => !IGNORED_NAMES.has(entry.name))
      .filter((entry) => !entry.isSymbolicLink())
      .sort(compareDirents);

    const tree: WorkspaceTreeEntry[] = [];
    for (const entry of entries) {
      if (this.emittedEntries >= MAX_TREE_ENTRIES) {
        break;
      }

      const absolutePath = path.join(directoryPath, entry.name);
      if (!this.isInsideRealWorkspace(absolutePath)) {
        continue;
      }

      const relativePath = normalizeRelativePath(path.relative(this.workspaceRoot, absolutePath));
      const type = entry.isDirectory() ? "directory" : "file";
      this.emittedEntries += 1;

      const node: WorkspaceTreeEntry = {
        path: relativePath,
        name: entry.name,
        type,
        depth,
      };

      if (entry.isDirectory()) {
        node.children = this.readDirectory(absolutePath, depth + 1);
      }

      tree.push(node);
    }
    return tree;
  }

  private resolveInsideWorkspace(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error("Workspace path must be relative to the workspace.");
    }

    const absolutePath = path.resolve(this.workspaceRoot, relativePath);
    const rootWithSep = `${this.workspaceRoot}${path.sep}`;
    if (absolutePath !== this.workspaceRoot && !absolutePath.startsWith(rootWithSep)) {
      throw new Error("Workspace path escapes the workspace.");
    }

    if (!this.isInsideRealWorkspace(absolutePath)) {
      throw new Error("Workspace path escapes the workspace through a symlink.");
    }

    return absolutePath;
  }

  private isInsideRealWorkspace(absolutePath: string): boolean {
    const realPath = safeRealpath(absolutePath);
    const realRootWithSep = `${this.realWorkspaceRoot}${path.sep}`;
    return realPath === this.realWorkspaceRoot || realPath.startsWith(realRootWithSep);
  }
}

function safeRealpath(filePath: string): string {
  return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function compareDirents(a: Dirent, b: Dirent): number {
  if (a.isDirectory() !== b.isDirectory()) {
    return a.isDirectory() ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

function previewKindForTextExtension(ext: string): PreviewKind {
  return ext === ".html" || ext === ".htm" ? "html" : "text";
}

function mimeForExt(ext: string): string {
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
    default:
      return "application/octet-stream";
  }
}
