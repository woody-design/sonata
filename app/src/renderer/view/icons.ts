// Lucide icon helper (map §3.1 renderer/view/icons.ts, D1). Callers keep
// importing their icon nodes from "lucide" directly; this is only the
// sized-SVG wrapper — plus the ONE path→type-icon mapping, shared by the
// Preview window (tabs/tree) and the Reading window's transcript file chips
// (S4). The mapping lives HERE, not in renderer/preview/, because the
// transcript view may not import renderer/preview/* (import fence) — one
// mapping, two consumers, no duplication.

import {
  Braces,
  createElement as createLucideIcon,
  File,
  FileCode,
  FileText,
  Image as ImageIcon,
  type IconNode,
} from "lucide";

export function lucideIcon(node: IconNode, size = 16): SVGElement {
  const svg = createLucideIcon(node);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Woody's Comment glyph (`Temp/Comment/Comment.svg`): a rounded speech bubble
 * with a centered plus. The path data is inlined verbatim (240×240 viewBox).
 * The bubble and plus carry class hooks rather than baked-in fills so the color
 * flows from CSS tokens — the bubble reads `--accent`, the plus
 * stays white (styles.css). This lives in icons.ts because it is the shared
 * icon home; the Quote & Comment view mounts it in its trigger.
 */
export function commentGlyph(size = 28): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 240 240");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("quote-comment-glyph");

  const bubble = document.createElementNS(SVG_NS, "path");
  bubble.setAttribute(
    "d",
    "M119.961 0.00169398C54.3036 0.00169398 0.91347 53.8447 0.923999 120.021V240H0.914103C0.914103 240 -3.39922 240 0.923999 240L119.99 240C185.648 240 239 186.178 239 120.019C239.01 53.8493 185.65 0.00847054 119.99 0L119.961 0.00169398Z",
  );
  bubble.classList.add("quote-comment-glyph-bubble");

  const plus = document.createElementNS(SVG_NS, "path");
  plus.setAttribute(
    "d",
    "M69.7928 128.333H111.46V170H128.126V128.333H169.793V111.667H128.126V70H111.46V111.667H69.7928V128.333Z",
  );
  plus.classList.add("quote-comment-glyph-plus");

  svg.append(bubble, plus);
  return svg;
}

/**
 * The Sonata brand mark — the app icon's own artwork
 * (`build-resources/Sonata.icon/Assets/Sonata.svg`, 1200×1200), inlined verbatim
 * as path data exactly the way `commentGlyph` above inlines Woody's Comment
 * glyph, and for the same reason: an icon is not a module, and inlining keeps it
 * inside the view layer's import allowlist with no Vite asset plumbing.
 *
 * Nothing in the renderer shipped a logo before this (S4) — `src/renderer/assets/`
 * held only fonts. Its sole consumer today is the quit confirmation dialog.
 *
 * The source artwork carries NO fill: it is a monochrome stencil whose color the
 * macOS icon bundle supplies per appearance (`icon.json` fill-specializations).
 * So it takes `currentColor` here and its color flows from the design tokens on
 * the class hook — the same treatment every other icon in the app gets, and the
 * one that keeps it legible in both light and dark.
 */
export function sonataMark(size = 44): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 1200 1200");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("sonata-mark");

  const mark = document.createElementNS(SVG_NS, "path");
  mark.setAttribute("d", SONATA_MARK_PATH);
  svg.append(mark);
  return svg;
}

/** The mark's path data, wrapped for review only — the concatenation is the
 *  file's single `<path d>` byte for byte. */
