import { Idiomorph } from "idiomorph";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { BookOpen, FileX, Image as ImageIcon, FileWarning } from "lucide";
import { lucideIcon } from "../view/icons";
import type { PreviewDocument } from "../../shared/types";
import { activePath, docBaseUrl, duetFileUrl, formatBytes, type PreviewViewState } from "./state";

/**
 * The reading surface (design record §4/§6.2). Presenters are the only
 * polymorphism: a data-directed table keyed by document `kind`, no class
 * hierarchy. S2 lands the document-scale markdown render — `marked` + `DOMPurify`
 * (the transcript's audited pipeline) into a document-scale stylesheet, local
 * images through the `duet-file://` protocol, and live morphing that holds the
 * reader's position. Everything is read-only but always selectable.
 */

// The transcript's audited sanitizer profile, reused VERBATIM
// (renderer/view/transcript.ts). Do NOT weaken it: same profile, same forbidden
// tags. Our own enhancements (relative image-src rewrite, heading ids) run AFTER
// sanitize and never pass back through DOMPurify.
const markdownSanitizerConfig = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "input", "button"],
};

/** Rich markdown renders only up to this size; 512KB–1MB shows honestly as
 *  plain text with a one-line notice (§4 edge ladder). A file >1MB is already
 *  `too-large` (head-sliced) by the time it reaches here. */
const MARKDOWN_RICH_MAX_BYTES = 512 * 1024;

/** The handlers the presenters reach back into — bound once by the composition
 *  root. Relative links resolve at click time there (it owns the scroll box and
 *  the current doc path); presenters only need "open a tab" and "reveal". */
export interface ReaderContext {
  taskId: string | null;
  openTab(relativePath: string): void;
  revealInFinder(relativePath: string): void;
}

type Presenter = (doc: PreviewDocument, ctx: ReaderContext) => HTMLElement;

const PRESENTERS: Record<PreviewDocument["kind"], Presenter> = {
  markdown: presentMarkdown,
  text: presentCode,
  html: presentHtml,
  image: presentImage,
  "too-large": presentTooLarge,
  binary: (doc) => presentTyped(FileWarning, "Binary file", `${doc.name} · ${formatBytes(doc.size)} — can’t preview`),
  empty: (doc) => presentTyped(FileWarning, "Empty file", doc.name),
  absent: presentTombstone,
};

/**
 * Full render (tab switch, first load, empty/loading): replace the canvas
 * contents. A loading frame is held quiet rather than flashing stale content.
 */
export function renderReader(state: PreviewViewState, contentEl: HTMLElement, ctx: ReaderContext): void {
  const path = activePath(state);

  if (!path) {
    contentEl.replaceChildren(emptyState());
    contentEl.dataset.previewReader = "empty";
    return;
  }
  if (state.docPath !== path || !state.doc) {
    // The read for this tab is still in flight (sub-ms locally). Hold a quiet
    // frame rather than flashing stale content.
    contentEl.replaceChildren();
    contentEl.dataset.previewReader = "loading";
    return;
  }

  const doc = state.doc;
  contentEl.replaceChildren(PRESENTERS[doc.kind](doc, ctx));
  contentEl.dataset.previewReader = doc.kind;
}

/**
 * Live-update render (a `file:changed` re-read of the active tab): DOM-morph the
 * fresh render onto the existing tree instead of replacing it, so unchanged
 * nodes keep identity and the reader's scroll position survives (§4). idiomorph
 * (preferred over morphdom for id-less content) morphs children only. A kind
 * change (text→too-large, absent→markdown) or a non-document state falls back to
 * a clean replace. Returns whether an in-place morph happened (the caller only
 * needs the scroll-hold dance when it did).
 */
