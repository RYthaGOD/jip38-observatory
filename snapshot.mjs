// Build the dashboard's snapshot: everything the observatory currently knows,
// as one JSON document.
//
//   node snapshot.mjs [--out data/snapshot.json]
//
// The published dashboard cannot query Solana itself — an Artifact page is
// barred from making network calls — so the chain has to be read here and the
// result handed to the page. This writes that document.
//
// ---------------------------------------------------------------------------
// THREE KINDS OF TIME, AND WHY THEY ARE KEPT APART
//
// This script used to publish one `generatedAt` and a hardcoded `burnedJto: 0`.
// A refresh therefore advanced the clock on a burn assessment it had not made:
// a real programme burn could happen, and the page would carry a freshly dated
// 0% headline right through it. That is the worst failure this project could
// have, because the whole product is the claim that a number is checkable.
//
// So a snapshot now carries three separate times, and never conflates them:
//
//   chain.observedAt       when Solana was read. Advances every refresh.
//   claim.capturedAt       when the operator's figures were captured. Advances
//                          only when a capture is approved into CLAIM.json.
//   assessment.assessedAt  when a PERSON last attributed burns. Advances only
//                          by a reviewed edit to ASSESSMENT.json.
//
// A refresh can move the first. It can never move the third. What it does
// instead is compare the chain against the assessment's anchor and, if anything
// material has moved or the assessment has expired, publish
// `assessment.state = "review-required"` — so the page shows UNKNOWN rather
// than a stale zero wearing today's date.
//
// Every number also carries where it came from: `chain` for something read from
// Solana, `claim` for something the operator published, `assessment` for
// something a person concluded. Keeping those apart in the DATA, rather than
// only in the prose, is the point of the project.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, appendFileSync, copyFileSync } from "node:fs";
import { createRpc } from "./rpc.mjs";
import { parseRegistry } from "./lib.mjs";
import {
  MINT, TREASURY, TREASURY_ACCOUNT, FEE_PROGRAM, GENESIS_RAW, DECIMALS,
  units, raw, decimalRaw, requireThat, atomicWrite, withLock, safeError,
  endpointLabel, arg, readJsonFile,
} from "./core.mjs";

try { process.loadEnvFile(".env"); } catch {}

// The shape of data/snapshot.json. The dashboard refuses a version it does not
// know, rather than rendering fields it may be misreading.
const SCHEMA_VERSION = 3;

const ACTIVATION = "2026-07-13";
const PROMISED_RATIO = 0.80;
const COMMITMENT = "finalized";

const RPC = process.env.SOLANA_RPC_URL || "";
const OUT = arg("--out", "data/snapshot.json");
const HIST = arg("--history", "data/history.jsonl");
const LOCK = arg("--lock", "data/refresh.lock");

if (!RPC) { console.error("snapshot: no SOLANA_RPC_URL"); process.exit(2); }

// Everything below runs under a lock and writes atomically. A refresh that
// fails must leave the previous valid release exactly as it was: a reader
// getting yesterday's honest snapshot is fine, a reader getting half of
// today's is not.
try {
  await withLock(LOCK, main);
} catch (err) {
  console.error(`snapshot: FAILED — ${safeError(err)}`);
  console.error("snapshot: the previous snapshot has been left untouched.");
  process.exit(1);
}

