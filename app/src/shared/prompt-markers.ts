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
 * (husk) card. Every call site that answers this one question shares this
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
 * Claude Code 2.1.280 marks a paste over 800 characters or over 2 line breaks
 * by wrapping it in `<pasted_content id="…">…</pasted_content>` and writes that
 * WRAPPED form into the transcript's user record (MEASURED 2026-09-23: leading
 * `\n\n`, a newline after the open tag, a newline before the close tag, and
 * the close tag carries the id attribute too — `</pasted_content id="7f40">`).
 * Sonata delivers every prompt as a bracketed paste, so every multi-line prompt
 * arrives wrapped, and the run ↔ turn pairing (exact text equality) fails:
 * the prompt renders twice and the run's turn falls back to "could not be read
 * structurally". Unwrap on both the display and the matching side. Tolerant of
 * attributes on either tag and of several pastes in one message.
 */
export const PASTED_CONTENT_RE = /<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g;

export function unwrapPastedContent(value: string): string {
  return value.replace(PASTED_CONTENT_RE, "$1");
}

/**
 * Canonical form for a "same prompt?" equality test: newline-normalize, drop
 * image markers, collapse horizontal whitespace, trim. Idempotent, and a no-op
 * on marker-free single-line text (so a plain prompt still equals itself). This
 * reproduces the (since-deleted, X2) delivery receipt matcher's original
 * `normalizeReceiptText` (shipped in 59c6ee7) verbatim — shared so every
 * reconciliation site agrees. Aggressive by design; never use it for display.
 */
export function normalizePromptForMatch(value: string): string {
  return stripImageMarkers(unwrapPastedContent(value.replace(/\r\n?/g, "\n")).trim())
    .replace(/[ \t]+/g, " ")
    .trim();
}
