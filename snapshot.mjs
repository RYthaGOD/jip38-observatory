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

  // --- what the live cycle has established ----------------------------------
  //
  // The ledger, the sweeps and the fee measurement are produced by the live
  // cycle in server.mjs and read here. Each is optional — a fresh volume may not
  // have them yet — and each says how current it is, so the page never presents
  // a stale figure as a live one.
  //
  // An input that exists but cannot be read is NOT treated as absent. It is
  // recorded as a problem and alerted on below, because a ledger that silently
  // stops being read is a burn detector that silently stops detecting.
  const activationSec = Date.parse(`${ACTIVATION}T00:00:00Z`) / 1000;
  const tracking = { ledger: null, buyback: null, fees: null, problems: [] };
  const track = (name, paths, what, summarise) => {
    try {
      const found = readOptional(paths, what);
      if (found) tracking[name] = { file: found.path, ...summarise(found.value) };
    } catch (err) {
      tracking.problems.push({ part: name, message: `${what} could not be read: ${safeError(err)}` });
    }
  };
  track("ledger", ["data/track-state.json"], "the enumerated ledger",
    (st) => ledgerBlock(st, { activationSec, treasuryTokenAccounts: treasuryList.map((a) => a.pubkey) }));
  track("buyback", ["data/SWEEPS.json", "SWEEPS.json"], "the decoded fee sweeps", buybackBlock);
  track("fees", ["data/FEES.json", "FEES.json"], "the on-chain fee measurement", feesBlock);
  const ledger = tracking.ledger;

  // LIVE BURN DETECTION. The whole finding is that nothing has been burned. If
  // the enumerated ledger ever records a burn instruction since activation, the
  // standing zero must stop being published as a figure the same cycle — not
  // after someone next reads a log. It is a trigger for review rather than an
  // automatic new number, because attributing a burn to JIP-38 is still a
  // judgement the assessment exists to record.
  if (ledger && ledger.burnsSinceActivation > 0) {
    assessment.state = "review-required";
    assessment.reasons.push(`the live ledger records ${ledger.burnsSinceActivation} burn instruction(s) since activation, destroying ${ledger.burnedSinceActivation} JTO — they must be attributed before a burn figure can be published`);
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
      // The headline, on chain alone: JTO burned against the JTO the fee sweeps
      // bought for the DAO. Two chain measurements in the same unit — no price,
      // no fee claim, no operator figure. Null when the sweeps have not been
      // decoded here; the USD ratio above is kept as the archived claim basis.
      chain: chainExecution(assessment, tracking.buyback),
    },

    unverified: tracking.buyback
      ? unverifiedWithBuyback(tracking.buyback, destroyedRaw)
      : [
          "That JTX fees are being swept into JTO — the buyback step is an operator claim, not yet traced on chain.",
          "The 80/20 split.",
          `The $${claimFile.platformFeesUsd.toLocaleString()} fee total, and the ~10 days of activity missing from the dashboard's start.`,
          `The dates of the ${units(destroyedRaw)} JTO destroyed before activation.`,
        ],

    // What the live tracking cycle has established, each part dated. Summaries
    // only: the full decoded records are served beside the page as /sweeps.json
    // and /fees.json.
    tracking,

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
  // Keyed on the reason with its figures removed. Keyed on the text itself, an
  // expired assessment raised a fresh alert every day its age went up by one.
  for (const reason of assessment.reasons) {
    raise(`assessment-${assessment.state}-${reason.replace(/[0-9][0-9.,]*/g, "#").slice(0, 60)}`, reason);
  }

  // One alert per burn, keyed on its transaction, so a second burn is raised
  // even while the first is still unreviewed.
  for (const b of ledger?.burns ?? []) {
    raise(`ledger-burn-${b.signature}`,
      `BURN RECORDED: ${b.jto} JTO burned at ${b.at} from ${b.account ?? "an unidentified account"} (transaction ${b.signature}).`);
  }
  // A detector that has stopped is reported, not trusted.
  if (ledger?.stale) {
    raise(`ledger-stale-${ledger.polledAt ?? "never"}`,
      `The live ledger has not been polled for new activity ${ledger.polledAt ? `since ${ledger.polledAt}` : "at all"} — burns after that moment would not yet be detected.`);
  }
  for (const acct of ledger?.treasuryTokenAccountsNotWatched ?? []) {
    raise(`ledger-unwatched-${acct}`,
      `The DAO treasury holds JTO account ${acct}, which the live ledger has not enumerated — a burn from it would not be detected.`);
  }
  for (const p of tracking.problems) raise(`tracking-${p.part}-unreadable`, p.message);
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
  console.log(`  ledger      ${ledger
    ? `${ledger.accounts.enumerated}/${ledger.accounts.known} accounts watched, polled ${ledger.polledAt ?? "never"}` +
      `${ledger.stale ? " — STALE" : ""}; ${ledger.burnsSinceActivation} burn(s) since activation`
    : "not present on this machine"}`);
  console.log(`  buyback     ${tracking.buyback
    ? `${tracking.buyback.sweeps} sweeps, ${tracking.buyback.jto.toTreasury} JTO to the treasury, through ${tracking.buyback.lastSweep}`
    : "not present"}`);
  console.log(`  fees        ${tracking.fees
    ? `${tracking.fees.complete ? "complete" : "NOT complete"}, held side read ${tracking.fees.heldReadAt}`
    : "not present"}`);
  for (const p of tracking.problems) console.log(`  PROBLEM     ${p.message}`);
  console.log(`  execution   ${snap.execution.ratio === null
    ? "UNKNOWN — the assessment needs review before a ratio can be published"
    : `${(snap.execution.ratio * 100).toFixed(1)}% against a promised ${PROMISED_RATIO * 100}% (archived claim basis)`}`);
  const onChain = snap.execution.chain;
  if (onChain) {
    console.log(`  on chain    ${onChain.ratio === null
      ? "UNKNOWN — the assessment needs review before a ratio can be published"
      : `${onChain.burnedJto} of ${onChain.boughtForDao} JTO bought back for the DAO burned (${(onChain.ratio * 100).toFixed(1)}%)`}`);
  }
  if (alerts.length) {
    console.log(`  ALERTS      ${alerts.length} unreviewed:`);
    for (const a of alerts) console.log(`              - [${a.raisedAt.slice(0, 19)}Z] ${a.message}`);
  }
}