export function morphReader(
  state: PreviewViewState,
  contentEl: HTMLElement,
  ctx: ReaderContext,
): { morphed: boolean } {
  const path = activePath(state);
  if (!path || state.docPath !== path || !state.doc) {
    renderReader(state, contentEl, ctx);
    return { morphed: false };
  }
  const next = PRESENTERS[state.doc.kind](state.doc, ctx);
  const existing = contentEl.firstElementChild;
  if (
    existing instanceof HTMLElement &&
    existing.classList.contains("preview-doc") &&
    next.classList.contains("preview-doc") &&
    existing.dataset.docKind === next.dataset.docKind
  ) {
    Idiomorph.morph(existing, next, { morphStyle: "innerHTML" });
    contentEl.dataset.previewReader = state.doc.kind;
    return { morphed: true };
  }
  contentEl.replaceChildren(next);
  contentEl.dataset.previewReader = state.doc.kind;
  return { morphed: false };
}

// ── Presenters ───────────────────────────────────────────────────────────────

function presentMarkdown(doc: PreviewDocument, ctx: ReaderContext): HTMLElement {
  if (doc.size > MARKDOWN_RICH_MAX_BYTES) {
    // 512KB–1MB: a rich render (parse + sanitize + morph) would be heavy for a
    // reading surface. Show it honestly as plain text with a one-line notice.
    return presentCode(doc, ctx, `Large markdown (${formatBytes(doc.size)}) — shown as plain text.`);
  }
  const wrap = docWrap("markdown");
  const article = document.createElement("article");
  article.className = "preview-md";
  article.innerHTML = DOMPurify.sanitize(
    marked.parse(doc.text ?? "", { async: false }),
    markdownSanitizerConfig,
  );
  // Post-sanitize enhancements — NEVER routed back through DOMPurify: resolve
  // relative image sources onto the duet-file protocol, and slug heading ids so
  // that #fragment links have a target. Relative LINK clicks are intercepted in
  // the composition root (it holds the scroll box + current doc path).
  resolveDocImages(article, ctx, doc.path);
  assignHeadingIds(article);
  wrap.append(article);
  return wrap;
}

/** Code / plain-text presenter (§4): monospace, indentation preserved, its own
 *  wider measure. Also the honest fallback for oversized markdown, which carries
 *  a leading notice. */
function presentCode(doc: PreviewDocument, _ctx: ReaderContext, notice?: string): HTMLElement {
  const wrap = docWrap("text");
  if (notice) {
    wrap.append(noticeBanner(notice));
  }
  const pre = document.createElement("pre");
  pre.className = "preview-doc-pre";
  pre.textContent = doc.text ?? "";
  wrap.append(pre);
  return wrap;
}

function presentTooLarge(doc: PreviewDocument, ctx: ReaderContext): HTMLElement {
  const wrap = docWrap("too-large");
  // Honest byte counts: what is actually shown vs the real file size. The head
  // slice is decoded UTF-8, so measure the shown text's real byte length.
  const shownBytes = new TextEncoder().encode(doc.text ?? "").length;
  const banner = document.createElement("div");
  banner.className = "preview-banner";
  const message = document.createElement("span");
  message.textContent = `Large file — showing the first ${formatBytes(shownBytes)} of ${formatBytes(doc.size)}.`;
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "preview-banner-action";
  reveal.textContent = "Reveal in Finder";
  reveal.addEventListener("click", () => ctx.revealInFinder(doc.path));
  banner.append(message, reveal);
  const pre = document.createElement("pre");
  pre.className = "preview-doc-pre";
  pre.textContent = doc.text ?? "";
  wrap.append(banner, pre);
  return wrap;
}

function presentHtml(doc: PreviewDocument): HTMLElement {
  const wrap = docWrap("html");
  // Sandboxed, isolated srcdoc — the existing preview pattern. No same-origin,
  // no scripts: an inert render of agent-written HTML. NOTE (documented in S1
  // findings P2): the iframe fills the canvas and scrolls INTERNALLY, so the
  // reader's per-path scroll (which tracks the outer #preview-content) does not
  // capture or restore an HTML tab's position, and the morph/tail-follow dance
  // is a no-op for HTML. The sandbox deliberately blocks reading the frame's
  // scroll; weakening it isn't worth it. Left as-is per S2 scope.
  const frame = document.createElement("iframe");
  frame.className = "preview-html-frame";
  frame.sandbox.value = "";
  frame.srcdoc = doc.text ?? "";
  wrap.append(frame);
  return wrap;
}

