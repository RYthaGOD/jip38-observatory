// Offline regression checks for the dashboard builder.
//
//   node test-dashboard.mjs
//
// The builder is run as a real subprocess against temporary files, rather than
// re-executed inside a vm with its imports patched out. That was fragile — it
// broke the moment the builder grew a second import — and it tested a copy of
// the logic instead of the logic.
//
// The cases that matter are the ones the production audit found: a snapshot
// with invalid NESTED data used to pass the build and then throw halfway
// through rendering in the browser, leaving figures on screen, the error
// banner hidden and the download disabled. The build must refuse those.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}
const section = (s) => console.log(`\n${s}`);

const tmp = mkdtempSync(join(tmpdir(), "jip38-dash-"));

// A known-good v3 snapshot, taken from a real one so the fixture cannot drift
// away from what snapshot.mjs actually writes.
const BASE = JSON.parse(readFileSync("data/snapshot.json", "utf8"));
assert.equal(BASE.schemaVersion, 3, "fixture snapshot is not schema v3");

let n = 0;
// Run the real builder over a snapshot. Returns { ok, out, html }.
function build(mutate, { template = "dashboard.template.html" } = {}) {
  const snap = structuredClone(BASE);
  if (mutate) mutate(snap);
  const snapPath = join(tmp, `snap-${n}.json`);
  const outPath = join(tmp, `out-${n}.html`);
  n++;
  writeFileSync(snapPath, JSON.stringify(snap));
  const r = spawnSync(process.execPath,
    ["build-dashboard.mjs", "--snapshot", snapPath, "--out", outPath, "--template", template],
    { encoding: "utf8" });
  return {
    ok: r.status === 0,
    out: `${r.stdout}${r.stderr}`,
    html: existsSync(outPath) ? readFileSync(outPath, "utf8") : null,
    outPath,
  };
}

