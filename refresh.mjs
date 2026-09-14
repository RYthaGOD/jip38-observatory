// Refresh the dashboard: read the chain, rebuild the page.
//
//   node refresh.mjs [--skip-verify]
//
// The cross-platform refresh, and the one Railway runs. refresh.cmd does the
// same work on the Windows box, plus a step that only exists there: republishing
// the Claude Artifact.
//
// ---------------------------------------------------------------------------
// WHY PUBLISHING DISAPPEARS ON RAILWAY
//
// On the Windows box the built page still has to be pushed somewhere else, and
// that push is the fragile part — it needs a tool that a headless session may
// not have, and a build that never reached the public looked exactly like a
// successful run until release.mjs started checking.
//
// Railway removes the step rather than making it more reliable. The server
// reads dist/dashboard.html on each request and re-reads it when its mtime
// changes, and build-dashboard.mjs writes that file atomically. So the moment
// the build completes, the site is serving it. There is no publish to verify
// because there is no publish: the artifact that was built IS the artifact that
// is served, on the same disk.
//
// Which makes this the honest ordering: every gate runs BEFORE the chain is
// read, so a tree whose tests fail cannot produce a page at all.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";


const SKIP_VERIFY = process.argv.includes("--skip-verify");
const started = Date.now();

const steps = [
  ["offline checks", ["check.mjs"], true],
  // Re-tests every REGISTRY.tsv role against chain. Needs the RPC key, and is
  // the gate that stops a figure being published on an address that has
  // stopped behaving as recorded.
  ["registry verification", ["verify.mjs", "--quiet"], !SKIP_VERIFY],
  ["read chain", ["snapshot.mjs"], true],
  ["rebuild page", ["build-dashboard.mjs"], true],
];

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

for (const [name, argv, enabled] of steps) {
  if (!enabled) { console.log(`[${stamp()}] SKIPPED ${name}`); continue; }
  console.log(`[${stamp()}] ${name}...`);
  const r = spawnSync(process.execPath, argv, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[${stamp()}] FAILED at "${name}" (exit ${r.status}).`);
    console.error("The previously built page is untouched and is still being served.");
    process.exit(r.status || 1);
  }
}

// Not a publish check — the Artifact is retired to a pointer and nothing is
// published to it. What can still drift is the pointer page itself, edited
// without being republished, and release.mjs status reports exactly that.
const rel = spawnSync(process.execPath, ["release.mjs", "status"], { encoding: "utf8" });
if (rel.status !== 0) {
  console.log(`\n[${stamp()}] note: release.mjs status reports a problem with the Artifact pointer:`);
  console.log(rel.stdout.split("\n").filter((l) => /STALE|NOT PUBLISHED/.test(l)).join("\n") || "  (run node release.mjs status)");
  console.log("The page built here is unaffected and is being served.");
}

console.log(`\n[${stamp()}] done in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
console.log("The server re-reads the page on its next request; no restart is needed.");
