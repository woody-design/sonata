import fs from "node:fs";
import path from "node:path";
import type { ArtifactCandidate, ArtifactKind } from "../../shared/types/domain";
import type { ArtifactPreviewResponse } from "../../shared/types/ipc";
import type { RuntimeReportV1 } from "../../shared/schemas/runtime-report";

const TEXT_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".csv",
  ".tsv",
  ".svg",
  ".css",
  ".js",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_PREVIEW_BYTES = 1024 * 1024;

export interface ArtifactPreviewOptions {
  taskId: string;
  workspaceRoot: string;
  report: RuntimeReportV1;
}

export class ArtifactPreview {
  private readonly taskId: string;
  private readonly workspaceRoot: string;
  private readonly realWorkspaceRoot: string;
  private readonly report: RuntimeReportV1;

  constructor(options: ArtifactPreviewOptions) {
    this.taskId = options.taskId;
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.realWorkspaceRoot = safeRealpath(this.workspaceRoot);
    this.report = options.report;
  }

  listArtifacts(): ArtifactCandidate[] {
    const artifacts: ArtifactCandidate[] = [];
    for (const run of this.report.runs) {
      for (const artifact of run.artifactCandidates) {
        artifacts.push({
          id: `${run.runId}:${artifact.path}`,
          taskId: this.taskId,
          runId: run.runId,
          path: artifact.path,
          kind: artifactKind(artifact.path),
          changeKind: artifact.changeKind,
          title: path.basename(artifact.path),
          updatedAt: this.report.generatedAt,
        });
      }
    }
    return artifacts;
  }

  readArtifact(relativePath: string): ArtifactPreviewResponse {
    if (!this.isKnownArtifact(relativePath)) {
      throw new Error("Artifact is not present in the current runtime report.");
    }

    const absolutePath = this.resolveInsideWorkspace(relativePath);
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      throw new Error("Artifact path is not a file.");
    }

    const ext = path.extname(relativePath).toLowerCase();
    const base = {
      path: relativePath,
      extension: ext.replace(".", ""),
      size: stat.size,
      truncated: stat.size > MAX_PREVIEW_BYTES,
      rawTerminalPointer: null,
    };

    if (TEXT_EXTENSIONS.has(ext)) {
      const bytes = fs.readFileSync(absolutePath).subarray(0, MAX_PREVIEW_BYTES);
      return {
        ...base,
        previewKind: ext === ".html" || ext === ".htm" ? "html" : "text",
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
      content: "Preview not available for this file type.",
    };
  }

  private isKnownArtifact(relativePath: string): boolean {
    return this.listArtifacts().some((artifact) => artifact.path === relativePath);
  }

  private resolveInsideWorkspace(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error("Artifact path must be relative to the workspace.");
    }

    const absolutePath = path.resolve(this.workspaceRoot, relativePath);
    const rootWithSep = `${this.workspaceRoot}${path.sep}`;
    if (absolutePath !== this.workspaceRoot && !absolutePath.startsWith(rootWithSep)) {
      throw new Error("Artifact path escapes the workspace.");
    }

    const realPath = safeRealpath(absolutePath);
    const realRootWithSep = `${this.realWorkspaceRoot}${path.sep}`;
    if (realPath !== this.realWorkspaceRoot && !realPath.startsWith(realRootWithSep)) {
      throw new Error("Artifact path escapes the workspace through a symlink.");
    }

    return absolutePath;
  }
}

function safeRealpath(filePath: string): string {
  return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
}

function artifactKind(filePath: string): ArtifactKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
    case ".htm":
      return "html";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".pdf":
      return "pdf";
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".webp":
    case ".svg":
      return "image";
    case ".csv":
    case ".tsv":
    case ".xlsx":
      return "spreadsheet";
    case ".docx":
      return "document";
    case ".pptx":
      return "presentation";
    case ".txt":
    case ".json":
    case ".css":
    case ".js":
      return "text";
    default:
      return "unknown";
  }
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
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
