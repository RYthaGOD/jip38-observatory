// What is actually published, versus what has been built.
//
//   node release.mjs status    # compare the built page with the last verified publish
//   node release.mjs record --url <artifact-url> --served <generatedAt>
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// On 13 September 2026 the scheduled refresh read the chain, rebuilt the page,
// invoked the publisher — and the publisher reported, correctly and honestly,
// that it had no Artifact tool and could not publish. It then exited 0.
// refresh.cmd saw a zero exit, logged "done", and the scheduled task recorded
// SUCCESS. The artifact stayed three days stale while the machine reported that
// everything was fine.
//
// That is worse than the earlier quota failures, which at least exited 1. A
// build is not a deployment, and a publisher's exit code is not evidence that
// anything was published.
//
// So publication is tracked as its own fact. RELEASE.json records what was last
// VERIFIED to be served — written only after someone read the artifact back and
// confirmed the snapshot identity it carries. `status` compares that with the
// current build and fails when they differ, so the gap between "built" and
// "published" is visible in an exit code instead of being assumed away.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { atomicWrite, requireThat, arg, sha256, safeError, readJsonFile } from "./core.mjs";

const RELEASE = arg("--release", "RELEASE.json");
const BUILT = arg("--built", "dist/dashboard.html");
const SNAPSHOT = arg("--snapshot", "data/snapshot.json");

const command = process.argv[2];

try {
  if (command === "status") status();
  else if (command === "record") record();
  else if (command === "retire") retire();
  else {
    console.error("usage: node release.mjs status\n" +
      "       node release.mjs record --url <artifact-url> --served <generatedAt>\n" +
      "       node release.mjs retire --url <artifact-url> --pointer <file> --to <live-url>");
    process.exit(2);
  }
} catch (err) {
  console.error(`release: ${safeError(err)}`);
  process.exit(2);
}

// The identity of a built page: which snapshot it carries, and the exact bytes.
function builtIdentity() {
  requireThat(existsSync(BUILT), `${BUILT} does not exist — nothing has been built`);
  requireThat(existsSync(SNAPSHOT), `${SNAPSHOT} does not exist`);
  const html = readFileSync(BUILT);
  const snap = readJsonFile(SNAPSHOT, "the snapshot the page is built from");
  return {
    generatedAt: snap.generatedAt,
    schemaVersion: snap.schemaVersion,
    assessmentState: snap.assessment?.state ?? "unknown",
    sha256: sha256(html),
    bytes: html.length,
  };
}

function status() {
  const built = builtIdentity();
  console.log("built page");
  console.log(`  snapshot    ${built.generatedAt}`);
  console.log(`  assessment  ${built.assessmentState}`);
  console.log(`  sha256      ${built.sha256}`);

  if (!existsSync(RELEASE)) {
    console.log(`\nNOT PUBLISHED: ${RELEASE} does not exist.`);
    console.log("Nothing has ever been recorded as verified-published from this tree.");
    fail();
  }

  const rel = readJsonFile(RELEASE, "the record of the last verified publish");

  // A retired Artifact is not stale. It no longer carries the dashboard at all:
  // it points to the host that serves the page directly, so there is no build
  // for it to fall behind. What CAN go wrong is the pointer page itself being
  // edited and not republished, so that is what gets checked.
  if (rel.retired) {
    console.log(`\nRETIRED: the Artifact carries a pointer, not the dashboard.`);
    console.log(`  artifact    ${rel.url}`);
    console.log(`  points to   ${rel.pointsTo}`);
    console.log(`  retired     ${rel.retiredAt} by ${rel.verifiedBy}`);
    if (existsSync(rel.pointerFile ?? "")) {
      const now = sha256(readFileSync(rel.pointerFile));
      if (now !== rel.pointerSha256) {
        console.log(`\nSTALE: ${rel.pointerFile} has changed since it was published.`);
        console.log(`  Republish it to ${rel.url}, read it back, then run:`);
        console.log(`    node release.mjs retire --url ${rel.url} --pointer ${rel.pointerFile} --to ${rel.pointsTo}`);
        fail();
      }
    }
    console.log(`\nThe live record is served directly at ${rel.pointsTo}; nothing here to publish.`);
    return;
  }

  console.log(`\nlast verified publish`);
  console.log(`  url         ${rel.url}`);
  console.log(`  snapshot    ${rel.servedGeneratedAt}`);
  console.log(`  sha256      ${rel.sha256}`);
  console.log(`  verified    ${rel.verifiedAt} by ${rel.verifiedBy}`);

  if (rel.sha256 === built.sha256) {
    console.log("\nPUBLISHED: the built page is the one that was verified as served.");
    return;
  }

  const builtAge = Date.parse(built.generatedAt);
  const servedAge = Date.parse(rel.servedGeneratedAt);
  const behindMs = builtAge - servedAge;
  console.log("\nSTALE: the built page has NOT been published.");
  console.log(`  the published artifact carries a snapshot ${Number.isFinite(behindMs)
    ? `${Math.round(behindMs / 3600000)} hour(s) older than the current build`
    : "of a different identity"}.`);
  console.log("  Publish it, read it back, then record the result with:");
  console.log(`    node release.mjs record --url ${rel.url} --served ${built.generatedAt}`);
  fail();
}

