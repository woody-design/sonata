# Duet

Duet is a hosted CLI agent workspace.

It preserves native CLI-agent behavior while building a reading-first,
task-oriented desktop experience around it. It is not a terminal skin, not an
IDE, and not a new agent runtime.

## Current Phase

Status: ready to start the formal walking skeleton.

The Codex runtime substrate has been proven by:

```text
spikes/electron-pty-terminalhost/
```

The next phase is a TypeScript Electron app skeleton that lifts that runtime
truth into Duet's Task / Run / Preview / Terminal model.

Start here:

```text
product-thinking/2026-05-15-duet-walking-skeleton-handoff.md
product-thinking/2026-05-15-terminalhost-runtime-contract.md
product-thinking/2026-05-14-duet-mvp-product-architecture.md
```

## Repository Map

```text
app/
  Formal TypeScript Electron app skeleton placeholder. The directory boundaries
  exist; implementation starts in the walking skeleton phase.

product-thinking/
  Current product architecture, runtime contracts, and phase handoffs.

decisions/
  Durable architecture decision records. Use this for decisions that should
  survive beyond one planning document.

research/
  External research, prior-art audits, and design/technical evidence.

spikes/
  Completed or active technical proofs. Spikes are material references, not
  production source.

archive/
  Superseded material that no longer participates in current reasoning.

ai-conversations/
  Historical conversation notes that may inform product direction.
```

## Working Rule

Product truth moves from research to spike to contract to app:

```text
research -> spikes -> product-thinking contracts -> app
```

Do not skip the direction of evidence. Spikes can prove material behavior, but
formal app code should encode only the resulting contract, not incidental spike
UI or temporary probe assumptions.
