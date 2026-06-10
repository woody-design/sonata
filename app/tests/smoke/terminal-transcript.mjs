import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { cleanTerminalTranscript } = require("../../dist/shared/terminal-transcript");
const { extractProviderErrorExcerpt } = require("../../dist/runtime/terminal-host/index");

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

const cjkCursorOutput = [
  "\x1b[24;1H批",
  "\x1b[24;3H准",
  "\x1b[24;5H不",
  "\x1b[24;7H能",
  "\x1b[24;9H把",
  "\x1b[24;11Hclaude.ai",
  "\x1b[24;20H登",
  "\x1b[24;22H录",
  "\x1b[24;24H/",
  "\x1b[24;25H订",
  "\x1b[24;27H阅",
  "\x1b[24;29H额",
  "\x1b[24;31H度",
  "\x1b[24;33H作",
  "\x1b[24;35H为",
  "\x1b[24;37H产",
  "\x1b[24;39H品",
  "\x1b[24;41H入",
  "\x1b[24;43H口",
  "\x1b[24;45H，",
  "\x1b[24;47H应",
  "\x1b[24;49H该",
  "\x1b[24;51H用",
  "\x1b[24;53HAPI",
  "\x1b[24;57H key。",
  "\x1b[25;69HBusiness Insider",
].join("");

const cleanChrome = cleanTerminalTranscript(claudeChrome, "claude");
const cleanNormal = cleanTerminalTranscript(normalAnswer, "claude");
const cleanMixed = cleanTerminalTranscript(mixed, "claude");
const cleanCodexShort = cleanTerminalTranscript("OK\nNo\n", "codex");
const cleanCjkCursorOutput = cleanTerminalTranscript(cjkCursorOutput, "claude");
const providerErrorExcerpt = extractProviderErrorExcerpt(
  [
    "\x1b[31mAPI Error (Internal server error) · Retrying in 8 seconds…\x1b[0m",
    "API Error (Internal server error) · Retrying in 16 seconds…",
    "API Error (Internal server error) · Retrying in 32 seconds…",
    "❯",
  ].join("\n"),
  "claude",
);
const cleanProviderErrorExcerpt = extractProviderErrorExcerpt(
  ["Here is the result:", "Created transcript.md in the selected folder.", "❯"].join("\n"),
  "claude",
);

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
  cleanCodexShort.includes("No") &&
  cleanCjkCursorOutput.includes("批准不能把claude.ai登录/订阅额度作为产品入口，应该用API key。Business Insider") &&
  !cleanCjkCursorOutput.includes("25;69H") &&
  cleanCjkCursorOutput.split("\n").length <= 2 &&
  providerErrorExcerpt ===
    [
      "API Error (Internal server error) · Retrying in 8 seconds…",
      "API Error (Internal server error) · Retrying in 16 seconds…",
      "API Error (Internal server error) · Retrying in 32 seconds…",
    ].join("\n") &&
  cleanProviderErrorExcerpt === null;

console.log(
  JSON.stringify(
    {
      cleanChrome,
      cleanNormal,
      cleanMixed,
      cleanCodexShort,
      cleanCjkCursorOutput,
      providerErrorExcerpt,
      cleanProviderErrorExcerpt,
      success,
    },
    null,
    2,
  ),
);

process.exitCode = success ? 0 : 1;