// ---------------------------------------------------------------------------

// A declaration, not a const: main() runs at module top level, above this point.
function daysBetween(a, b) { return Math.floor((b - a) / 86400000); }

// The first of `paths` that exists, parsed — or null when none does. A file
// that exists and cannot be parsed throws: that is a problem, not an absence.
function readOptional(paths, what) {
  for (const path of paths) if (existsSync(path)) return { path, value: readJsonFile(path, what) };
  return null;
}

// --- the live cycle's outputs, summarised for the snapshot ---------------------
//
// Pure functions of what the cycle wrote, so they can be tested without a chain.
// Each keeps exact base-unit strings alongside display strings, and each says
// when its part was last brought up to date.

function digits(v, what) {
  requireThat(typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v), `${what} is not a base-unit string`);
  return v;
}

// The enumerated ledger (track.mjs): how much of it is current, and whether it
// has recorded a burn since activation.
function ledgerBlock(st, { activationSec, treasuryTokenAccounts = [], nowMs = Date.now(), staleAfterHours = 24 }) {
  requireThat(st && Array.isArray(st.events) && st.accounts && typeof st.accounts === "object",
    "not a track.mjs checkpoint: no events or accounts");
  const accounts = Object.entries(st.accounts);
  const enumerated = accounts.filter(([, a]) => a.done && !a.skipped && !a.incomplete);
  const incomplete = accounts.filter(([, a]) => a.incomplete);
  const pollFailures = accounts.filter(([, a]) => a.pollFailed).length;
  const discoveryFailed = Boolean(st.treasuryDiscovery?.failed);

  // When each watched account was last confirmed complete: its last enumeration
  // or its last successful poll, whichever is later.
  const current = enumerated
    .map(([, a]) => [a.coveredAt, a.checkedAt].filter(Boolean).sort().at(-1))
    .filter(Boolean).sort();

  const burns = st.events
    .filter((e) => e?.kind === "BURN" && Number(e.t) >= activationSec)
    .sort((a, b) => a.t - b.t);
  const burnedRaw = burns.reduce((sum, e) => sum + raw(digits(String(e.raw), "a ledger burn amount")), 0n);

  const polledMs = Date.parse(st.polledAt ?? "");
  const ageHours = Number.isFinite(polledMs) ? Math.round(((nowMs - polledMs) / 3_600_000) * 10) / 10 : null;
  const watched = new Set(enumerated.map(([address]) => address));

  return {
    source: "chain",
    producedBy: "track.mjs",
    polledAt: st.polledAt ?? null,
    ageHours,
    staleAfterHours,
    stale: ageHours === null || ageHours > staleAfterHours,
    accounts: {
      known: accounts.length,
      enumerated: enumerated.length,
      notEnumerated: accounts.filter(([, a]) => a.skipped).map(([address, a]) => ({ address, label: a.label ?? null, reason: a.skipped })),
      incomplete: incomplete.length,
    },
    currentThrough: { oldest: current[0] ?? null, newest: current.at(-1) ?? null },
    unresolvedTransactions: incomplete.reduce((sum, [, a]) => sum + (a.unresolvedSigs?.length ?? 0), 0),
    pollFailures,
    treasuryDiscovery: st.treasuryDiscovery ?? null,
    complete: incomplete.length === 0 && pollFailures === 0 && !discoveryFailed,
    treasuryTokenAccountsNotWatched: treasuryTokenAccounts.filter((a) => !watched.has(a)),
    events: st.events.length,
    burnsSinceActivation: burns.length,
    burnedSinceActivationRaw: burnedRaw.toString(),
    burnedSinceActivation: units(burnedRaw),
    // The most recent, in full, so each can be checked on an explorer.
    burns: burns.slice(-25).map((e) => ({
      at: new Date(e.t * 1000).toISOString(),
      raw: String(e.raw),
      jto: units(raw(String(e.raw))),
      account: e.from || null,
      authority: e.who || null,
      signature: e.sig,
    })),
  };
}

