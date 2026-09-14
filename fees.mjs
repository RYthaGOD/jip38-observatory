// JTX fees collected, measured on chain: what has been swept, plus what has
// not been swept yet.
//
//   node track.mjs --resume --poll    # bring the treasury ledger up to now
//   node sweeps.mjs                    # resolve any new sweeps (resumable)
//   node fees.mjs                      # read unswept balances, and reconcile
//   node fees.mjs --report --summary FEES.json
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// sweeps.mjs proves the buyback is executing: 16,670 fee sweeps bought JTO for
// the DAO. What it cannot show is whether EVERY fee is swept, because a fee that
// was collected and never swept never appears in a sweep. That is the check the
// operator's Dune figure was meant to provide, and this replaces it with chain.
//
//   fees collected  =  fees already swept  +  fees still held by the program
//
// Both sides are exact base units, per token.
//
// Three things this is careful about, each of which was wrong in a first draft:
//
// 1. WHAT COUNTS AS A FEE. A sweep's token outflows include the intermediate
//    pool of a multi-hop route, so summing them all double-counts. Only outflows
//    from accounts OWNED BY THE JTX PROGRAM are fees; everything else in a sweep
//    is a DEX pool the swap routed through.
//
// 2. WHICH ACCOUNTS HOLD FEES. The program owns ~4,000 accounts of several types.
//    The fee-holding type is not assumed: it is taken from the accounts actually
//    observed giving up fees in sweeps, and every account of that type is read —
//    including the ones that have never been swept.
//
// 3. THE TWO SIDES MUST DESCRIBE THE SAME MOMENT. Swept fees run to the ledger's
//    cutoff; unswept balances are read when this runs. A fee swept in between
//    appears in neither. So this refuses to call the result complete unless the
//    last sweep it knows about is recent relative to the balance read, and it
//    prints both instants so the gap is never hidden.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { createRpc } from "./rpc.mjs";
import { atomicWrite, integer, arg, safeError, readJsonFile, requireThat } from "./core.mjs";

try { process.loadEnvFile(".env"); } catch { /* --report needs no key */ }

const JTX_PROGRAM = "JTXJTXfr1wVRMEzqiPhXUr69zJtfGuLh5qEiXG772Zj";
const TOKEN_PROGRAMS = {
  "SPL Token": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "Token-2022": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
};
const SWEEP_IX = ["FeeSweepPrepare", "FeeSweepFinalize"];
const STATE_VERSION = 1;

const SWEEPS = arg("--sweeps", "data/sweeps-state.json");
const STATE = arg("--state", "data/fees-state.json");
const RATE = integer(arg("--rate", "10"), "--rate", 1, 40);
// How stale the last known sweep may be, relative to the balance read, before
// the two halves are reported as describing different moments.
const MAX_GAP_HOURS = integer(arg("--max-gap-hours", "8"), "--max-gap-hours", 1, 720);
const REPORT_ONLY = process.argv.includes("--report");

// Refuse a summary path that is the checkpoint path. On a case-insensitive
// filesystem data/fees-state.json and DATA/FEES-STATE.json are one
// file, and writing the summary there would silently destroy the decoded state
// it was produced from — which happened in a test before this guard existed.
{
  const out = arg("--summary", null);
  const { resolve } = await import("node:path");
  if (out && resolve(out).toLowerCase() === resolve(STATE).toLowerCase()) {
    console.error(`fees: --summary ${out} is the checkpoint file itself; choose another path`);
    process.exit(2);
  }
}


const sweepsState = readJsonFile(SWEEPS, "the decoded sweeps from sweeps.mjs");
const sweeps = Object.values(sweepsState.resolved).filter((r) => r.jtxIx.some((n) => SWEEP_IX.includes(n)));
requireThat(sweeps.length > 0, `${SWEEPS} holds no sweeps — run sweeps.mjs first`);
const lastSweepAt = Math.max(...sweeps.map((r) => r.t));

const state = existsSync(STATE) ? readJsonFile(STATE, "the fees checkpoint") : { version: STATE_VERSION };
requireThat(state.version === STATE_VERSION, `${STATE} is version ${state.version}, expected ${STATE_VERSION}`);

// --- read the chain ----------------------------------------------------------

