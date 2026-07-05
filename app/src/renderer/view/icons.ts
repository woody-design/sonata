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