// Record a publish that has ALREADY been verified by reading the artifact back.
// This is deliberately a separate, explicit act: nothing here can confirm a
// publish on its own, so the receipt states who verified it and when.
function record() {
  const url = arg("--url", "");
  const served = arg("--served", "");
  requireThat(/^https:\/\/claude\.ai\/code\/artifact\/[\w-]+$/.test(url), "--url must be the artifact URL");
  requireThat(served && !Number.isNaN(Date.parse(served)), "--served must be the generatedAt the artifact actually serves");

  const built = builtIdentity();
  requireThat(served === built.generatedAt,
    `the artifact serves ${served} but the built page carries ${built.generatedAt} — ` +
    `record only what was read back from the published page`);

  const receipt = {
    _comment: "Written only after the published artifact was read back and confirmed to carry this snapshot. A build is not a deployment.",
    url,
    servedGeneratedAt: served,
    schemaVersion: built.schemaVersion,
    assessmentState: built.assessmentState,
    sha256: built.sha256,
    bytes: built.bytes,
    verifiedAt: new Date().toISOString(),
    verifiedBy: arg("--by", "readback of the published artifact"),
  };
  atomicWrite(RELEASE, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`recorded ${RELEASE}`);
  console.log(`  ${url}`);
  console.log(`  serving snapshot ${served} (sha256 ${built.sha256.slice(0, 16)}…)`);
}

// Record that the Artifact was retired to a pointer, AFTER the pointer was
// published and read back. The previous dashboard receipt is kept inside the
// new one, so the history of what the Artifact last served is not overwritten
// by the fact that it stopped serving it.
function retire() {
  const url = arg("--url", "");
  const pointerFile = arg("--pointer", "");
  const pointsTo = arg("--to", "");
  requireThat(/^https:\/\/claude\.ai\/code\/artifact\/[\w-]+$/.test(url), "--url must be the artifact URL");
  requireThat(pointerFile && existsSync(pointerFile), "--pointer must name the published pointer page");
  requireThat(/^https:\/\//.test(pointsTo), "--to must be the https URL the pointer sends readers to");
  requireThat(readFileSync(pointerFile, "utf8").includes(pointsTo),
    `${pointerFile} does not link to ${pointsTo} — record only what the published page actually says`);

  const previous = existsSync(RELEASE) ? readJsonFile(RELEASE, "the previous release receipt") : null;
  const body = readFileSync(pointerFile);
  const receipt = {
    _comment: "The Artifact is retired to a pointer: it no longer carries the dashboard, so it cannot fall behind a build. Written only after the pointer was published and read back.",
    retired: true,
    url,
    pointsTo,
    pointerFile,
    pointerSha256: sha256(body),
    // Kept at the top level too, so anything reading this file for a content
    // hash still finds one.
    sha256: sha256(body),
    retiredAt: new Date().toISOString(),
    verifiedBy: arg("--by", "readback of the published artifact"),
    lastDashboardPublish: previous?.retired ? previous.lastDashboardPublish : previous,
  };
  atomicWrite(RELEASE, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`recorded ${RELEASE}: ${url} retired, pointing to ${pointsTo}`);
}

function fail() {
  console.log("\nThe scheduled task must report this as a FAILURE: a build is not a deployment.");
  process.exit(1);
}
