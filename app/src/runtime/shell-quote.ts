/**
 * Quote an IMAGE path for the chip channel — a bracketed-paste into the CLI's
 * own input, which is then shell-tokenized (Codex's Rust shlex) / path-detected
 * (Claude). Verified on real CLIs (2026-06-26 probe): a double-quoted absolute
 * path chips as [Image #N] on BOTH for paths with spaces AND special chars
 * (' " ; \). shlex SINGLE-quoting was tried and FAILS on Claude, so double-quote
 * with POSIX interior escaping is the one cross-CLI format. The CLI un-escapes,
 * so the agent gets the true path.
 *
 * Do NOT use this for the prompt-TEXT channel — see quotePathForText.
 */
export function shellQuotePath(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * Quote a referenced file/folder path for the prompt-TEXT channel — a path
 * mention the agent reads as plain text (NOT shell-parsed; nothing un-escapes
 * it). So, unlike shellQuotePath, we must NOT backslash-escape $, `, or \ — the
 * agent would receive those backslashes and open the wrong path. Wrap in double
 * quotes (signals "this is a path", and disambiguates spaces) and escape only an
 * embedded double quote so the wrapper is unambiguous.
 */
export function quotePathForText(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
