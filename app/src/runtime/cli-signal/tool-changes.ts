/**
 * Semantic change attribution (OBS S6 / D3) — the file paths a PostToolUse hook
 * names as changed. This is the primary `changedFiles` source: attribution moved
 * from the filesystem watcher (physical channel, an ignore-list arms race) to the
 * agent's own tool calls (semantic channel). Both providers speak the same hook
 * wire schema, but their file-mutating tools differ, so the extraction is a
 * per-tool rule — verified against the captured payloads, NOT assumed:
 *
 *   - Claude: `Write` / `Edit` / `MultiEdit` carry `tool_input.file_path`;
 *     `NotebookEdit` carries `tool_input.notebook_path`.
 *   - Codex: file mutations arrive as `apply_patch`, whose `tool_input.command`
 *     is an OpenAI patch envelope (`*** Add File: <path>` …), NOT a `file_path`
 *     field (verified 0.144.4, `tests/fixtures/codex-hooks/verified-payloads`).
 *   - `Bash` (both providers), `Read`, and everything else name no path here —
 *     that is what the turn-boundary reconcile is for.
 *
 * Pure and provider-agnostic: it reads only the payload, so the same function
 * serves both providers and is unit-testable with synthetic envelopes.
 */

import type { HookPayload } from "../../shared/types/cli-signal";
import type { ChangeKind } from "../../shared/types/domain";

export interface ToolChangePath {
  /** The path exactly as the tool named it — absolute or cwd-relative. The
   *  caller normalizes it against the workspace cwd before recording. */
  path: string;
  changeKind: ChangeKind;
}

export type ApplyPatchVerb = "Add" | "Update" | "Delete";

/**
 * Parse the file-op header lines of an OpenAI apply_patch envelope, in order.
 * We read ONLY the `*** (Add|Update|Delete) File: <path>` headers — never the
 * hunk body. The `***` is anchored at column 0 (no leading trim) so a body
 * context line (single-space prefix) that literally reads `*** Update File: x`
 * cannot masquerade as a header. Returns every op (unlike the approval-card
 * summary, which shows only the first). Malformed/empty input → `[]`, never throws.
 */
export function parseApplyPatchOps(envelope: string): Array<{ verb: ApplyPatchVerb; path: string }> {
  const ops: Array<{ verb: ApplyPatchVerb; path: string }> = [];
  for (const rawLine of envelope.split("\n")) {
    // Only an optional trailing \r tolerated so `^` truly anchors at column 0.
    const match = /^\*\*\* (Add|Update|Delete) File: (.+?)\r?$/.exec(rawLine);
    if (!match) {
      continue;
    }
    const filePath = (match[2] ?? "").trim();
    if (!filePath) {
      continue;
    }
    ops.push({ verb: match[1] as ApplyPatchVerb, path: filePath });
  }
  return ops;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The changed paths a PostToolUse payload names, with a best-effort change kind.
 * changeKind is a semantic read of the tool (no filesystem probe): apply_patch
 * carries exact verbs; a Claude `Write` creates-or-replaces (⇒ "added"), while
 * `Edit`/`MultiEdit`/`NotebookEdit` require an existing target (⇒ "modified").
 * Precise added-vs-modified isn't derivable from a single payload, and changeKind
 * is forensic-only (no consumer asserts it); reconcile entries carry the exact kind.
 */
export function changedPathsFromToolUse(payload: HookPayload): ToolChangePath[] {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input =
    payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input)
      ? (payload.tool_input as Record<string, unknown>)
      : {};

  if (tool === "apply_patch") {
    return parseApplyPatchOps(stringField(input, "command") ?? "").map((op) => ({
      path: op.path,
      changeKind: op.verb === "Add" ? "added" : op.verb === "Delete" ? "deleted" : "modified",
    }));
  }
  if (tool === "Write") {
    const filePath = stringField(input, "file_path") ?? stringField(input, "path");
    return filePath ? [{ path: filePath, changeKind: "added" }] : [];
  }
  if (tool === "Edit" || tool === "MultiEdit") {
    const filePath = stringField(input, "file_path") ?? stringField(input, "path");
    return filePath ? [{ path: filePath, changeKind: "modified" }] : [];
  }
  if (tool === "NotebookEdit") {
    const filePath =
      stringField(input, "notebook_path") ?? stringField(input, "file_path") ?? stringField(input, "path");
    return filePath ? [{ path: filePath, changeKind: "modified" }] : [];
  }
  // Bash, Read, NotebookRead, and any unknown tool name carry no extractable
  // path — the turn-boundary reconcile is their attribution net.
  return [];
}
