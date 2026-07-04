// Lucide icon helper (map §3.1 renderer/view/icons.ts, D1). Callers keep
// importing their icon nodes from "lucide" directly; this is only the
// sized-SVG wrapper.

import { createElement as createLucideIcon, type IconNode } from "lucide";

export function lucideIcon(node: IconNode, size = 16): SVGElement {
  const svg = createLucideIcon(node);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  return svg;
}