// The decoded fee sweeps (sweeps.mjs --summary): the buyback leg.
function buybackBlock(s) {
  requireThat(s && s.jto && s.transactions && s.window, "not a sweeps.mjs summary");
  const jto = {
    acquiredRaw: digits(s.jto.acquiredRaw, "jto.acquiredRaw"),
    toTreasuryRaw: digits(s.jto.toTreasuryRaw, "jto.toTreasuryRaw"),
    toOthersRaw: digits(s.jto.toOthersRaw, "jto.toOthersRaw"),
  };
  requireThat(BigInt(jto.toTreasuryRaw) + BigInt(jto.toOthersRaw) === BigInt(jto.acquiredRaw),
    "sweeps summary does not add up: to treasury + to others != acquired");
  return {
    source: "chain",
    producedBy: "sweeps.mjs",
    generatedAt: s.generatedAt ?? null,
    resolvedAt: s.resolvedAt ?? null,
    firstSweep: s.window.firstSweep ?? null,
    lastSweep: s.window.lastSweep ?? null,
    sweeps: s.transactions.sweeps,
    inflows: s.transactions.inflows,
    unresolved: s.transactions.unresolved,
    jto: {
      ...jto,
      acquired: units(raw(jto.acquiredRaw)),
      toTreasury: units(raw(jto.toTreasuryRaw)),
      toOthers: units(raw(jto.toOthersRaw)),
      treasurySharePpm: s.jto.treasurySharePpm ?? null,
    },
    keeper: s.signers?.[0] ?? null,
    otherRecipients: (s.otherRecipients ?? []).slice(0, 5),
    splitPatterns: (s.splitPatterns ?? []).slice(0, 20),
    reconciliation: s.reconciliation ?? null,
    notEstablished: s.notEstablished ?? [],
    detail: "/sweeps.json",
  };
}

