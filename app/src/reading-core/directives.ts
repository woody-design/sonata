/**
 * The runtime reducer's instruction list (map §1.3 "Design consequence"): ONE
 * ordered union with two documented families — render directives (which paint
 * path the shell takes) and effect directives (non-render work the reducer
 * requests, review A). Directive order in a reducer result = today's call
 * order inside the onRuntimeEvent handler; the shell performs the list 1:1,
 * in order, with no logic of its own beyond the mapping.
 *
 * The union is CLOSED by program discipline: extending it is a map-drift
 * event recorded BEFORE code (map §3.5). Payload fields carry decisions the
 * reducer already made (e.g. `chipChanged`), so the shell never re-derives
 * policy — it only branches on the payload it was handed.
 */

export type RenderDirective =
  /** markViewChanged, active view: repaint everything (render()). */
  | { kind: "full"; taskId: string }
  /** markViewChanged, background view: the reducer set `view.unread`; no
   *  paint. Kept distinct from `none` so the policy stays visible as data. */
  | { kind: "unread-only"; taskId: string }
  /** Sidebar-only rebuild (cli-state activity transitions — S0 discipline). */
  | { kind: "sidebar"; taskId: string }
  /** ~3 Hz working-status tick, active view: patch the strip's status area
   *  in place (updateStatusStripStatusInPlace) — never a full render. */
  | { kind: "strip-in-place"; taskId: string }
  /** Working-status liveness transition: toggle the sidebar spinner's class
   *  in place (all views), and — only when the view is active
   *  (`statusStrip`) — re-render the status strip for its stall voice. */
  | { kind: "strip-full"; taskId: string; statusStrip: boolean }
  /** Usage tick, active view: renderUsageIndicator, plus the composer chips
   *  when the model summary label changed (`chipChanged`, S6.5) and the
   *  popover when it is open (`popoverOpen`). NEVER a full render — it would
   *  replaceChildren the transcript and wipe any active text selection. */
  | {
      kind: "usage-in-place";
      taskId: string;
      chipChanged: boolean;
      popoverOpen: boolean;
      /** (D) The usage tick also cleared a landed control-switch needs-attention
       *  pointer — repaint the banner row (usage-in-place otherwise skips banners). */
      bannersChanged?: boolean;
    }
  /** New live/structured transcript content: the 160 ms debounced
   *  transcript-stream render (T3). */
  | { kind: "transcript-debounced"; taskId: string }
  /** The persisted session index changed: the 150 ms debounced refresh (T2). */
  | { kind: "session-index-debounced" }
  /** Handled, deliberately no paint (state-only mutation or a keyed guard
   *  that rejected the event). Distinct from an EMPTY result, which means
   *  the event was dropped (no loaded view for its taskId). */
  | { kind: "none" };

export type EffectDirective =
  /** report:updated — async IPC re-read of the runtime report; not a render
   *  path (the re-read itself decides what changes, review A). */
  { kind: "report-refresh"; taskId: string };

export type Directive = RenderDirective | EffectDirective;
