import "./styles.css";

const appElement = document.querySelector<HTMLDivElement>("#app");

if (!appElement) {
  throw new Error("Renderer mount point was not found.");
}

appElement.innerHTML = `
  <section class="shell" aria-label="Duet walking skeleton">
    <header class="topbar">
      <div>
        <p class="eyebrow">Duet</p>
        <h1>Formal walking skeleton</h1>
      </div>
      <span class="status">Runtime not connected</span>
    </header>

    <section class="workspace">
      <aside class="task-pane" aria-label="Task">
        <button class="primary" type="button" disabled>New Task</button>
        <div class="task-placeholder">
          <strong>No active Task</strong>
          <span>The next slice will attach a real Codex PTY through TerminalHost.</span>
        </div>
      </aside>

      <section class="run-surface" aria-label="Run reading surface">
        <article class="run-card">
          <p class="eyebrow">Run surface</p>
          <h2>Semantic app shell is ready</h2>
          <p>
            This renderer is intentionally plain. It exists to verify the
            formal process boundary before TerminalHost is lifted from the
            spike.
          </p>
        </article>
      </section>
    </section>
  </section>
`;
