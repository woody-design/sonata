#!/usr/bin/env python3
"""Static string probe of the REAL codex-cli 0.146.0 Mach-O binary.

FALLBACK EVIDENCE ONLY. S1's primary method is a live node-pty capture
(driver.mjs); that path is blocked because the isolated CODEX_HOME has no
credentials and seeding them was denied by the permission classifier (see
findings.md, "Environment block"). This script extracts what the shipped
binary can prove on its own: which UI literals exist, which are gone, and
which are format strings assembled at runtime.

Caveat that governs every reading below: Rust pools identical string literals
and lays them out in one contiguous blob, so ADJACENCY IS NOT LAYOUT. A hit
proves the literal ships; it does not prove which row, level, or frame renders
it. Absence of a contiguous literal is the stronger signal (it means no code
path can print that exact text) — but it does not rule out runtime assembly
from fragments.

Usage: python3 binary-probe.py [path-to-codex] > capture-binary-strings.txt
"""

import os
import re
import sys

BIN = sys.argv[1] if len(sys.argv) > 1 else "/opt/homebrew/bin/codex"

# Sanitize personal markers out of anything we print (pre-push leak fence
# scans blob content).
SANITIZE = [(re.compile(re.escape(os.path.expanduser("~"))), "$HOME"), (re.compile(r"/Users/[a-z]+"), "$HOME")]


def clean(text: str) -> str:
    for pattern, replacement in SANITIZE:
        text = pattern.sub(replacement, text)
    return "".join(ch if ch.isprintable() or ch == "\n" else "·" for ch in text)


data = open(BIN, "rb").read()
print(f"# binary: {clean(os.path.realpath(BIN))}  size={len(data)}")


def presence(label: str, needles: "list[str]") -> None:
    print(f"\n===== PRESENCE: {label} =====")
    for needle in needles:
        found = data.find(needle.encode()) >= 0
        print(f"{'FOUND ' if found else 'ABSENT'}  {needle!r}")


def context(needle: str, before: int = 300, after: int = 400, limit: int = 3) -> None:
    print(f"\n===== CONTEXT: {needle!r} =====")
    raw = needle.encode()
    start = 0
    seen = 0
    while seen < limit:
        i = data.find(raw, start)
        if i < 0:
            if seen == 0:
                print("  <NOT FOUND>")
            break
        seg = data[max(0, i - before) : i + len(raw) + after].decode("utf-8", "replace")
        print(f"--- offset {i} ---\n{clean(seg)}")
        start = i + 1
        seen += 1


# ── Q1 / F1 — full-access consent dialog ────────────────────────────────────
presence(
    "Q1 full-access consent",
    [
        "Enable full access?",
        "Yes, continue anyway",
        "Apply full access for this session",
        "Go back without enabling full access",
        "Cancel",
        "hide_full_access_warning",
    ],
)
context("Enable full access?", 60, 460, 1)
# Every surviving "Yes, and don't ask again" must carry an approval-specific
# suffix; a BARE one would mean the deleted consent row still ships.
context("Yes, and don't ask again", 200, 260, 6)

# ── Q2 / X1 — /model picker depth ───────────────────────────────────────────
presence(
    "Q2 /model picker",
    [
        "Select Model",  # L1 header (four-level shape)
        "Pick a quick auto mode or browse all models.",  # L1 subtitle
        "All models",  # L1 escape row
        "Choose a specific model and reasoning level (current: ",  # "All models" row desc
        "Select Model and Effort",  # L2 header (== the two-level shape's L1)
        "No additional models are available right now.",
        "Access legacy models by running codex -m <model_name> or in your config.toml",
        "Select Reasoning Level for ",  # L3 header
        "More reasoning",  # L3 -> L4 row
        "Advanced Reasoning",  # L4 header
        "advanced choices are limited to Max and Ultra",
        "Extra high",
        "(current)",
        "(default)",
        # Auto-mode slugs as CONTIGUOUS literals — absent means catalog-built.
        "codex-auto-fast",
        "codex-auto-balanced",
        "codex-auto-thorough",
        "codex-auto-",
        # A possible EXTRA level after the reasoning choice (apply-scope).
        "Apply reasoning change",
        "Choose where to apply ",
        "Apply to Plan mode override",
        "Apply to global default and Plan mode override",
        "Set the global default reasoning level and the Plan mode override.",
        # Receipts Sonata parses.
        "Model changed to ",
        "Permissions updated to ",
    ],
)
context("Pick a quick auto mode", 1200, 900, 1)
context("Select Reasoning Level for ", 420, 640, 1)

# ── Q3 / F2 — Ultra composer glyph + MAX/ULTRA badge ────────────────────────
print("\n===== GLYPH COUNTS =====")
for glyph, name in [("»", "» U+00BB"), ("›", "› U+203A"), ("•", "• U+2022")]:
    hits = []
    start = 0
    while True:
        i = data.find(glyph.encode(), start)
        if i < 0:
            break
        hits.append(i)
        start = i + 1
    tui = [i for i in hits if 194_000_000 < i < 201_500_000]
    print(f"{name}: total={len(hits)}  in-TUI-literal-range={len(tui)}  offsets={tui}")
context("✦✧MAXULTRA", 260, 200, 1)  # ✦✧MAXULTRA badge literals

# ── Q4 / W2 — status indicator + activity hints ─────────────────────────────
presence(
    "Q4 activity hints (Sonata: activityHints = ['working', 'esc to interrupt'])",
    [
        "esc to interrupt",
        "Esc to interrupt",
        " to interrupt",  # format string: "{} to interrupt"
        "Working",
        "Thinking",
        "for shortcuts",
    ],
)
context(" to interrupt", 260, 200, 4)

# ── Q5 — trust dialog + trust_level serialization ───────────────────────────
presence(
    "Q5 trust dialog (Sonata bootDialogHints)",
    [
        "Do you trust the contents of this directory?",
        "Yes, continue",
        "No, quit",
        "Press enter to continue",
        "to continue and create a sandbox",
        'projects."',
        "trust_level",
    ],
)
context("Do you trust", 40, 420, 1)
context('projects."', 200, 200, 2)
context("› ", 200, 200, 9)  # picker cursor row format strings