if (!REPORT_ONLY) {
  const RPC = process.env.SOLANA_RPC_URL;
  requireThat(RPC, "no SOLANA_RPC_URL (use --report to summarise the checkpoint)");
  const client = createRpc({ url: RPC, rate: RATE, maxBatch: 8 });

  // 1. Every account the program owns. One byte of data is enough: the first
  //    byte is the account's type tag, and the RPC reports each account's size.
  const gpa = await client.call("getProgramAccounts",
    [JTX_PROGRAM, { encoding: "base64", dataSlice: { offset: 0, length: 1 }, withContext: true }]);
  const all = (gpa.value ?? gpa).map((a) => ({
    pubkey: a.pubkey, tag: Buffer.from(a.account.data[0], "base64")[0], space: a.account.space,
  }));
  console.log(`fees: the JTX program owns ${all.length.toLocaleString()} accounts (slot ${gpa.context?.slot})`);

  // 2. Which types hold fees: whatever types the observed fee payers belong to.
  const payers = new Set(sweeps.flatMap((r) => r.spent.map((s) => s.owner)));
  const typeOf = (a) => `${a.tag}|${a.space}`;
  const feeTypes = new Set(all.filter((a) => payers.has(a.pubkey)).map(typeOf));
  const holders = all.filter((a) => feeTypes.has(typeOf(a)));
  console.log(`      fee-holding type(s) observed in sweeps: ${[...feeTypes].map((t) => `tag ${t.split("|")[0]} / ${t.split("|")[1]}B`).join(", ")}`);
  console.log(`      ${holders.length.toLocaleString()} accounts of that type; ${holders.filter((a) => payers.has(a.pubkey)).length.toLocaleString()} have ever been swept`);

  // 3. Every token balance they hold, under both token programs.
  const queries = holders.flatMap((a) => Object.entries(TOKEN_PROGRAMS)
    .map(([program, id]) => ({ owner: a.pubkey, program, params: [a.pubkey, { programId: id }, { encoding: "jsonParsed" }] })));
  const balances = [];
  const unresolved = [];
  let slotMin = Infinity, slotMax = 0;
  for (let i = 0; i < queries.length; i += 40) {
    const chunk = queries.slice(i, i + 40);
    const out = await client.batchSettled("getTokenAccountsByOwner", chunk.map((q) => q.params));
    out.forEach((o, n) => {
      if (!o.ok) { unresolved.push(chunk[n].owner); return; }
      const slot = o.result.context?.slot;
      if (slot) { slotMin = Math.min(slotMin, slot); slotMax = Math.max(slotMax, slot); }
      for (const ta of o.result.value) {
        const info = ta.account.data.parsed.info;
        if (info.tokenAmount.amount === "0") continue;
        balances.push({ owner: chunk[n].owner, program: chunk[n].program, mint: info.mint,
          raw: info.tokenAmount.amount, decimals: info.tokenAmount.decimals });
      }
    });
    if (i % 800 === 0) process.stdout.write(`      ${Math.min(i + 40, queries.length)}/${queries.length} balance queries, ${client.status()}      \r`);
  }
  console.log(`\n      done: ${balances.length} non-zero balances, ${unresolved.length} unresolved queries`);

  Object.assign(state, {
    readAt: new Date().toISOString(),
    programAccounts: all.length,
    feeTypes: [...feeTypes],
    holderCount: holders.length,
    everSwept: holders.filter((a) => payers.has(a.pubkey)).length,
    holderSet: holders.map((a) => a.pubkey),
    slotRange: { from: slotMin, to: slotMax },
    balances,
    unresolved,
  });
  atomicWrite(STATE, JSON.stringify(state));
}

// --- report ------------------------------------------------------------------

requireThat(state.readAt, `${STATE} has no balance read — run fees.mjs without --report first`);
const holderSet = new Set(state.holderSet);
const gapHours = (Date.parse(state.readAt) / 1000 - lastSweepAt) / 3600;

// Swept fees: outflows from fee-holding accounts only. Pool hops excluded.
const swept = new Map();
for (const r of sweeps) for (const s of r.spent) {
  if (!holderSet.has(s.owner)) continue;
  swept.set(s.mint, (swept.get(s.mint) ?? 0n) + -BigInt(s.raw));
}
const unswept = new Map();
const decimals = new Map();
for (const b of state.balances) {
  unswept.set(b.mint, (unswept.get(b.mint) ?? 0n) + BigInt(b.raw));
  decimals.set(b.mint, b.decimals);
}

const KNOWN = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: ["USDC", 6, true],
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: ["USDT", 6, true],
  So11111111111111111111111111111111111111112: ["wSOL", 9, false],
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: ["JitoSOL", 9, false],
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: ["JTO", 9, false],
};
const fmt = (raw, d) => {
  if (d === undefined) return `${raw} base units`;
  const s = raw < 0n ? "-" : "", a = raw < 0n ? -raw : raw, sc = 10n ** BigInt(d);
  return `${s}${(a / sc).toLocaleString()}.${(a % sc).toString().padStart(d, "0").slice(0, Math.min(d, 6))}`;
};