section("the happy path still works");
const good = build(null);
t("a valid snapshot builds", () => {
  assert.ok(good.ok, `build failed: ${good.out}`);
  assert.ok(good.html, "no output written");
});
t("the snapshot round-trips exactly", () => {
  const embedded = good.html.match(/<script id="snapshot" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(JSON.parse(embedded), BASE, "snapshot values must round-trip exactly");
});
t("script delimiters cannot escape the data island", () => {
  const hostile = build((s) => { s.claim.note = "</script><script>alert(1)</script><!-- $& $` $' $$ →"; });
  assert.ok(hostile.ok, hostile.out);
  const embedded = hostile.html.match(/<script id="snapshot" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.equal(embedded.includes("<"), false, "raw < reached the data island");
  assert.equal(JSON.parse(embedded).claim.note, "</script><script>alert(1)</script><!-- $& $` $' $$ →",
    "replacement sequences were not preserved literally");
});
t("the placeholder is replaced", () => {
  assert.equal(good.html.includes("__SNAPSHOT_JSON__"), false);
});
t("every inline script parses as JavaScript", () => {
  for (const m of good.html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (!m[0].includes("application/json")) new vm.Script(m[1]);
  }
});
t("a template without the placeholder fails the build", () => {
  const bare = join(tmp, "bare.html");
  writeFileSync(bare, "<html></html>");
  const r = build(null, { template: bare });
  assert.ok(!r.ok, "a template with no placeholder was accepted");
  assert.match(r.out, /placeholder/);
});

section("invalid nested data fails the build — finding 5");
const rejects = [
  ["a null registry entry", (s) => { s.registry = [null]; }, /registry\[0\]/],
  ["a registry entry missing its confidence", (s) => { s.registry = [{ role: "r", address: "a" }]; }, /confidence/],
  ["an empty registry", (s) => { s.registry = []; }, /registry is empty/],
  ["a null alert", (s) => { s.alerts = [null]; }, /alerts\[0\]/],
  ["an alert with no message", (s) => { s.alerts = [{ raisedAt: "2026-09-10T00:00:00Z" }]; }, /alerts\[0\]\.message/],
  ["a null history point", (s) => { s.history = [null]; }, /history\[0\]/],
  ["a history point with a bad date", (s) => { s.history = [{ t: "not-a-date", treasury: 1 }]; }, /not a valid date/],
  ["a non-finite treasury reading", (s) => { s.history = [{ t: "2026-09-10T00:00:00Z", treasury: null }]; }, /history\[0\]\.treasury/],
  ["a non-string in unverified", (s) => { s.unverified = [42]; }, /unverified\[0\]/],
  ["a missing chain block", (s) => { delete s.chain; }, /chain is missing/],
  ["a missing assessment", (s) => { delete s.assessment; }, /assessment is missing/],
];
for (const [what, mutate, expect] of rejects) {
  t(`${what} is rejected`, () => {
    const r = build(mutate);
    assert.ok(!r.ok, `the build accepted ${what}`);
    assert.match(r.out, expect);
  });
}

section("invalid figures fail the build — findings 1 and 5");
t("a negative fee claim is rejected", () => {
  const r = build((s) => { s.claim.platformFeesUsd = -1; });
  assert.ok(!r.ok);
  assert.match(r.out, /negative/);
});
t("a non-finite committed value is rejected", () => {
  const r = build((s) => { s.execution.committedUsd = null; });
  assert.ok(!r.ok);
  assert.match(r.out, /committedUsd/);
});
t("supply exceeding genesis is rejected — the core invariant", () => {
  const r = build((s) => { s.chain.supply.current = "2000000000"; });
  assert.ok(!r.ok);
  assert.match(r.out, /invariant/);
});
t("raw supply amounts that do not reconcile are rejected", () => {
  const r = build((s) => { s.chain.supply.destroyedRaw = "1"; });
  assert.ok(!r.ok);
  assert.match(r.out, /do not reconcile/);
});
t("an unknown schema version is rejected", () => {
  const r = build((s) => { s.schemaVersion = 99; });
  assert.ok(!r.ok);
  assert.match(r.out, /schema version 99/);
});

section("a stale assessment can never be published as a figure — finding 1");
t("a ratio alongside a non-current assessment is rejected", () => {
  // The exact failure the audit describes: a refresh restamping a zero the
  // assessment no longer supports.
  const r = build((s) => {
    s.assessment.state = "review-required";
    s.assessment.reasons = ["supply fell"];
    s.execution.ratio = 0;
    s.execution.burnedJto = "0";
  });
  assert.ok(!r.ok, "a stale zero was publishable as a figure");
  assert.match(r.out, /stale zero must never be published/);
});
t("review-required with a null ratio builds, and the page shows review required", () => {
  const r = build((s) => {
    s.assessment.state = "review-required";
    s.assessment.reasons = ["the DAO treasury's JTO balance has fallen"];
    s.execution.ratio = null;
    s.execution.burnedJto = null;
    s.execution.burnedUsd = null;
  });
  assert.ok(r.ok, `an honest unknown failed to build: ${r.out}`);
  assert.match(r.out, /UNKNOWN/);
});
t("a non-current assessment with no reason is rejected", () => {
  const r = build((s) => {
    s.assessment.state = "review-required";
    s.assessment.reasons = [];
    s.execution.ratio = null;
    s.execution.burnedJto = null;
  });
  assert.ok(!r.ok, "review required with nothing to show was accepted");
  assert.match(r.out, /gives no reason/);
});
t("ratio and burned figure must agree about availability", () => {
  const r = build((s) => { s.execution.burnedJto = null; });
  assert.ok(!r.ok);
  assert.match(r.out, /disagree about whether a figure is available/);
});

section("a failed build leaves the previous release standing — finding 7");
t("the previous output survives a rejected snapshot", () => {
  const outPath = join(tmp, "keep.html");
  writeFileSync(outPath, "PREVIOUS RELEASE");
  const snapPath = join(tmp, "bad.json");
  const bad = structuredClone(BASE);
  bad.registry = [null];
  writeFileSync(snapPath, JSON.stringify(bad));
  const r = spawnSync(process.execPath,
    ["build-dashboard.mjs", "--snapshot", snapPath, "--out", outPath], { encoding: "utf8" });
  assert.notEqual(r.status, 0, "the build should have failed");
  assert.equal(readFileSync(outPath, "utf8"), "PREVIOUS RELEASE", "the last valid release was destroyed");
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
