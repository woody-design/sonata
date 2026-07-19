import path from "node:path";

/**
 * Map a path that resolves INSIDE the packed `app.asar` archive to its real
 * on-disk twin under `app.asar.unpacked`.
 *
 * Why this exists: our runtime settings files embed `node <script>` commands
 * that the provider CLIs run via a SEPARATE, external `node` process. That node
 * has no Electron asar shim, so it cannot read anything inside `app.asar` —
 * a command pointing at `.../app.asar/dist/runtime/.../hook-sink.js` fails with
 * MODULE_NOT_FOUND. The scripts ARE unpacked to disk (electron-builder
 * `asarUnpack`), but Electron keeps `__dirname` as the LOGICAL `app.asar` path
 * for its own process, so `path.join(__dirname, "hook-sink.js")` still names the
 * archive path. This helper rewrites that one path segment so the string we hand
 * to external `node` points at the unpacked file that actually exists on disk.
 *
 * It is a deliberate no-op everywhere else:
 * - dev / source-tree runs (`dist/runtime/...` with no `app.asar` segment) are
 *   returned unchanged;
 * - a path already under `app.asar.unpacked` is returned unchanged (idempotent).
 *
 * Cross-checked in a packaged build: the `app.asar` form is unreadable by
 * external node (MODULE_NOT_FOUND); the rewritten `app.asar.unpacked` form runs
 * (exit 0, payload written).
 */
export function asarUnpackedPath(filePath: string): string {
  const unpackedSegment = `app.asar.unpacked${path.sep}`;
  if (filePath.includes(unpackedSegment)) {
    // Already unpacked — idempotent.
    return filePath;
  }

  const packedSegment = `app.asar${path.sep}`;
  const index = filePath.indexOf(packedSegment);
  if (index === -1) {
    // Not inside an asar archive (dev / source tree) — leave it untouched.
    return filePath;
  }

  return (
    filePath.slice(0, index) +
    unpackedSegment +
    filePath.slice(index + packedSegment.length)
  );
}