const mints = [...new Set([...swept.keys(), ...unswept.keys()])];
const complete = state.unresolved.length === 0 && gapHours <= MAX_GAP_HOURS;

console.log("\n" + "=".repeat(72));
console.log("JTX FEES ON CHAIN: SWEPT + STILL HELD");
console.log("=".repeat(72));
console.log(`fee-holding accounts   ${state.holderCount.toLocaleString()} (of ${state.programAccounts.toLocaleString()} the program owns); ${state.everSwept.toLocaleString()} ever swept`);
console.log(`swept side runs to     ${new Date(lastSweepAt * 1000).toISOString()}  (last sweep in the ledger)`);
console.log(`held side read at      ${state.readAt}  (slots ${state.slotRange.from}–${state.slotRange.to})`);
console.log(`gap between them       ${gapHours.toFixed(1)} h${gapHours > MAX_GAP_HOURS ? `  — MORE THAN ${MAX_GAP_HOURS}h: fees swept in this window are in NEITHER side` : ""}`);
if (state.unresolved.length) console.log(`unresolved balance reads ${state.unresolved.length} — the held side is INCOMPLETE`);
console.log(`\ndistinct fee tokens    ${mints.length}   (${[...swept.keys()].length} ever swept, ${[...unswept.keys()].length} currently held)`);

console.log("\nstablecoins, where units are dollars:");
for (const [mint, [name, d, stable]] of Object.entries(KNOWN)) {
  if (!stable) continue;
  const s = swept.get(mint) ?? 0n, u = unswept.get(mint) ?? 0n;
  console.log(`  ${name.padEnd(8)} swept ${fmt(s, d).padStart(18)}   held ${fmt(u, d).padStart(16)}   collected ${fmt(s + u, d).padStart(18)}`);
}
console.log("\nlargest other tokens by count held unswept (no prices — not comparable across tokens):");
for (const mint of [...unswept.keys()].filter((m) => !KNOWN[m]?.[2])
  .sort((a, b) => Number(unswept.get(b) / 10n ** BigInt(decimals.get(b) ?? 0)) - Number(unswept.get(a) / 10n ** BigInt(decimals.get(a) ?? 0))).slice(0, 8)) {
  const d = decimals.get(mint) ?? KNOWN[mint]?.[1];
  console.log(`  ${(KNOWN[mint]?.[0] ?? mint.slice(0, 10) + "…").padEnd(12)} held ${fmt(unswept.get(mint), d).padStart(20)}   swept ${fmt(swept.get(mint) ?? 0n, d).padStart(20)}`);
}
console.log("\n" + (complete
  ? "COMPLETE: every fee-holding account was read, and the two sides are within the gap allowed."
  : "NOT COMPLETE: see the gap and unresolved counts above before using these as collected-fee totals."));

const SUMMARY = arg("--summary", null);
if (SUMMARY) {
  const row = (m) => ({
    mint: m, symbol: KNOWN[m]?.[0] ?? null, decimals: decimals.get(m) ?? KNOWN[m]?.[1] ?? null,
    sweptRaw: (swept.get(m) ?? 0n).toString(), heldRaw: (unswept.get(m) ?? 0n).toString(),
    collectedRaw: ((swept.get(m) ?? 0n) + (unswept.get(m) ?? 0n)).toString(),
  });
  atomicWrite(SUMMARY, `${JSON.stringify({
    _comment: [
      "JTX fees measured on chain: swept (outflows from JTX fee accounts in sweeps) plus held (balances read now).",
      "Produced by fees.mjs. Exact base units per token; no prices, so tokens are not summed together.",
    ],
    generatedAt: new Date().toISOString(),
    program: JTX_PROGRAM,
    sweptThrough: new Date(lastSweepAt * 1000).toISOString(),
    heldReadAt: state.readAt,
    heldSlotRange: state.slotRange,
    gapHours: Number(gapHours.toFixed(2)),
    complete,
    feeHoldingAccounts: state.holderCount,
    programAccounts: state.programAccounts,
    everSwept: state.everSwept,
    unresolvedBalanceReads: state.unresolved.length,
    stablecoins: Object.entries(KNOWN).filter(([, v]) => v[2]).map(([m]) => row(m)),
    tokens: mints.map(row),
    notEstablished: [
      "The USD value of non-stablecoin fees: this project holds no price series.",
      "What a fee-holding account represents (per trader, per market): the program's IDL is not public here.",
      "Fees routed somewhere other than the JTX program's own fee-holding accounts.",
    ],
  }, null, 2)}\n`);
  console.log(`wrote ${SUMMARY}`);
}
