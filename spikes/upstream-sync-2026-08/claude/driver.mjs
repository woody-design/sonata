// Upstream-sync 2026-08 probe driver (claude 2.1.220).
// node-pty + @xterm/headless so captures carry BOTH rendered text AND cell
// attributes (inverse/fg/bg) + terminal cursor position — the legacy
// midsession-switch-probe driver stripped ANSI, which cannot answer "how is the
// focused row highlighted" or "does the cursor move to the focused row".
//
// Captures are sanitized ($HOME) before hitting disk — the pre-push leak fence
// scans blob content.
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";

const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");

const HOME = os.homedir();
export const sanitize = (s) => s.split(HOME).join("$HOME");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const KEYS = {
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  shiftTab: "\x1b[Z",
  down: "\x1b[B",
  up: "\x1b[A",
  ctrlC: "\x03",
  ctrlD: "\x04",
};

export class Probe {
  constructor({ cwd, cols = 120, rows = 40, rawPath, args = [], cmd = "claude" }) {
    this.raw = "";
    this.rawPath = rawPath;
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 4000 });
    const env = { ...process.env };
    // Do not let the child think it is nested inside an agent session.
    for (const k of Object.keys(env)) {
      if (/^(CLAUDE|ANTHROPIC_MODEL|AI_AGENT)/i.test(k)) delete env[k];
    }
    env.TERM = "xterm-256color";
    this.pty = pty.spawn(cmd, args, { name: "xterm-256color", cols, rows, cwd, env });
    this.pty.onData((d) => {
      this.raw += d;
      this.term.write(d);
    });
    this.exited = false;
    this.exitInfo = null;
    this.pty.onExit((e) => {
      this.exited = true;
      this.exitInfo = e;
    });
  }

  write(s) {
    this.pty.write(s);
  }

  async type(text, perCharMs = 30) {
    for (const ch of text) {
      this.write(ch);
      await sleep(perCharMs);
    }
  }

  /** Deliver text the way a GUI paste does: bracketed-paste wrapped, one write. */
  paste(text) {
    this.write(`\x1b[200~${text}\x1b[201~`);
  }

  /** Plain rendered screen text, trailing blank lines trimmed. */
  screen() {
    const b = this.term.buffer.active;
    const lines = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = b.getLine(b.viewportY + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join("\n");
  }

  cursor() {
    const b = this.term.buffer.active;
    return { x: b.cursorX, y: b.cursorY };
  }

  /** Per-row attribute digest: which rows carry inverse cells / non-default bg /
   *  non-default fg, with the run of text carrying it. */
  attrRows() {
    const b = this.term.buffer.active;
    const out = [];
    const cell = b.getNullCell ? b.getNullCell() : undefined;
    for (let y = 0; y < this.term.rows; y++) {
      const line = b.getLine(b.viewportY + y);
      if (!line) continue;
      const text = line.translateToString(true);
      const marks = [];
      let cur = null;
      for (let x = 0; x < this.term.cols; x++) {
        const c = line.getCell(x, cell);
        if (!c) continue;
        const inv = c.isInverse() ? 1 : 0;
        const bg = c.isBgDefault() ? null : c.getBgColor();
        const bgMode = c.isBgDefault() ? "" : c.isBgPalette() ? "p" : c.isBgRGB() ? "rgb" : "?";
        const fg = c.isFgDefault() ? null : c.getFgColor();
        const fgMode = c.isFgDefault() ? "" : c.isFgPalette() ? "p" : c.isFgRGB() ? "rgb" : "?";
        const bold = c.isBold() ? 1 : 0;
        const dim = c.isDim() ? 1 : 0;
        const key = `inv=${inv} bg=${bgMode}${bg ?? "-"} fg=${fgMode}${fg ?? "-"} b=${bold} d=${dim}`;
        const isPlain = !inv && bg === null && fg === null && !bold && !dim;
        if (isPlain) {
          if (cur) { marks.push(cur); cur = null; }
          continue;
        }
        if (cur && cur.key === key && cur.end === x) {
          cur.end = x + 1;
          cur.chars += c.getChars() || " ";
        } else {
          if (cur) marks.push(cur);
          cur = { key, start: x, end: x + 1, chars: c.getChars() || " " };
        }
      }
      if (cur) marks.push(cur);
      if (marks.length) out.push({ y, text, marks });
    }
    return out;
  }

  /** Wait until `re` matches the rendered screen (or the accumulated raw). */
  async waitFor(re, timeoutMs = 60_000, { onRaw = false } = {}) {
    const rx = re instanceof RegExp ? re : new RegExp(re, "i");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (rx.test(onRaw ? this.raw : this.screen())) return true;
      if (this.exited) return false;
      await sleep(100);
    }
    return false;
  }

  kill() {
    try { this.pty.kill(); } catch { /* already gone */ }
  }
}

/** Spawn claude with Sonata's own arg shape and reach a live idle composer.
 *  Answers the workspace-trust dialog with row 1 ONLY when it appears — the
 *  scratch dir is granted trust once, then reused by later probes. */
export async function bootTrusted(cwd, cap, { extraArgs = [] } = {}) {
  const p = new Probe({ cwd, args: ["--permission-mode", "default", ...extraArgs] });
  const trust = await p.waitFor(/Quick safety check/i, 45_000);
  if (trust) {
    if (cap) cap.frame(p, "boot — trust dialog (granting row 1 for this scratch dir)");
    p.write(KEYS.enter);
    await sleep(1500);
  }
  const ok = await p.waitFor(/for shortcuts|Welcome back|Try "|>\s*$/i, 60_000);
  if (cap) cap.add("boot — reached composer?", `${ok} (trustDialogSeen=${trust})`);
  await sleep(2500);
  return p;
}

export class Capture {
  constructor(path, title) {
    this.path = path;
    this.parts = [`# ${title}`, `# claude version: (see findings.md)  captured ${new Date().toISOString()}`, ""];
  }
  add(section, body) {
    this.parts.push(`===== ${section} =====`, body, "");
  }
  frame(probe, label, { attrs = false } = {}) {
    const c = probe.cursor();
    let body = `[cursor] x=${c.x} y=${c.y}\n--- screen ---\n${probe.screen()}`;
    if (attrs) {
      const rows = probe.attrRows();
      const dump = rows
        .map((r) => `  y=${String(r.y).padStart(2)} | ${r.text}\n` + r.marks.map((m) => `        cols ${m.start}-${m.end} ${m.key} :: ${JSON.stringify(m.chars)}`).join("\n"))
        .join("\n");
      body += `\n--- styled cells ---\n${dump || "  (none)"}`;
    }
    this.add(label, body);
  }
  addRaw(section, raw) {
    this.add(section, JSON.stringify(raw));
  }
  save() {
    fs.writeFileSync(this.path, sanitize(this.parts.join("\n")));
    console.log(`wrote ${this.path}`);
  }
}