async function main() {
  const c = createRpc({ url: RPC, rate: 9, maxBatch: 10 });

  // --- read the chain -------------------------------------------------------
  //
  // Each response's CONTEXT SLOT is kept. Supply, accounts and balances are
  // separate reads, so they can land on different ledger states; presenting one
  // unrelated getSlot result as "the" snapshot slot claimed a precision the
  // reads never had. The range is disclosed instead.
  //
  // Related accounts are read together with getMultipleAccounts so they at
  // least share one context slot.
  const slots = [];
  const withSlot = (resp, what) => {
    requireThat(resp && typeof resp === "object", `${what}: no response`);
    requireThat(Number.isInteger(resp.context?.slot), `${what}: response carried no context slot`);
    slots.push(resp.context.slot);
    return resp.value;
  };

  const supply = withSlot(await c.call("getTokenSupply", [MINT, { commitment: COMMITMENT }]), "getTokenSupply");
  const accounts = withSlot(
    await c.call("getMultipleAccounts", [[MINT, FEE_PROGRAM], { commitment: COMMITMENT, encoding: "jsonParsed" }]),
    "getMultipleAccounts");
  const treasuryAccounts = withSlot(
    await c.call("getTokenAccountsByOwner", [TREASURY, { mint: MINT }, { commitment: COMMITMENT, encoding: "jsonParsed" }]),
    "getTokenAccountsByOwner");

  // --- validate before anything is believed --------------------------------
  //
  // A null response used to become an empty account list and a zero balance,
  // and a failed mint read became `mintAuthority: null` — which the page renders
  // as "supply can never increase". The client now throws rather than returning
  // null, and identity is asserted here so a WRONG answer is caught too.

  requireThat(supply?.amount !== undefined, "the mint returned no supply");
  requireThat(supply.decimals === DECIMALS, `mint reports ${supply.decimals} decimals, expected ${DECIMALS}`);
  const currentSupplyRaw = raw(String(supply.amount));
  requireThat(currentSupplyRaw > 0n, "supply is zero — refusing to publish");
  requireThat(currentSupplyRaw <= GENESIS_RAW,
    `supply ${units(currentSupplyRaw)} exceeds the verified genesis supply — the invariant this project rests on is broken`);
  const destroyedRaw = GENESIS_RAW - currentSupplyRaw;

  const [mintAcct, feeAcct] = accounts ?? [];
  requireThat(mintAcct?.data?.parsed?.type === "mint", "the JTO mint account is missing or is not an SPL mint");
  const mintInfo = mintAcct.data.parsed.info;
  // "unavailable" and "null" are different facts. The read succeeded, so a null
  // here really is the chain saying minting is closed.
  requireThat(Object.hasOwn(mintInfo, "mintAuthority"), "the mint account has no mintAuthority field");

  requireThat(feeAcct, "the JTX fee program account is missing");
  requireThat(feeAcct.executable === true, "the JTX fee program is no longer executable");

  // Every treasury token account must actually be the treasury's, and hold JTO.
  let treasuryRaw = 0n;
  const treasuryList = treasuryAccounts ?? [];
  requireThat(Array.isArray(treasuryList), "treasury accounts response was not a list");
  for (const a of treasuryList) {
    const info = a?.account?.data?.parsed?.info;
    requireThat(info?.mint === MINT, `treasury account ${a?.pubkey} does not hold JTO`);
    requireThat(info?.owner === TREASURY, `token account ${a?.pubkey} is not owned by the DAO treasury`);
    requireThat(info?.tokenAmount?.amount !== undefined, `treasury account ${a?.pubkey} returned no balance`);
    treasuryRaw += raw(String(info.tokenAmount.amount));
  }

  const blockTime = await c.call("getBlockTime", [Math.max(...slots)]);
  const slotRange = { from: Math.min(...slots), to: Math.max(...slots) };

  // --- the claim, explicitly imported --------------------------------------
  const claimFile = readJsonFile("CLAIM.json", "the operator's approved claim");
  requireThat(Number.isFinite(claimFile.platformFeesUsd) && claimFile.platformFeesUsd >= 0,
    "CLAIM.json: platformFeesUsd is not a valid non-negative number");
  requireThat(typeof claimFile.capturedAt === "string" && !Number.isNaN(Date.parse(claimFile.capturedAt)),
    "CLAIM.json: capturedAt is not a valid date");
  const claimAgeDays = daysBetween(Date.parse(claimFile.capturedAt), Date.now());
  const claimStale = claimAgeDays > (claimFile.staleAfterDays ?? 7);

  // --- the assessment, and whether it still stands --------------------------
  const assessmentFile = readJsonFile("ASSESSMENT.json", "the burn assessment");
  const assessment = evaluateAssessment(assessmentFile, { currentSupplyRaw, treasuryRaw });

  // JIP-38's own arithmetic, applied to the operator's own fee figure. This is
  // the denominator, stated once: value burned against the 80% of REPORTED JTX
  // platform fees that JIP-38 commits to buybacks and burns.
  const committedUsd = claimFile.platformFeesUsd * PROMISED_RATIO;

  // Value burned over value committed, both USD, on that denominator. Computed
  // here because it needs the claim; the assessment supplies only the numerator.
  assessment.ratio = committedUsd > 0 ? assessment.burnedUsd / committedUsd : null;
  if (assessment.ratio === null && assessment.state === "current") {
    assessment.state = "review-required";
    assessment.reasons.push("the claimed fee total is zero, so there is no denominator to measure execution against");
  }

  const registry = existsSync("REGISTRY.tsv")
    ? parseRegistry(readFileSync("REGISTRY.tsv", "utf8")).map((e) => ({
        role: e.role, address: e.address, confidence: e.confidence, since: e.since,
      }))
    : [];
  requireThat(registry.length > 0, "REGISTRY.tsv produced no entries");

  const observedAt = new Date().toISOString();

  const snap = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: observedAt,
    activation: ACTIVATION,
    daysSinceActivation: Math.floor((Date.now() - Date.parse(`${ACTIVATION}T00:00:00Z`)) / 86400000),

    chain: {
      source: "chain",
      observedAt,
      commitment: COMMITMENT,
      endpoint: endpointLabel(RPC),
      slotRange,
      // Named so nobody reads it as "the" slot of every measurement.
      slotRangeNote: slotRange.from === slotRange.to
        ? "all reads landed on one slot"
        : `reads span slots ${slotRange.from}–${slotRange.to}; measurements are not simultaneous`,
      blockTimeIso: blockTime ? new Date(blockTime * 1000).toISOString() : null,

      supply: {
        mintedEverRaw: GENESIS_RAW.toString(),
        currentRaw: currentSupplyRaw.toString(),
        destroyedRaw: destroyedRaw.toString(),
        mintedEver: units(GENESIS_RAW),
        current: units(currentSupplyRaw),
        destroyed: units(destroyedRaw),
        decimals: DECIMALS,
        mintAuthority: mintInfo.mintAuthority,
        freezeAuthority: mintInfo.freezeAuthority ?? null,
        mintingClosed: "2023-12-04T18:27:47Z",
        genesisMintTx: "2M1gWKQvjCav6JLkf2j5EfUmpp31RRM27YPnG1fGiyvgqu3s4C7Z1tWYXgYKoxwgMC84WG5v7tMHwMMQ74xUekVG",
      },

      treasury: {
        owner: TREASURY,
        tokenAccount: TREASURY_ACCOUNT,
        jtoRaw: treasuryRaw.toString(),
        jto: units(treasuryRaw),
        accounts: treasuryList.length,
      },

      feeProgram: {
        address: FEE_PROGRAM,
        exists: true,
        executable: feeAcct.executable,
        owner: feeAcct.owner ?? null,
      },
    },

    claim: {
      source: "claim",
      capturedAt: claimFile.capturedAt,
      approvedAt: claimFile.approvedAt ?? null,
      url: claimFile.source,
      sha256: claimFile.sha256 ?? null,
      platformFeesUsd: claimFile.platformFeesUsd,
      tradingVolumeUsd: claimFile.tradingVolumeUsd ?? null,
      fills: claimFile.fills ?? null,
      dataBegins: claimFile.dataBegins ?? null,
      ageDays: claimAgeDays,
      stale: claimStale,
      note: claimFile.note ?? "",
      limitations: claimFile.limitations ?? [],
    },

    assessment: {
      source: "assessment",
      ...assessment,
    },

    execution: {
      // The denominator, stated once and in one place.
      denominator: "80% of reported JTX platform fees, as captured in CLAIM.json",
      committedUsd,
      promisedRatio: PROMISED_RATIO,
      // Present ONLY when the assessment currently stands. Otherwise null, and
      // the page must show "unknown / review required" rather than a number.
      burnedRaw: assessment.state === "current" ? assessment.burnedRaw : null,
      burnedJto: assessment.state === "current" ? units(raw(assessment.burnedRaw)) : null,
      burnedUsd: assessment.state === "current" ? assessment.burnedUsd : null,
      ratio: assessment.state === "current" ? assessment.ratio : null,
    },

    unverified: [
      "That JTX fees are being swept into JTO — the buyback step is an operator claim, not yet traced on chain.",
      "The 80/20 split.",
      `The $${claimFile.platformFeesUsd.toLocaleString()} fee total, and the ~10 days of activity missing from the dashboard's start.`,
      `The dates of the ${units(destroyedRaw)} JTO destroyed before activation.`,
    ],

    registry,
    history: [],
    alerts: [],
  };

  // --- change detection, with alerts that survive ---------------------------
  //
  // The event worth catching is the FIRST BURN: the treasury's JTO climbs while
  // fees are swept in, and falls when a burn finally happens. Supply is
  // monotonically non-increasing, so a fall is unambiguous.
  //
  // Alerts used to be recomputed against the previous snapshot and replaced
  // every run, so an anomaly raised on Monday vanished on Tuesday's stable
  // reading — the one thing that must never happen to a burn alert. They now
  // persist until a person marks them reviewed.
  let prev = null;
  if (existsSync(OUT)) { try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch { /* unreadable: treat as none */ } }

  const alerts = (prev?.alerts ?? []).filter((a) => a && !a.reviewed);
  const raise = (id, message) => {
    if (!alerts.some((a) => a.id === id)) alerts.push({ id, message, raisedAt: observedAt, reviewed: false });
  };

  if (prev?.chain?.treasury?.jtoRaw !== undefined && prev?.chain?.supply?.currentRaw !== undefined) {
    const dTreasury = treasuryRaw - BigInt(prev.chain.treasury.jtoRaw);
    const dSupply = currentSupplyRaw - BigInt(prev.chain.supply.currentRaw);
    if (dTreasury < 0n) {
      raise(`treasury-fell-${slotRange.to}`,
        `TREASURY FELL by ${units(-dTreasury)} JTO (${units(BigInt(prev.chain.treasury.jtoRaw))} -> ${units(treasuryRaw)}). ` +
        `This is the event to check: a burn, or a transfer out.`);
    }
    // Supply always drifts down from rent-reclaim dust; only a step change matters.
    if (dSupply < -decimalRaw("1000")) {
      raise(`supply-fell-${slotRange.to}`,
        `SUPPLY FELL by ${units(-dSupply)} JTO since the last snapshot — far beyond dust. ` +
        `A programme-scale burn may have occurred.`);
    }
  }
  if (prev?.claim && claimFile.platformFeesUsd !== prev.claim.platformFeesUsd) {
    raise(`claim-changed-${claimFile.capturedAt}`,
      `claimed platform fees changed: $${prev.claim.platformFeesUsd} -> $${claimFile.platformFeesUsd}`);
  }
  for (const reason of assessment.reasons) raise(`assessment-${assessment.state}-${reason.slice(0, 24)}`, reason);
  snap.alerts = alerts;

  // --- write, atomically, keeping the last valid release --------------------
  //
  // History is appended only after every validation above has passed, so a
  // rejected read can never leave a phantom reading in the series.
  appendFileSync(HIST, `${JSON.stringify({
    t: observedAt, slot: slotRange.to,
    supplyRaw: currentSupplyRaw.toString(), treasuryRaw: treasuryRaw.toString(),
    supply: Number(units(currentSupplyRaw)), treasury: Number(units(treasuryRaw)),
    destroyed: Number(units(destroyedRaw)),
    assessmentState: assessment.state,
    alerts: alerts.filter((a) => !a.reviewed).length,
  })}\n`);

  // Read the series back only now, so it includes the reading just taken.
  // Whatever is on disk is what gets shown: the page draws a chart once there
  // are two points and says it is still collecting until then. Back-filling a
  // plausible-looking curve would be the one unforgivable thing here.
  snap.history = readFileSync(HIST, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((h) => h && typeof h.t === "string" && Number.isFinite(h.treasury))
    .map((h) => ({ t: h.t, treasury: h.treasury, supply: h.supply }))
    .slice(-240);

  // Keep the outgoing release so a bad publish can be rolled back to it.
  if (existsSync(OUT)) { try { copyFileSync(OUT, `${OUT}.prev`); } catch { /* best effort */ } }
  atomicWrite(OUT, JSON.stringify(snap, null, 2));

  console.log(`wrote ${OUT}  (schema v${SCHEMA_VERSION})`);
  console.log(`  observed    ${observedAt}  slots ${slotRange.from}–${slotRange.to} @ ${COMMITMENT}`);
  console.log(`  history     ${snap.history.length} reading(s)`);
  console.log(`  supply      ${units(currentSupplyRaw)} JTO  (destroyed ${units(destroyedRaw)})`);
  console.log(`  treasury    ${units(treasuryRaw)} JTO across ${treasuryList.length} account(s)`);
  console.log(`  claim       $${claimFile.platformFeesUsd.toLocaleString()} fees, captured ${claimFile.capturedAt}` +
    `${claimStale ? ` — STALE (${claimAgeDays}d old)` : ""}`);
  console.log(`  committed   $${committedUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  console.log(`  assessment  ${assessment.state.toUpperCase()} (assessed ${assessment.assessedAt})`);
  for (const r of assessment.reasons) console.log(`              - ${r}`);
  console.log(`  execution   ${snap.execution.ratio === null
    ? "UNKNOWN — the assessment needs review before a ratio can be published"
    : `${(snap.execution.ratio * 100).toFixed(1)}% against a promised ${PROMISED_RATIO * 100}%`}`);
  if (alerts.length) {
    console.log(`  ALERTS      ${alerts.length} unreviewed:`);
    for (const a of alerts) console.log(`              - [${a.raisedAt.slice(0, 19)}Z] ${a.message}`);
  }
}

// ---------------------------------------------------------------------------

// A declaration, not a const: main() runs at module top level, above this point.
function daysBetween(a, b) { return Math.floor((b - a) / 86400000); }

// Does the recorded assessment still stand against what the chain says now?
//
// This is the guard that stops a refresh from restamping a conclusion it did
// not reach. It never edits ASSESSMENT.json — it only decides whether what is
// in there may still be published as current.
function evaluateAssessment(file, { currentSupplyRaw, treasuryRaw }) {
  requireThat(typeof file.assessedAt === "string" && !Number.isNaN(Date.parse(file.assessedAt)),
    "ASSESSMENT.json: assessedAt is not a valid date");
  requireThat(typeof file.burnedRaw === "string", "ASSESSMENT.json: burnedRaw must be a raw base-unit string");
  const burnedRaw = raw(file.burnedRaw);

  const anchor = file.anchor ?? {};
  const triggers = file.reviewTriggers ?? {};
  const reasons = [];

  // 1. Has supply fallen materially since the assessment was made?
  if (typeof anchor.supply === "string") {
    const anchorSupply = decimalRaw(anchor.supply);
    const fall = anchorSupply - currentSupplyRaw;
    const limit = decimalRaw(String(triggers.supplyFallJto ?? "1000"));
    if (fall > limit) {
      reasons.push(`supply has fallen ${units(fall)} JTO since the assessment — beyond the ${units(limit)} JTO dust threshold, so a burn must be attributed before zero can be republished`);
    }
  }

  // 2. Has the treasury fallen at all? That is the first-burn signal.
  if (typeof anchor.treasury === "string") {
    const anchorTreasury = decimalRaw(anchor.treasury);
    const fall = anchorTreasury - treasuryRaw;
    const limit = decimalRaw(String(triggers.treasuryFallJto ?? "0.000001"));
    if (fall > limit) {
      reasons.push(`the DAO treasury's JTO balance has fallen ${units(fall)} since the assessment — a burn or a transfer out, and which one decides the headline`);
    }
  }

  // 3. Has it simply gone stale?
  const ageDays = daysBetween(Date.parse(file.assessedAt), Date.now());
  const validFor = Number(file.validForDays ?? 14);
  if (Number.isFinite(validFor) && ageDays > validFor) {
    reasons.push(`the assessment is ${ageDays} days old and its coverage expires after ${validFor} — it has not been re-established against current chain state`);
  }

  // 4. A non-zero burn needs a documented valuation before any ratio is shown.
  //    This project has no price source, so the valuation must be supplied with
  //    the assessment or the ratio stays unknown.
  let burnedUsd = 0, ratio = 0;
  if (burnedRaw > 0n) {
    const v = file.burnedValuation;
    if (!v || !Number.isFinite(v.usd) || !v.basis || !v.pricedAt) {
      reasons.push("a non-zero burn is recorded but ASSESSMENT.json carries no burnedValuation {usd, basis, pricedAt} — a ratio cannot be published without a documented valuation");
    } else {
      burnedUsd = v.usd;
    }
  }

  const state = reasons.length ? "review-required" : "current";

  return {
    assessedAt: file.assessedAt,
    assessedBy: file.assessedBy ?? null,
    state,
    reasons,
    burnedRaw: file.burnedRaw,
    burnedUsd,
    // Filled by the caller: the ratio needs committedUsd, which comes from the
    // claim, and the denominator is named once in execution.denominator.
    ratio: null,
    basis: file.basis ?? "",
    coverage: file.coverage ?? null,
    anchor: { slot: anchor.slot ?? null, observedAt: anchor.observedAt ?? null },
    ageDays,
    validForDays: validFor,
  };
}
