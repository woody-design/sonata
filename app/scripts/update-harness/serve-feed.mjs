// Static file server for the auto-update end-to-end harness (S4).
//
// Serves the staged "feed" directory (latest-mac.yml + the v2 ZIP + its
// .blockmap) to electron-updater's generic provider over plain HTTP on
// 127.0.0.1. This is the upstream feed the harness app points at via
// SONATA_UPDATE_FEED_URL — electron-updater downloads the full ZIP from here,
// then runs its OWN localhost proxy to hand the bytes to Squirrel.Mac.
//
// Design notes:
//   - Ephemeral port by default (listen on 0) so it can never collide; pass a
//     port as arg2 (or SONATA_HARNESS_PORT) to pin one. The chosen port is
//     printed as "LISTENING http://127.0.0.1:<port>" and written to
//     HARNESS_PORT_FILE if set — the shell reads it back.
//   - Range requests (206) are supported so the differential-download path can
//     at least be *attempted*; a first-install harness has no cached previous
//     blockmap, so electron-updater silently falls back to a full 200 download.
//     Both are correct and both are logged.
//   - Every request is logged (method, path, status, range) to stdout so the
//     download shows up as evidence in the server log.
//   - Path traversal is refused: only files resolving inside the feed dir are
//     served.
//
// Usage: node serve-feed.mjs <feedDir> [port]

import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { appendFileSync } from "node:fs";

const feedDir = path.resolve(process.argv[2] ?? "");
const requestedPort = Number(process.argv[3] ?? process.env.SONATA_HARNESS_PORT ?? 0) || 0;
const portFile = process.env.HARNESS_PORT_FILE;

if (!feedDir || !statSync(feedDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`serve-feed: feed dir not found or not a directory: ${feedDir}`);
  process.exit(1);
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function contentType(file) {
  if (file.endsWith(".yml") || file.endsWith(".yaml")) return "text/yaml; charset=utf-8";
  if (file.endsWith(".zip")) return "application/zip";
  if (file.endsWith(".blockmap")) return "application/octet-stream";
  return "application/octet-stream";
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const target = path.resolve(feedDir, rel);

  // Refuse anything that escapes the feed dir.
  if (target !== feedDir && !target.startsWith(feedDir + path.sep)) {
    res.writeHead(403).end("forbidden");
    console.log(`${stamp()}  ${req.method}  ${rel}  -> 403 (traversal)`);
    return;
  }

  const info = statSync(target, { throwIfNoEntry: false });
  if (!info || !info.isFile()) {
    res.writeHead(404).end("not found");
    console.log(`${stamp()}  ${req.method}  ${rel}  -> 404`);
    return;
  }

  const total = info.size;
  const headers = {
    "Content-Type": contentType(target),
    "Accept-Ranges": "bytes",
  };

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === "" ? 0 : Number(m[1]);
      let end = m[2] === "" ? total - 1 : Number(m[2]);
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
        console.log(`${stamp()}  ${req.method}  ${rel}  range=${range}  -> 416`);
        return;
      }
      headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
      headers["Content-Length"] = String(end - start + 1);
      res.writeHead(206, headers);
      console.log(`${stamp()}  ${req.method}  ${rel}  range=${range}  -> 206 (${end - start + 1}/${total})`);
      if (req.method === "HEAD") return res.end();
      createReadStream(target, { start, end }).pipe(res);
      return;
    }
  }

  headers["Content-Length"] = String(total);
  res.writeHead(200, headers);
  console.log(`${stamp()}  ${req.method}  ${rel}  -> 200 (${total})`);
  if (req.method === "HEAD") return res.end();
  createReadStream(target).pipe(res);
});

server.on("error", (err) => {
  console.error(`serve-feed: ${err.message}`);
  process.exit(1);
});

server.listen(requestedPort, "127.0.0.1", () => {
  const { port } = server.address();
  const line = `LISTENING http://127.0.0.1:${port}`;
  console.log(`${stamp()}  ${line}  (feed: ${feedDir})`);
  if (portFile) {
    try {
      appendFileSync(portFile, String(port));
    } catch (err) {
      console.error(`serve-feed: could not write port file ${portFile}: ${err.message}`);
    }
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`${stamp()}  ${sig} — shutting down feed server`);
    server.close(() => process.exit(0));
    // Don't wait forever on lingering sockets.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