function presentImage(doc: PreviewDocument, ctx: ReaderContext): HTMLElement {
  const wrap = docWrap("image");
  if (!ctx.taskId) {
    return presentTyped(ImageIcon, "Image unavailable", doc.name);
  }
  const img = document.createElement("img");
  img.className = "preview-image";
  // Direct image tabs stream from disk via the protocol (no base64 IPC payload,
  // no size cap).
  img.src = duetFileUrl(ctx.taskId, doc.path);
  img.alt = doc.name;
  wrap.append(img);
  return wrap;
}

function presentTombstone(doc: PreviewDocument): HTMLElement {
  const state = typedState(FileX, "This file no longer exists on disk", doc.path);
  state.classList.add("preview-tombstone");
  return state;
}

// ── Post-sanitize enhancements ────────────────────────────────────────────────

/**
 * Rewrite relative markdown image sources onto the duet-file protocol so they
 * paint from disk. Absolute http(s) sources are left untouched (CSP blocks them
 * — the threat model gives agent-written markdown no remote-fetch channel); data:
 * URLs pass through (CSP-allowed). Resolution against the doc's base URL is the
 * exact algorithm `<base href>` would use — done explicitly to avoid a document-
 * global base in this single-page app (see `docBaseUrl`).
 */
function resolveDocImages(root: HTMLElement, ctx: ReaderContext, docPath: string): void {
  if (!ctx.taskId) {
    return;
  }
  const base = docBaseUrl(ctx.taskId, docPath);
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (!src) {
      continue;
    }
    let resolved: URL;
    try {
      resolved = new URL(src, base);
    } catch {
      continue;
    }
    if (resolved.protocol === "duet-file:") {
      img.setAttribute("src", resolved.href);
      img.loading = "lazy";
      img.decoding = "async";
    }
  }
}

/** Slug ids on headings (GitHub-style) so `#fragment` links have a target. Only
 *  fills a missing id; dedups collisions with a numeric suffix. */
function assignHeadingIds(root: HTMLElement): void {
  const used = new Set<string>();
  for (const heading of Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    if (heading.id) {
      used.add(heading.id);
      continue;
    }
    const base = slugify(heading.textContent ?? "");
    if (!base) {
      continue;
    }
    let id = base;
    let n = 1;
    while (used.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    used.add(id);
    heading.id = id;
  }
}

function slugify(text: string): string {
  // Unicode-aware (\p{L}/\p{N}) so CJK and other non-ASCII headings keep an id —
  // Woody's docs are bilingual, so `## 设计原则` must slug to `设计原则`, not "".
  // Fragment lookup uses CSS.escape, so non-ASCII ids resolve fine.
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Shared building blocks ────────────────────────────────────────────────────

function noticeBanner(text: string): HTMLElement {
  const banner = document.createElement("div");
  banner.className = "preview-banner";
  banner.textContent = text;
  return banner;
}

function presentTyped(icon: Parameters<typeof lucideIcon>[0], title: string, detail: string): HTMLElement {
  return typedState(icon, title, detail);
}

function typedState(
  icon: Parameters<typeof lucideIcon>[0],
  title: string,
  detail: string,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "preview-typed-state";
  wrap.append(lucideIcon(icon, 28));
  const heading = document.createElement("p");
  heading.className = "preview-typed-title";
  heading.textContent = title;
  const sub = document.createElement("p");
  sub.className = "preview-typed-detail";
  sub.textContent = detail;
  wrap.append(heading, sub);
  return wrap;
}

function emptyState(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "preview-empty-state";
  wrap.append(lucideIcon(BookOpen, 30));
  const heading = document.createElement("p");
  heading.className = "preview-empty-title";
  heading.textContent = "Nothing open yet";
  const sub = document.createElement("p");
  sub.className = "preview-empty-detail";
  sub.textContent = "Files you open from a chat appear here.";
  wrap.append(heading, sub);
  return wrap;
}

function docWrap(kind: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "preview-doc";
  wrap.dataset.docKind = kind;
  return wrap;
}
