// Post-hoc session-link redaction for the SL-11 captures.
//
// The 2026-08 `Capture` sanitizes $HOME and nothing else, so a rendered frame
// keeps whatever the screen showed — and an RC frame is exactly where a live
// `claude.ai/code/session_…` link lives. The probes redact their own JSON
// verdicts; this pass finishes the job on the frame bodies, so the whole SL-11
// capture set is uniform.
//
// Each DISTINCT id is replaced by a stable per-file token (`session_<A>`,
// `session_<B>`, …) rather than a single blanket placeholder: several findings
// turn on whether two links are the SAME session (rc6 asks precisely that), and
// a blanket redaction would erase the evidence along with the value.
//
// Idempotent — re-running finds nothing left to replace.
import fs from "node:fs";
import path from "node:path";

const DIR = new URL(".", import.meta.url).pathname;
// 8+ chars: the real ids are ~24, and this cannot collide with an already
// redacted `session_<A>` (the `<` is outside the class).
const ID_RE = /session_[A-Za-z0-9_-]{8,}/g;
const token = (i) => {
  let name = "";
  let n = i;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `session_<${name}>`;
};

const report = [];
for (const file of fs.readdirSync(DIR).filter((f) => /^rc\d.*\.capture\.txt$/.test(f))) {
  const full = path.join(DIR, file);
  const text = fs.readFileSync(full, "utf8");
  const ids = [...new Set(text.match(ID_RE) ?? [])];
  if (ids.length === 0) {
    report.push({ file, redacted: 0 });
    continue;
  }
  const map = new Map(ids.map((id, i) => [id, token(i)]));
  fs.writeFileSync(full, text.replace(ID_RE, (m) => map.get(m) ?? m));
  report.push({ file, redacted: ids.length });
}
console.log(JSON.stringify(report, null, 2));
