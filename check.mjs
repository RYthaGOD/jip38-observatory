// One offline check. No network, no RPC key, no chain.
//
//   node check.mjs
//
// This is the gate. Everything it runs is deterministic and offline, so it can
// be run on a clean checkout, in CI, or before a release without a credential
// and without touching the chain.
//
// Exit status is the point:
//   0  every suite passed
//   1  at least one suite failed — nothing should be published
//   2  the environment cannot run the suites
//
// What it does NOT establish: that the chain-facing behaviour is correct
// against mainnet. That is what `node verify.mjs` is for, and it needs a key.

import { spawnSync } from "node:child_process";

// process.loadEnvFile and several of the language features used throughout
// require Node 22. Stated here rather than discovered as a confusing crash.
const MIN_NODE = 22;
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < MIN_NODE) {
  console.error(`check: Node ${MIN_NODE}+ required, found ${process.versions.node}`);
  process.exit(2);
}

const SUITES = [
  ["test.mjs", "pure logic in lib.mjs — arithmetic, coverage, registry parsing"],
  ["test-core.mjs", "core.mjs and rpc.mjs — exact amounts, fail-closed reads, atomic writes"],
  ["test-pipeline.mjs", "verify/track/rawscan/discover — the audit's data-integrity findings"],
  ["test-dashboard.mjs", "the dashboard builder — schema validation, escaping, last-valid retention"],
  ["test-server.mjs", "the public server — route allowlist, CSP hashes, security headers"],
];

console.log(`node ${process.versions.node}\n`);

let failedSuites = 0, totalPassed = 0, totalFailed = 0;
for (const [file, what] of SUITES) {
  console.log(`\n=== ${file} — ${what}`);
  // Captured rather than inherited, so the totals can be tallied. A count
  // written into the README by hand is a count that quietly goes stale.
  const r = spawnSync(process.execPath, [file], { encoding: "utf8" });
  process.stdout.write(r.stdout ?? "");
  if (r.stderr) process.stderr.write(r.stderr);
  const tally = /(\d+) passed, (\d+) failed/.exec(r.stdout ?? "");
  if (tally) { totalPassed += Number(tally[1]); totalFailed += Number(tally[2]); }
  if (r.status !== 0) { failedSuites++; console.log(`--- ${file} FAILED (exit ${r.status})`); }
}

console.log("\n" + "=".repeat(72));
if (failedSuites) {
  console.log(`${failedSuites} of ${SUITES.length} suites FAILED — ${totalFailed} failing check(s).`);
  console.log("Nothing should be published from this tree until they pass.");
} else {
  console.log(`All ${SUITES.length} offline suites passed — ${totalPassed} checks.`);
  console.log("This does NOT establish chain-facing correctness — run verify.mjs for that.");
}
console.log("=".repeat(72));
process.exit(failedSuites ? 1 : 0);