const SONATA_MARK_PATH = [
  "m304.39 767.75c0.13281 0.37109 0.30078 0.69531 0.50391 1.0312 0.19141 0.32422 ",
  "0.37109 0.63672 0.63672 0.9375 0.26562 0.30078 0.58984 0.5625 0.91016 0.80469 ",
  "0.21484 0.15625 0.33594 0.35938 0.5625 0.49219l192.04 110.87 2.832 1.6328 0.046875 ",
  "0.023437 194.62 112.37h0.023438c0.097656 0.046875 0.20312 0.046875 0.28906 0.097656 ",
  "0.80469 0.40625 1.7031 0.70703 2.6875 0.70703s1.8711-0.28906 ",
  "2.6875-0.70703c0.097656-0.046875 0.20312-0.046875 ",
  "0.28906-0.097656h0.023437l194.66-112.39c0.22656-0.13281 0.34766-0.33594 ",
  "0.55078-0.49219 0.33594-0.25391 0.66016-0.50391 0.9375-0.80469 0.25391-0.30078 ",
  "0.43359-0.61328 0.63672-0.9375 0.19141-0.33594 0.35938-0.66016 0.49219-1.0312 ",
  "0.13281-0.38281 0.19141-0.78125 0.23828-1.1992 0.035156-0.25391 0.15625-0.46875 0.15",
  "625-0.73047l0.003906-224.86v-224.88c0-0.13281-0.058594-0.23828-0.070313-0.35938-0.01",
  "1719-0.25391-0.058593-0.50391-0.10938-0.76953-0.046875-0.27734-0.12109-0.53906-0.214",
  "84-0.80469-0.097656-0.26563-0.19141-0.50391-0.30078-0.74219-0.058593-0.10938-0.05859",
  "3-0.22656-0.12109-0.32422-0.058594-0.097656-0.16797-0.15625-0.22656-0.25391-0.15625-",
  "0.22656-0.30078-0.43359-0.48047-0.63672-0.20312-0.22656-0.39453-0.42188-0.625-0.6132",
  "8-0.20312-0.16797-0.38281-0.3125-0.58984-0.45703-0.10937-0.070313-0.17969-0.17969-0.",
  "27734-0.25391l-194.66-112.39-194.66-112.49c-0.22656-0.12109-0.45703-0.13281-0.68359-",
  "0.22656-0.39453-0.16797-0.78125-0.32422-1.2109-0.39453-0.35937-0.070313-0.70703-0.07",
  "0313-1.0781-0.070313-0.39453 0-0.76953 0-1.1758 0.085937-0.39453 0.070313-0.74219 ",
  "0.21484-1.1289 0.37109-0.23828 0.10938-0.50391 0.12109-0.74219 0.25391l-194.87 ",
  "112.49c-0.097656 0.058594-0.15625 0.15625-0.25391 0.22656-0.23828 0.15625-0.44531 ",
  "0.32422-0.66016 0.50391-0.21484 0.17969-0.38281 0.37109-0.5625 0.57422-0.17969 ",
  "0.20312-0.32422 0.38281-0.46875 0.60156-0.070312 0.10938-0.19141 0.16797-0.25391 ",
  "0.28906-0.070312 0.10938-0.070312 0.23828-0.12109 0.35938-0.12109 0.22656-0.21484 ",
  "0.46875-0.28906 0.70703-0.085938 0.26563-0.15625 0.51563-0.21484 0.79297-0.058594 ",
  "0.26562-0.097656 0.52734-0.10938 0.80469-0.011719 0.12109-0.070312 0.21484-0.070312 ",
  "0.33594v449.62c0 0.25391 0.12109 0.46875 0.14453 0.73047 0.085938 0.41797 0.13672 ",
  "0.8125 0.26562 1.207zm571.81-110.83-165.09 95.281c-0.81641-0.70703-1.6211-1.4297-2.5",
  "781-1.9805-0.96094-0.55078-1.9805-0.875-3-1.2344v-191.1c1.0195-0.35938 ",
  "2.0508-0.69531 3-1.2461l167.66-96.863zm-159.08 105.69 159.09-91.812v197.14l-158.66 ",
  "91.621-0.003907-193.73c0-1.0938-0.23828-2.1484-0.41797-3.2148zm-29.16-207.94c0.81641",
  " 0.70703 1.6211 1.4297 2.5781 1.9805 0.96094 0.55078 1.9805 0.875 3 ",
  "1.2344v191.11c-1.0195 0.34766-2.0508 0.68359-3 1.2461l-179.66 ",
  "103.81v-197.14zm-177.09 88.391v-211.01l170.66-98.531v207.54c0 1.1055 0.23828 2.1602 ",
  "0.42188 3.2148zm-6-221.4-170.86-98.531 170.84-98.629 170.68 98.629zm200.66 ",
  "109.01v-204.07l176.66 102z",
].join("");

/**
 * Lucide type icon by extension (§5.8): file-text (docs), file-code (source +
 * html), braces (json), image, file (fallback). Monochrome ink — the app
 * trades color for calm. The single source of truth for both the Preview
 * tabs/tree and the transcript file chips.
 */
export function iconForPath(filePath: string): IconNode {
  const ext = extensionOf(filePath);
  if (ext === "json") {
    return Braces;
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return ImageIcon;
  }
  if (SOURCE_EXTENSIONS.has(ext)) {
    return FileCode;
  }
  if (DOC_EXTENSIONS.has(ext)) {
    return FileText;
  }
  return File;
}

function extensionOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"]);
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "html", "htm", "css", "scss",
  "py", "go", "rs", "java", "c", "h", "cpp", "hpp", "rb", "sh", "swift",
  "kt", "php", "sql", "yaml", "yml", "toml", "xml",
]);
const DOC_EXTENSIONS = new Set(["md", "markdown", "txt", "text", "csv", "log", "rst"]);
