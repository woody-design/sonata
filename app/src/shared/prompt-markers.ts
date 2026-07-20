/**
 * Prompt-marker canonicalization — the single source of truth for reconciling a
 * prompt as Sonata stored it (the raw text the user typed) against the same prompt
 * as the CLI later reports it (transcript `user-message`, and the
 * `UserPromptSubmit` hook payload). The CLI decorates image attachments with
 * `[Image #N]` placeholders; Sonata stores the undecorated text. Every place that
 * asks "are these the same prompt?" must read THROUGH that decoration with one
 * rule.
 *
 * The 2026-07-05 image double-card bug was exactly this rule living in the
 * delivery receipt matcher but NOT in the run↔turn attribution or the three
 * hook back-stamp guards — so an image prompt matched in one place and fell
 * through in the others, leaving an un-attributed run that rendered as a second
 * (husk) card. Five call sites answer this one question; they now share this
 * module so they cannot drift again.
 *
 * Two transforms, ONE marker definition:
 * - `stripImageMarkers` — remove markers only, preserve the rest verbatim. For
 *   DISPLAY (the reading bubble): the user's own whitespace must survive.
 * - `normalizePromptForMatch` — aggressive canonical form (markers gone,
 *   whitespace collapsed) for EQUALITY comparisons. Never shown to the user.
 */

// The CLI's image-attachment placeholder, e.g. "[Image #1]". Case-insensitive
// and tolerant of the internal spacing. One definition, so a future decoration
// change (or a new marker family) has a single landing site.
// Claude paints the space with cursor positioning in some layouts; stripping
// ANSI then yields `[Image#N]`. Accept both that rendered form and the provider
// transcript's literal `[Image #N]`.
export const IMAGE_MARKER_RE = /\[Image\s*#\d+\]/gi;

/**
 * Remove CLI image markers; leave everything else — including the user's
 * whitespace — untouched. Display-safe: this is what a reading bubble shows.
 */
export function stripImageMarkers(value: string): string {
  return value.replace(IMAGE_MARKER_RE, "");
}

/**
 * Canonical form for a "same prompt?" equality test: newline-normalize, drop
 * image markers, collapse horizontal whitespace, trim. Idempotent, and a no-op
 * on marker-free single-line text (so a plain prompt still equals itself). This
 * reproduces the delivery receipt matcher's original `normalizeReceiptText`
 * (shipped in 59c6ee7) verbatim — now shared so all five reconciliation sites
 * agree. Aggressive by design; never use it for display.
 */
export function normalizePromptForMatch(value: string): string {
  return stripImageMarkers(value.replace(/\r\n?/g, "\n").trim())
    .replace(/[ \t]+/g, " ")
    .trim();
}
