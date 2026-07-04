import { BookOpen, FileX, Image as ImageIcon, FileWarning } from "lucide";
import { lucideIcon } from "../view/icons";
import type { PreviewDocument } from "../../shared/types";
import { activePath, formatBytes, type PreviewViewState } from "./state";

/**
 * The reading surface. Presenters are the only polymorphism (§6.2): a
 * data-directed table keyed by document `kind`, no class hierarchy. S1 ships
 * minimal presenters — text (plain <pre>), image, html (sandboxed srcdoc
 * iframe), the tombstone, and typed states for binary/too-large/empty; rich
 * markdown lands in S2, so `.md` reads as raw text here (acceptable only in
 * this slice). Everything is read-only but always selectable.
 */

const PRESENTERS: Record<PreviewDocument["kind"], (doc: PreviewDocument) => HTMLElement> = {
  text: presentText,
  // Rich markdown is S2; in S1 a document renders as raw text.
  markdown: presentText,
  html: presentHtml,
  image: presentImage,
  "too-large": presentTooLarge,
  binary: (doc) => presentTyped(FileWarning, "Binary file", `${doc.name} · ${formatBytes(doc.size)} — can’t preview`),
  empty: (doc) => presentTyped(FileWarning, "Empty file", doc.name),
  absent: presentTombstone,
};

export function renderReader(state: PreviewViewState, contentEl: HTMLElement): void {
  contentEl.replaceChildren();
  const path = activePath(state);

  if (!path) {
    contentEl.append(emptyState());
    contentEl.dataset.previewReader = "empty";
    return;
  }

  if (state.docPath !== path || !state.doc) {
    // The read for this tab is still in flight (sub-ms locally). Hold a quiet
    // frame rather than flashing stale content.
    contentEl.dataset.previewReader = "loading";
    return;
  }

  const doc = state.doc;
  contentEl.append(PRESENTERS[doc.kind](doc));
  contentEl.dataset.previewReader = doc.kind;
}

function presentText(doc: PreviewDocument): HTMLElement {
  const wrap = docWrap("text");
  const pre = document.createElement("pre");
  pre.className = "preview-doc-pre";
  pre.textContent = doc.text ?? "";
  wrap.append(pre);
  return wrap;
}

function presentTooLarge(doc: PreviewDocument): HTMLElement {
  const wrap = docWrap("too-large");
  const banner = document.createElement("div");
  banner.className = "preview-banner";
  banner.textContent = `Large file — showing the first ${formatBytes(
    (doc.text ?? "").length,
  )} of ${formatBytes(doc.size)}. Open in Finder to read the rest.`;
  const pre = document.createElement("pre");
  pre.className = "preview-doc-pre";
  pre.textContent = doc.text ?? "";
  wrap.append(banner, pre);
  return wrap;
}

function presentHtml(doc: PreviewDocument): HTMLElement {
  const wrap = docWrap("html");
  // Sandboxed, isolated srcdoc — the existing preview pattern. No same-origin,
  // no scripts: an inert render of agent-written HTML.
  const frame = document.createElement("iframe");
  frame.className = "preview-html-frame";
  frame.sandbox.value = "";
  frame.srcdoc = doc.text ?? "";
  wrap.append(frame);
  return wrap;
}

function presentImage(doc: PreviewDocument): HTMLElement {
  const wrap = docWrap("image");
  if (!doc.dataUrl) {
    return presentTyped(ImageIcon, "Image unavailable", doc.name);
  }
  const img = document.createElement("img");
  img.className = "preview-image";
  img.src = doc.dataUrl;
  img.alt = doc.name;
  wrap.append(img);
  return wrap;
}

function presentTombstone(doc: PreviewDocument): HTMLElement {
  const state = typedState(FileX, "This file no longer exists on disk", doc.path);
  state.classList.add("preview-tombstone");
  return state;
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
