// Quote & Comment — the pure serialization core (plan
// `product-thinking/2026-07-14-quote-comment-plan-v0.md` §Serialization
// contract). Selecting transcript text and attaching a comment produces one
// plain paragraph appended to the composer draft; from that moment it is
// ordinary text the user edits or deletes. There is no persistence, no anchor,
// no sync-back — the composer text IS the wire text (D1). Everything here is
// string-in/string-out and DOM-free: this module lives in reading-core, which
// compiles without the DOM lib (tsconfig.main), so a stray `document` reference
// is a build error. The view layer captures the raw selection string and the
// raw comment; all normalization, truncation, and formatting happen HERE so the
// decision logic unit-tests in plain node.

/** Above this normalized length a quote is truncated (head + ellipsis + tail).
 *  A hypothesis, not a law — tune with field use (plan §Serialization). */
export const QUOTE_MAX_LENGTH = 180;
/** Leading characters kept when a quote is truncated. */
export const QUOTE_HEAD_LENGTH = 100;
/** Trailing characters kept when a quote is truncated. */
export const QUOTE_TAIL_LENGTH = 60;
/** The visible elision between the kept head and tail. */
export const QUOTE_TRUNCATION_SEPARATOR = " … ";

/**
 * Collapse every run of whitespace to a single space and trim the ends. The
 * quote arrives from `selection.toString()`, which carries the transcript's
 * layout whitespace (newlines between block elements, indentation); the wire
 * text should read as one continuous run.
 */
export function normalizeQuote(rawQuote: string): string {
  return rawQuote.replace(/\s+/g, " ").trim();
}

/**
 * Truncate an already-normalized quote to head + " … " + tail when it exceeds
 * QUOTE_MAX_LENGTH. Operates on Unicode code points (not UTF-16 units) so a
 * surrogate pair (emoji) is never split at the cut. A quote at or below the
 * limit is returned unchanged.
 */
export function truncateQuote(normalizedQuote: string): string {
  const chars = Array.from(normalizedQuote);
  if (chars.length <= QUOTE_MAX_LENGTH) {
    return normalizedQuote;
  }
  const head = chars.slice(0, QUOTE_HEAD_LENGTH).join("");
  const tail = chars.slice(chars.length - QUOTE_TAIL_LENGTH).join("");
  return `${head}${QUOTE_TRUNCATION_SEPARATOR}${tail}`;
}

/**
 * Build the exact serialized paragraph (Woody's wording, plan §Serialization):
 *   About "<quote>", My comments "<comment>"
 * The quote is normalized then truncated; the comment is trimmed but otherwise
 * left as the user typed it (the input bar is single-line, so there is no
 * interior whitespace to collapse). Callers pass the raw selection string and
 * the raw input value — preparation is this module's job.
 */
export function formatQuoteComment(rawQuote: string, rawComment: string): string {
  const quote = truncateQuote(normalizeQuote(rawQuote));
  const comment = rawComment.trim();
  return `About "${quote}", My comments "${comment}"`;
}

/**
 * Append a serialized paragraph to the existing composer draft (D5 — always at
 * the end, regardless of caret). Existing text is trimmed at its end so the
 * blank-line separator is exact; an empty or whitespace-only draft yields just
 * the paragraph. Never mutates — returns the new draft string.
 */
export function appendToDraft(existingDraft: string, paragraph: string): string {
  const base = existingDraft.trimEnd();
  return base.length === 0 ? paragraph : `${base}\n\n${paragraph}`;
}
