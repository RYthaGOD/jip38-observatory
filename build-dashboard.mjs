// Build the published dashboard from the template and the current snapshot.
//
//   node snapshot.mjs && node build-dashboard.mjs
//
// The page is static by design. An Artifact cannot make network calls, so it
// could never query Solana itself; and declaring the `db` capability — which
// would let figures be updated without republishing — makes an artifact
// organization-internal and unshareable publicly. For a project whose whole
// point is public verification, that is the wrong trade. So the chain is read
// here, baked in, and the page is republished to update it.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const tpl = readFileSync("dashboard.template.html", "utf8");
const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"));

// Guard the closing-tag sequence so the JSON cannot break out of the <script>
// block it is embedded in.
const json = JSON.stringify(snap).replace(/<\//g, "<\\/");

if (!tpl.includes("__SNAPSHOT_JSON__")) {
  console.error("build-dashboard: template has no __SNAPSHOT_JSON__ placeholder");
  process.exit(2);
}

mkdirSync("dist", { recursive: true });
writeFileSync("dist/dashboard.html", tpl.replace("__SNAPSHOT_JSON__", json));

console.log("wrote dist/dashboard.html");
console.log(`  snapshot ${snap.generatedAt}, slot ${snap.slot}`);
console.log(`  execution ratio ${(snap.execution.ratio * 100).toFixed(1)}% against ${(snap.execution.promisedRatio * 100)}%`);
console.log(`  registry ${snap.registry.length} entries`);
