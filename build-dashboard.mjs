// Build the published dashboard from the template and the current snapshot.
//
//   node snapshot.mjs && node build-dashboard.mjs
//
// The page is static by design. An Artifact cannot make network calls, so it
// could never query Solana itself; and declaring the `db` capability — which
// would let figures be updated without republishing — makes an artifact
// organization-internal and unshareable publicly. For a project whose whole
// point is public verification, that is the wrong trade. So the chain is read
// in snapshot.mjs, baked in here, and the page is republished to update it.
//
// This step VALIDATES before it writes. The browser can only guard the top
// level of the document: with `registry: [null]` it threw partway through
// rendering, leaving figures on screen, the error banner hidden and the
// download disabled — a page that looked complete and was not. The cheapest
// place to catch that is here, where a bad snapshot can simply fail the build
// and leave the previous release standing.

import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { atomicWrite, requireThat, arg, safeError, readJsonFile } from "./core.mjs";

const SCHEMA_VERSION = 3;

const TEMPLATE = arg("--template", "dashboard.template.html");
const SNAPSHOT = arg("--snapshot", "data/snapshot.json");
const OUT = arg("--out", "dist/dashboard.html");

try {
  main();
} catch (err) {
  console.error(`build-dashboard: FAILED — ${safeError(err)}`);
  console.error("build-dashboard: the previous dist output has been left untouched.");
  process.exit(1);
}

function main() {
  const tpl = readFileSync(TEMPLATE, "utf8");
  requireThat(tpl.includes("__SNAPSHOT_JSON__"), `${TEMPLATE} has no __SNAPSHOT_JSON__ placeholder`);

  const snap = readJsonFile(SNAPSHOT, "the snapshot the page is built from");

  validate(snap);

  // Escape HTML delimiters so embedded data cannot terminate the script
  // element. A replacement callback preserves literal dollar-sign sequences.
  const json = JSON.stringify(snap).replace(/</g, "\\u003c");

  if (existsSync(OUT)) { try { copyFileSync(OUT, `${OUT}.prev`); } catch { /* best effort */ } }
  atomicWrite(OUT, tpl.replace("__SNAPSHOT_JSON__", () => json));

  const ex = snap.execution;
  console.log(`wrote ${OUT}`);
  console.log(`  schema      v${snap.schemaVersion}`);
  console.log(`  snapshot    ${snap.generatedAt}, slots ${snap.chain.slotRange.from}–${snap.chain.slotRange.to}`);
  console.log(`  assessment  ${snap.assessment.state.toUpperCase()} (assessed ${snap.assessment.assessedAt})`);
  console.log(`  execution   ${ex.ratio === null
    ? "UNKNOWN — page will show review required"
    : `${(ex.ratio * 100).toFixed(1)}% against ${ex.promisedRatio * 100}%`}`);
  console.log(`  registry    ${snap.registry.length} entries`);
  if (snap.alerts.length) console.log(`  ALERTS      ${snap.alerts.length} unreviewed`);
}