// The chain-only execution figure. The burn numerator is the assessment's, so
// it is published only while the assessment stands — exactly like the USD ratio.
function chainExecution(assessment, buyback) {
  if (!buyback) return null;
  // JIP-38 sends 100% of the DAO's share to buybacks and permanent burns, so of
  // the JTO bought for the DAO, the share burned should eventually be all of it.
  const promisedRatio = 1;
  const boughtRaw = raw(digits(buyback.jto.toTreasuryRaw, "buyback.jto.toTreasuryRaw"));
  const current = assessment.state === "current";
  const burnedRaw = current ? raw(assessment.burnedRaw) : null;
  return {
    source: "chain",
    denominator: "JTO bought back for the DAO treasury by JTX fee sweeps since activation",
    boughtForDaoRaw: boughtRaw.toString(),
    boughtForDao: units(boughtRaw),
    sweeps: buyback.sweeps,
    through: buyback.lastSweep,
    promisedRatio,
    burnedRaw: current ? burnedRaw.toString() : null,
    burnedJto: current ? units(burnedRaw) : null,
    // Parts per million, in integers, then scaled: never a float division of
    // two 18-digit amounts.
    ratio: current && boughtRaw > 0n ? Number((burnedRaw * 1_000_000n) / boughtRaw) / 1_000_000 : null,
  };
}

// What the record does not establish, once the buyback is traced. Each is a
// question chain data cannot answer, stated with the figures that make it one.
function unverifiedWithBuyback(buyback, destroyedRaw) {
  const pct = (ppm) => (Number.isFinite(ppm) ? `${(ppm / 10_000).toFixed(1)}%` : "an unmeasured share");
  const short = (address) => `${address.slice(0, 8)}…`;
  const others = (buyback.otherRecipients ?? []).filter((r) => r.sharePpm >= 10_000).slice(0, 2);
  const share = Number.isFinite(buyback.jto.treasurySharePpm)
    ? `${(buyback.jto.treasurySharePpm / 10_000).toFixed(2)}%` : "an unmeasured share";
  // How many sweeps paid the treasury about 64%: counted from the split patterns,
  // so the sentence stays true as sweeps accumulate rather than frozen at today.
  const at64 = (buyback.splitPatterns ?? [])
    .filter((p) => p.basisPoints?.treasury >= 6300 && p.basisPoints?.treasury <= 6500)
    .reduce((sum, p) => sum + p.sweeps, 0);
  const fraction = buyback.sweeps > 0 ? at64 / buyback.sweeps : 0;
  const howMany = fraction >= 0.4 && fraction <= 0.6 ? "about half of all sweeps" : `${Math.round(fraction * 100)}% of sweeps`;
  return [
    others.length
      ? `Who controls the other recipients of swept JTO: ${others.map((r) => `${short(r.owner)} (${pct(r.sharePpm)})`).join(" and ")}.`
      : "Who controls the other recipients of swept JTO.",
    at64 > 0
      ? `Why ${howMany} pay the treasury 64% rather than 80%. Overall it received ${share}.`
      : `Why the treasury received ${share} of the JTO bought rather than 80%.`,
    "The USD value of fees paid in tokens other than stablecoins.",
    `The dates of the ${units(destroyedRaw)} JTO destroyed before activation.`,
  ];
}

// The on-chain fee measurement (fees.mjs --summary): fees swept plus still held.
function feesBlock(f) {
  requireThat(f && Array.isArray(f.stablecoins) && Array.isArray(f.tokens), "not a fees.mjs summary");
  return {
    source: "chain",
    producedBy: "fees.mjs",
    generatedAt: f.generatedAt ?? null,
    sweptThrough: f.sweptThrough ?? null,
    heldReadAt: f.heldReadAt ?? null,
    gapHours: f.gapHours ?? null,
    complete: f.complete === true,
    feeHoldingAccounts: f.feeHoldingAccounts ?? null,
    everSwept: f.everSwept ?? null,
    unresolvedBalanceReads: f.unresolvedBalanceReads ?? null,
    // Per token, exact. Never summed across tokens: this project holds no prices.
    stablecoins: f.stablecoins.map((c) => ({
      symbol: c.symbol,
      mint: c.mint,
      decimals: c.decimals,
      sweptRaw: digits(c.sweptRaw, `${c.symbol} sweptRaw`),
      heldRaw: digits(c.heldRaw, `${c.symbol} heldRaw`),
      collectedRaw: digits(c.collectedRaw, `${c.symbol} collectedRaw`),
      collected: units(raw(c.collectedRaw), c.decimals),
    })),
    otherTokens: f.tokens.length - f.stablecoins.length,
    notEstablished: f.notEstablished ?? [],
    detail: "/fees.json",
  };
}

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
