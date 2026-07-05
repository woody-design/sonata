import type { PreviewBinding, PreviewDocument, PreviewSession } from "../../shared/types";

// The path→type-icon mapping lives in view/icons.ts — ONE mapping, two
// consumers (the Preview tabs/tree here, and the transcript file chips in the
// Reading window, S4). Preview modules keep importing `iconForPath` from state.
export { iconForPath } from "../view/icons";

/**
 * The Preview window's renderer state — a projection of (session truth × disk
 * truth) plus this window's own view truth (design record §6.2). Deliberately
 * NOT the reading-core reducer machinery: Preview's events arrive at
 * human-writing pace, so it earns a small imperative organism with the same
 * discipline (main owns truth, renderer projects, named transitions), not the
 * corpus-fenced firehose model.
 */
export interface PreviewViewState {
  /** Last binding pushed by main: the bound task's session + breadcrumb root. */
  binding: PreviewBinding;
  /** View truth: background tabs whose file changed since last focused. Never
   *  persisted — after a restart everything projects fresh (§6.0). */
  dirty: Set<string>;
  /** The active tab's loaded document, and which path it is for (guards against
   *  a stale async read landing after a tab switch). */
  doc: PreviewDocument | null;
  docPath: string | null;
  /** Freeze the strip's tab widths while the pointer stays in it after a close,
   *  so serial closing is click-click-click in place (§4). Keyed by path. */
  frozenWidths: Map<string, number> | null;
}

export function createInitialPreviewState(): PreviewViewState {
  return {
    binding: { taskId: null, projectDirName: null, session: null },
    dirty: new Set(),
    doc: null,
    docPath: null,
    frozenWidths: null,
  };
}

/** The behaviors the view modules invoke, bound once by the composition root —
 *  the Preview window's small equivalent of the Reading window's actions seam. */
export interface PreviewDeps {
  activate(path: string): void;
  close(path: string): void;
  closeOthers(path: string): void;
  closeToRight(path: string): void;
  openExternal(target: "folder" | "cursor"): void;
  togglePanel(): void;
  closeWindow(): void;
}

export function activeSession(state: PreviewViewState): PreviewSession | null {
  return state.binding.session;
}

export function activePath(state: PreviewViewState): string | null {
  return state.binding.session?.activePath ?? null;
}

/**
 * Same-name tabs get a dimmed parent-dir disambiguator (`brief.md — docs`,
 * §5.2). Returns a map path → parent-dir label for every path whose basename
 * collides with another open tab.
 */
export function disambiguators(session: PreviewSession | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!session) {
    return out;
  }
  const byName = new Map<string, string[]>();
  for (const tab of session.tabs) {
    const name = basename(tab.path);
    const list = byName.get(name) ?? [];
    list.push(tab.path);
    byName.set(name, list);
  }
  for (const paths of byName.values()) {
    if (paths.length < 2) {
      continue;
    }
    for (const path of paths) {
      const parent = parentDirName(path);
      if (parent) {
        out.set(path, parent);
      }
    }
  }
  return out;
}

export function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function parentDirName(path: string): string | null {
  const parts = path.split("/");
  return parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null;
}

/**
 * The `duet-file://` URL for a workspace-relative path (design record §4). The
 * task id is the URL host; each path segment is percent-encoded (spaces/unicode)
 * while the slashes stay real, so main can decode the pathname back to the
 * workspace-relative path. Used both to point a direct image tab's <img> at the
 * protocol and to rewrite relative markdown image sources.
 */
export function duetFileUrl(taskId: string, relativePath: string): string {
  const encoded = relativePath.split("/").map(encodeURIComponent).join("/");
  return `duet-file://${taskId}/${encoded}`;
}

/**
 * The base URL for resolving a markdown document's relative links/images —
 * `duet-file://<taskId>/<dir-of-file>/`. Replaces VS Code's global `<base href>`
 * trick, which is unsafe in this app: the Preview is a single bundled document
 * (vite `base: "./"`, relative asset URLs), so a document-global <base> would
 * hijack the whole app's URL resolution. Instead relative refs resolve
 * explicitly against this base with `new URL(ref, docBaseUrl(...))` — identical
 * semantics, scoped to the reader, zero global state.
 */
export function docBaseUrl(taskId: string, docPath: string): string {
  const slash = docPath.lastIndexOf("/");
  const dir = slash >= 0 ? docPath.slice(0, slash + 1) : "";
  const encodedDir = dir.split("/").map(encodeURIComponent).join("/");
  return `duet-file://${taskId}/${encodedDir}`;
}

/** Human byte count for the binary/too-large typed states. */
export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