// Everything the page will read, checked here so it cannot throw there.
//
// This is deliberately structural rather than clever: each field the template
// touches is asserted to be the shape the template assumes. A schema library
// would be more elegant and would add a dependency to a project whose whole
// argument is that a reader can audit it end to end.
function validate(snap) {
  const obj = (v, what) => { requireThat(v && typeof v === "object" && !Array.isArray(v), `${what} is missing or not an object`); return v; };
  const arr = (v, what) => { requireThat(Array.isArray(v), `${what} is missing or not an array`); return v; };
  const str = (v, what) => { requireThat(typeof v === "string" && v.length > 0, `${what} is missing or not a string`); return v; };
  const fin = (v, what) => { requireThat(Number.isFinite(v), `${what} is not a finite number`); return v; };
  // Amounts cross the wire as decimal strings, because exact base units do not
  // survive a float. "Numeric" here means "parses to a finite number".
  const numeric = (v, what) => {
    requireThat(typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)), `${what} is not a numeric string`);
    return Number(v);
  };
  const nonNegative = (v, what) => { requireThat(fin(v, what) >= 0, `${what} is negative`); return v; };

  obj(snap, "snapshot");
  requireThat(snap.schemaVersion === SCHEMA_VERSION,
    `snapshot is schema version ${snap.schemaVersion}, this builder writes version ${SCHEMA_VERSION}`);
  str(snap.generatedAt, "generatedAt");
  requireThat(!Number.isNaN(Date.parse(snap.generatedAt)), "generatedAt is not a valid date");

  const chain = obj(snap.chain, "chain");
  const range = obj(chain.slotRange, "chain.slotRange");
  requireThat(Number.isInteger(range.from) && Number.isInteger(range.to) && range.to >= range.from,
    "chain.slotRange is not a valid slot range");

  const supply = obj(chain.supply, "chain.supply");
  const minted = numeric(supply.mintedEver, "chain.supply.mintedEver");
  const current = numeric(supply.current, "chain.supply.current");
  const destroyed = numeric(supply.destroyed, "chain.supply.destroyed");
  requireThat(current >= 0 && minted > 0 && destroyed >= 0, "supply figures must be non-negative");
  requireThat(current <= minted, "current supply exceeds the genesis supply — the project's core invariant is broken");
  // The raw strings are the authority; the display figures must agree with them.
  requireThat(BigInt(str(supply.mintedEverRaw, "chain.supply.mintedEverRaw")) -
    BigInt(str(supply.currentRaw, "chain.supply.currentRaw")) ===
    BigInt(str(supply.destroyedRaw, "chain.supply.destroyedRaw")),
    "chain.supply raw amounts do not reconcile: minted - current != destroyed");
  requireThat(supply.mintAuthority === null || typeof supply.mintAuthority === "string",
    "chain.supply.mintAuthority must be an address or null");

  const treasury = obj(chain.treasury, "chain.treasury");
  numeric(treasury.jto, "chain.treasury.jto");
  requireThat(Number.isInteger(treasury.accounts) && treasury.accounts >= 0, "chain.treasury.accounts is invalid");

  const claim = obj(snap.claim, "claim");
  nonNegative(claim.platformFeesUsd, "claim.platformFeesUsd");
  str(claim.capturedAt, "claim.capturedAt");

  const as = obj(snap.assessment, "assessment");
  requireThat(["current", "review-required", "stale"].includes(as.state),
    `assessment.state "${as.state}" is not a known state`);
  str(as.assessedAt, "assessment.assessedAt");
  arr(as.reasons, "assessment.reasons");
  requireThat(as.state === "current" || as.reasons.length > 0,
    "assessment is not current but gives no reason — the page would show review required with nothing to show");

  const ex = obj(snap.execution, "execution");
  nonNegative(ex.committedUsd, "execution.committedUsd");
  fin(ex.promisedRatio, "execution.promisedRatio");
  str(ex.denominator, "execution.denominator");
  // Null is the honest value when the assessment does not stand. A number here
  // must be a real one.
  if (ex.ratio !== null) {
    requireThat(Number.isFinite(ex.ratio) && ex.ratio >= 0, "execution.ratio must be null or a non-negative number");
    requireThat(as.state === "current",
      "execution.ratio is a number while the assessment is not current — a stale zero must never be published as a figure");
  }
  if (ex.burnedJto !== null) numeric(ex.burnedJto, "execution.burnedJto");
  if (ex.burnedUsd !== null) nonNegative(ex.burnedUsd, "execution.burnedUsd");
  requireThat((ex.ratio === null) === (ex.burnedJto === null),
    "execution.ratio and execution.burnedJto disagree about whether a figure is available");

  // The collections the page iterates. One null entry here is what produced a
  // silent partial render in the browser.
  arr(snap.registry, "registry").forEach((r, i) => {
    obj(r, `registry[${i}]`);
    str(r.role, `registry[${i}].role`);
    str(r.address, `registry[${i}].address`);
    str(r.confidence, `registry[${i}].confidence`);
  });
  requireThat(snap.registry.length > 0, "registry is empty — nothing verifies the addresses the figures rest on");

  arr(snap.unverified, "unverified").forEach((v, i) => str(v, `unverified[${i}]`));

  arr(snap.alerts, "alerts").forEach((a, i) => {
    obj(a, `alerts[${i}]`);
    str(a.message, `alerts[${i}].message`);
    str(a.raisedAt, `alerts[${i}].raisedAt`);
  });

  arr(snap.history, "history").forEach((h, i) => {
    obj(h, `history[${i}]`);
    str(h.t, `history[${i}].t`);
    requireThat(!Number.isNaN(Date.parse(h.t)), `history[${i}].t is not a valid date`);
    fin(h.treasury, `history[${i}].treasury`);
  });

  // What the live cycle established. Optional as a whole — a snapshot taken
  // where the cycle never ran has none — but each part present must be sound,
  // and the one that can raise a burn must be internally consistent.
  if (snap.tracking !== undefined) {
    const tr = obj(snap.tracking, "tracking");
    const baseUnits = (v, what) => {
      requireThat(typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v), `${what} is not a base-unit string`);
      return BigInt(v);
    };
    arr(tr.problems, "tracking.problems").forEach((p, i) => { obj(p, `tracking.problems[${i}]`); str(p.message, `tracking.problems[${i}].message`); });

    if (tr.ledger !== null) {
      const l = obj(tr.ledger, "tracking.ledger");
      requireThat(Number.isInteger(l.burnsSinceActivation) && l.burnsSinceActivation >= 0,
        "tracking.ledger.burnsSinceActivation is not a count");
      const burned = baseUnits(l.burnedSinceActivationRaw, "tracking.ledger.burnedSinceActivationRaw");
      arr(l.burns, "tracking.ledger.burns");
      requireThat(l.burnsSinceActivation > 0 || burned === 0n,
        "tracking.ledger reports JTO burned with no burn recorded");
      // A recorded burn must never coexist with a published zero.
      requireThat(l.burnsSinceActivation === 0 || as.state !== "current",
        "tracking.ledger records a burn since activation while the assessment is still current — the page would publish a zero through a burn");
      requireThat(typeof l.stale === "boolean" && typeof l.complete === "boolean", "tracking.ledger.stale/complete must be booleans");
    }
    if (tr.buyback !== null) {
      const b = obj(tr.buyback, "tracking.buyback");
      const j = obj(b.jto, "tracking.buyback.jto");
      requireThat(baseUnits(j.toTreasuryRaw, "tracking.buyback.jto.toTreasuryRaw") + baseUnits(j.toOthersRaw, "tracking.buyback.jto.toOthersRaw") ===
        baseUnits(j.acquiredRaw, "tracking.buyback.jto.acquiredRaw"), "tracking.buyback JTO does not add up");
    }
    if (tr.fees !== null) {
      const f = obj(tr.fees, "tracking.fees");
      requireThat(typeof f.complete === "boolean", "tracking.fees.complete must be a boolean");
      arr(f.stablecoins, "tracking.fees.stablecoins").forEach((c, i) => {
        requireThat(baseUnits(c.sweptRaw, `tracking.fees.stablecoins[${i}].sweptRaw`) + baseUnits(c.heldRaw, `tracking.fees.stablecoins[${i}].heldRaw`) ===
          baseUnits(c.collectedRaw, `tracking.fees.stablecoins[${i}].collectedRaw`), `tracking.fees.stablecoins[${i}] does not add up`);
      });
    }
  }
}
