import "./styles.css";

// Phase 1 scaffold: an empty terminal window shell — a peer satellite to the
// Preview and Inspector windows. The xterm view, per-task rendering, and the
// Aa theme picker arrive in later slices; for now this proves the window,
// its chrome, and its lifecycle. The topbar is drag-enabled and clears the
// hiddenInset traffic lights (see .terminal-window-topbar in styles.css).

const appElement = document.querySelector<HTMLDivElement>("#app");

if (!appElement) {
  throw new Error("Terminal window mount point was not found.");
}

appElement.innerHTML = `
  <section class="terminal-window-shell" aria-label="Duet Terminal">
    <header class="terminal-window-topbar">
      <p class="eyebrow">Terminal</p>
      <div class="terminal-window-topbar-actions"></div>
    </header>
    <section id="terminal-window-content" class="terminal-window-content">
      <p class="terminal-window-placeholder">Terminal view coming online…</p>
    </section>
  </section>
`;
