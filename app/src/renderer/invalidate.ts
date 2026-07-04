// Late-binding render seam (map §2.5; pulled forward from D4c to D0 by the
// program-brain amendment, execution log 2026-07-03). Flows and view handlers
// request a repaint through this module instead of importing the render
// orchestrator, so `flows → render → view → flows` never becomes a static
// import cycle. main.ts binds the real render() once at boot, BEFORE the
// first render (boot order R4).
//
// requestRenderPath (the targeted-path variant the map sketches) is
// deliberately absent: the D0 survey found no moved consumer that needs a
// targeted path yet — D-mid adds it alongside the view families that do
// (sidebar, composer popover, option prompt).

type RenderFn = () => void;

let renderFn: RenderFn | null = null;

/** Bound once by main.ts at boot, before the first render (R4). */
export function initInvalidate(render: RenderFn): void {
  renderFn = render;
}

/** Request a full render through the seam. Throws when the boot sequence has
 *  not bound the orchestrator yet — a loud boot-order violation beats a
 *  silently dropped paint. */
export function requestRender(): void {
  if (!renderFn) {
    throw new Error("requestRender() before initInvalidate() — bind the seams before the first render (R4)");
  }
  renderFn();
}
