import type { RuntimeProvider } from "./domain";

/**
 * How the hosted CLI reacts when this command is submitted through the PTY.
 * Probe evidence: research/2026-06-12-slash-command-systems-research.md.
 *
 * - "prompt": expands into a model turn (skills, /init, /review).
 * - "local": prints output locally; the model is not involved (/status, /diff).
 * - "panel": opens an interactive TUI panel. Blind injection leaves the panel
 *   open invisibly and subsequent pastes are swallowed by it (probe s1).
 * - "session": mutates session lifecycle or session-scoped state the CLI owns.
 */
export type SlashBehavior = "prompt" | "local" | "panel" | "session";

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
  behavior: SlashBehavior;
  description: string;
  /** e.g. "[instructions]" — shown as ghost text after the name. */
  argumentHint: string | null;
  scope: SlashScope;
  /**
   * Shown in the picker. Unlisted entries still count as "known" for the
   * submit guard, so typing them forwards without an unknown-command warning.
   */
  listed: boolean;
  /**
   * Selecting this entry opens the corresponding duet-native menu instead of
   * inserting text. The native menu drives the CLI's own picker via the
   * verified control choreography (applyControlChange), so the action stays
   * CLI-native — just operated by duet instead of blind-injected.
   */
  nativeMenu: "model" | "permission" | null;
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
