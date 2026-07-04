import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Pure-JS smoke: the session-truth store is a plain class over an injected
// JSON store, so it runs under node with a fake store — no electron.
const { PreviewSessions } = require("../../dist/main/preview-sessions");

const failures = [];
const check = (name, cond, detail) => {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const paths = (session) => session.tabs.map((tab) => tab.path);

/** A JsonSettingsStore stand-in: last written doc is the read doc. */
function fakeStore(initial = { sessions: {} }) {
  let doc = initial;
  return {
    read: () => doc,
    write: (next) => {
      doc = next;
      return next;
    },
    current: () => doc,
  };
}

const A = "task-A";

// 1) open / dedup / active + MRU seeding on open
{
  const store = fakeStore();
  const s = new PreviewSessions(store);
  s.open(A, "a");
  s.open(A, "b");
  s.open(A, "a"); // dedup: focuses, no second slot
  const session = s.session(A);
  check("open-order", JSON.stringify(paths(session)) === JSON.stringify(["a", "b"]), JSON.stringify(paths(session)));
  check("dedup-active", session.activePath === "a", session.activePath);
}

// 2) close a non-active tab keeps the active one
{
  const s = new PreviewSessions(fakeStore());
  s.open(A, "a");
  s.open(A, "b"); // active b
  s.close(A, "a");
  const session = s.session(A);
  check("close-nonactive-keeps-active", session.activePath === "b", session.activePath);
  check("close-nonactive-tabs", JSON.stringify(paths(session)) === JSON.stringify(["b"]));
}

// 3) MRU: closing the active tab activates the most-recently-used survivor,
//    not the strip neighbor.
{
  const s = new PreviewSessions(fakeStore());
  for (const p of ["a", "b", "c", "d"]) s.open(A, p);
  s.activate(A, "b");
  s.activate(A, "d"); // active d; MRU: d,b,c,a
  s.close(A, "d"); // d's neighbor is c; MRU winner is b (non-adjacent)
  check("mru-after-close-active", s.session(A).activePath === "b", s.session(A).activePath);
}

// 4) scroll is recorded and dropped with its tab
{
  const s = new PreviewSessions(fakeStore());
  s.open(A, "a");
  s.open(A, "b");
  s.setScroll(A, "a", 240);
  check("scroll-recorded", s.session(A).scroll.a === 240);
  s.setScroll(A, "ghost", 10); // no such tab → ignored
  check("scroll-ignores-unknown", s.session(A).scroll.ghost === undefined);
  s.close(A, "a");
  check("scroll-dropped-on-close", s.session(A).scroll.a === undefined);
}

// 5) reorder to a permutation; a stale/short list preserves omitted tabs
{
  const s = new PreviewSessions(fakeStore());
  for (const p of ["a", "b", "c"]) s.open(A, p);
  s.reorder(A, ["c", "a", "b"]);
  check("reorder", JSON.stringify(paths(s.session(A))) === JSON.stringify(["c", "a", "b"]));
  s.reorder(A, ["b"]); // omits a,c → they stay, appended
  check("reorder-preserves-omitted", JSON.stringify(paths(s.session(A))) === JSON.stringify(["b", "c", "a"]));
}

// 6) panel flag persists a claim even with no tabs; a fully-empty session is
//    dropped as housekeeping.
{
  const store = fakeStore();
  const s = new PreviewSessions(store);
  s.setPanel(A, true);
  check("panel-only-persists", s.hasSession(A) === true);
  s.setPanel(A, false);
  check("empty-session-dropped", s.hasSession(A) === false);
}

// 7) forget is the ONLY intentional claim removal (close/archive keep; delete
//    forgets — R1 amended 2026-07-04). forget clears the task.
{
  const s = new PreviewSessions(fakeStore());
  s.open(A, "a");
  s.open(A, "b");
  check("has-before-forget", s.hasSession(A) === true);
  s.forget(A);
  check("forget-clears", s.hasSession(A) === false);
  check("forget-empty-session", JSON.stringify(paths(s.session(A))) === "[]");
}

// 8) restore across "restart": a store preloaded with a session re-projects,
//    and MRU re-seeds active-first so the first close-active is sensible.
{
  const doc = {
    sessions: {
      [A]: {
        taskId: A,
        tabs: [{ path: "x" }, { path: "y" }, { path: "z" }],
        activePath: "y",
        scroll: { y: 55 },
        panelOpen: true,
      },
    },
  };
  const s = new PreviewSessions(fakeStore(doc));
  const restored = s.session(A);
  check("restore-tabs", JSON.stringify(paths(restored)) === JSON.stringify(["x", "y", "z"]));
  check("restore-active", restored.activePath === "y");
  check("restore-scroll", restored.scroll.y === 55);
  check("restore-panel", restored.panelOpen === true);
  s.close(A, "y"); // MRU seeded [y,x,z] → after y removed, winner x
  check("restore-mru-seed", s.session(A).activePath === "x", s.session(A).activePath);
}

// 9) persistence: a mutation writes the doc back through the store
{
  const store = fakeStore();
  const s = new PreviewSessions(store);
  s.open(A, "a");
  s.flush();
  check("persist-writes-store", store.current().sessions[A]?.tabs?.[0]?.path === "a");
  s.forget(A);
  s.flush();
  check("persist-forget-writes", store.current().sessions[A] === undefined);
}

console.log(JSON.stringify({ suite: "preview-sessions", failures, ok: failures.length === 0 }, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
