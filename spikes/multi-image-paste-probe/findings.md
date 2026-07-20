# Multi-image paste probe (2026-07-20)

## Scope

Probe target: the inferred CLI-side mechanics behind
`private/reports/2026-07-20-multi-image-paste-partial-attach.md`, before any
production edit.

- Claude Code: exact `2.1.214` package binary
- Codex CLI: exact `0.144.5` package binary
- PTY: `node-pty`, 160×50, mirrored through `@xterm/headless`
- Inputs: six valid noisy PNGs, separate bracketed-paste frames unless noted

| ordinal | dimensions | bytes |
| ---: | ---: | ---: |
| 1 | 64×64 | 12,420 |
| 2 | 128×128 | 49,363 |
| 3 | 256×256 | 196,992 |
| 4 | 384×384 | 442,955 |
| 5 | 512×512 | 787,252 |
| 6 | 768×768 | 1,770,845 |

`probe.mjs` is the reusable harness. It reads the rendered viewport, not the
linear raw PTY tail, so repaint duplicates do not inflate chip counts.

## Findings

### P1 — Claude conversion is asynchronous and completion time varies

Across clean Claude 2.1.214 sessions, first-render times for six back-to-back
frames were:

- run 1: `183, 193, 193, 193, 193, 193 ms`
- run 2: `179, 179, 179, 179, 203, 203 ms`
- run 3: `157, 181, 181, 181, 181, 181 ms`

The first chip can precede the remaining batch by 10–24 ms. Larger files did
not produce monotonically larger latency: conversion appears concurrent or
batched, so a per-file delay formula is not supported by the observation.

The clean probe did **not** reproduce the affected session's 260 ms partial
delivery: all six were rendered by 203 ms. That does not invalidate the race;
it shows the fixed 260 ms happens to win under this load and is not a bound.
The affected provider JSONL remains the hard evidence for the slower field
case.

### P2 — bytes can materialize after an Enter that saw an empty composer

On Claude, Enter at 133 ms rendered an empty composer at `enter+0`. At
`enter+240 ms`, the composer contained:

```text
[Image #1]SONATA_MID_CONVERSION_CLAUDE: reply exactly PROBE_OK.[Image #2] [Image #3] [Image #4] [Image #5] [Image #6]
```

The Enter was a no-op because the async paste/conversion effects had not
landed; all prompt text and all six chips arrived afterwards and remained in
the composer. This directly proves the late-materialization mechanic that
makes a post-attachment composer suspect.

A second run wrote Enter immediately after observing one rendered chip. The
CLI processed the remaining conversions before the Enter took effect and sent
all six. The narrow clean-session window therefore did not create a partial
provider message, but it confirms that write time is not effect time. The
affected JSONL proves the partial-submit + remainder case under real load.

Codex rendered all six in the first 15 ms sample and retained no composer
residue after the 130 ms submit. Its path conversion is materially faster in
this probe, but it uses the same image-marker surface and does not provide a
contractual synchronous acknowledgement.

### P3 — one frame containing N quoted paths is not an alternative wire

For both CLIs, one bracketed-paste frame containing six space-separated,
double-quoted paths produced **zero** image chips after 12 seconds. Both
composers held literal path text (wrapped into multiple visual lines).

Separate paste frames must remain.

## Decision against the diagnosis plan

The findings do not contradict the proposed fix design:

- Claude's clean latency is below 260 ms, but variable and asynchronous.
- File size does not justify an attachment-count or byte-count timing formula.
- A combined frame does not chip.
- Codex is faster, but effect verification is a safe provider-neutral gate.
- Late composer materialization is real, so the residue fence remains required.

Proceed with effect-verified Enter, bounded fallback, and the post-attachment
dirty fence. Report honest partial delivery from the provider transcript rather
than claiming the pre-submit scrape is a delivery receipt.
