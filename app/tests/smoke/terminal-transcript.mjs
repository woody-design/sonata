import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { cleanTerminalTranscript } = require("../../dist/shared/terminal-transcript");

const claudeChrome = [
  "\x1b[?25l\x1b[2J\x1b[1;1H❯",
  "\x1b[12;4Hpaste\x1b[12;8Hagain\x1b[12;13Hto\x1b[12;15Hexpand",
  "\x1b[13;1HN",
  "\x1b[14;1He",
  "\x1b[15;1Hb",
  "\x1b[16;1HNu",
  "\x1b[17;1H*ebli",
  "\x1b[18;1Huz",
  "\x1b[19;1Hli",
  "\x1b[20;1H*izng",
].join("\n");

const normalAnswer = [
  "\x1b[32mHere is the result:\x1b[0m",
  "DUET_TRANSCRIPT_VISIBLE artifact ready.",
  "Created transcript.md in the selected folder.",
].join("\r\n");

const mixed = [
  "esc to interrupt",
  "thinking with opus",
  "The selected folder is now the provider cwd.",
  "Use Inspector to review changed files.",
].join("\n");

const cleanChrome = cleanTerminalTranscript(claudeChrome, "claude");
const cleanNormal = cleanTerminalTranscript(normalAnswer, "claude");
const cleanMixed = cleanTerminalTranscript(mixed, "claude");
const cleanCodexShort = cleanTerminalTranscript("OK\nNo\n", "codex");

const success =
  cleanChrome.trim() === "" &&
  cleanNormal.includes("DUET_TRANSCRIPT_VISIBLE artifact ready.") &&
  cleanNormal.includes("Created transcript.md in the selected folder.") &&
  !cleanNormal.includes("\u001b") &&
  !cleanMixed.includes("esc to interrupt") &&
  !cleanMixed.includes("thinking with opus") &&
  cleanMixed.includes("The selected folder is now the provider cwd.") &&
  cleanMixed.includes("Use Inspector to review changed files.") &&
  cleanCodexShort.includes("OK") &&
  cleanCodexShort.includes("No");

console.log(
  JSON.stringify(
    {
      cleanChrome,
      cleanNormal,
      cleanMixed,
      cleanCodexShort,
      success,
    },
    null,
    2,
  ),
);

process.exitCode = success ? 0 : 1;
