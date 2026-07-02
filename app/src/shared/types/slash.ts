import type { RuntimeProvider } from "./domain";

export type SlashScope = "builtin" | "system" | "personal" | "project";

export interface SlashCommandEntry {
  /**
   * Canonical text inserted into the composer: "/name" for slash commands,
   * "$name" for Codex skills (their native invocation is a skill mention,
   * not a slash command — probe s3).
   */
  invocation: string;
  /** Name without the sigil; the picker filters against this. */
  name: string;
  provider: RuntimeProvider;
  kind: "builtin" | "skill";
  description: string;
  /** e.g. "[instructions]" — shown as ghost text after the name. */
  argumentHint: string | null;
  scope: SlashScope;
  /**
   * Shown in the picker. Unlisted entries still count as "known" for the
   * submit guard, so typing them forwards without an unknown-command warning.
   */
  listed: boolean;
}

export interface ReadSlashCommandsRequest {
  /** Resolve provider + workspace from a live task… */
  taskId?: string;
  /** …or ask directly (new-chat composer, no task yet). */
  provider?: RuntimeProvider;
  cwd?: string;
}

export interface SlashCommandsResponse {
  provider: RuntimeProvider;
  entries: SlashCommandEntry[];
  /** Discovery problems worth surfacing (unreadable SKILL.md etc.). */
  warnings: string[];
}
