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
 * flows from CSS tokens — the bubble reads `--quote-comment-accent`, the plus
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
