# Duet App

This directory is reserved for the formal TypeScript Electron app.

It is intentionally not initialized yet. The next implementation phase should
start here after reading:

```text
product-thinking/2026-05-15-duet-walking-skeleton-handoff.md
product-thinking/2026-05-15-terminalhost-runtime-contract.md
```

## Intended Shape

```text
src/main/
  Electron lifecycle, IPC handlers, task/runtime orchestration.

src/preload/
  Typed renderer bridge.

src/renderer/
  Task shell, Run reading surface, Preview v0, Inspector v0, Terminal mirror.

src/runtime/
  TerminalHost, RunIndex, ArtifactPreview, provider adapters.

src/shared/
  Cross-process types and schema definitions.

tests/smoke/
  End-to-end checks against real runtime behavior.
```

## Boundary

The formal app should be TypeScript.

The spike code in `spikes/electron-pty-terminalhost/` is a reference for
runtime truth, not production UI. Lift the runtime boundary deliberately; do not
copy the spike renderer as product design.

The directories here are placeholders. Module names and the TypeScript
toolchain should be finalized when the walking skeleton implementation starts.
