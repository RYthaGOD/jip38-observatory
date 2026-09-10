// Enumerate JTO burns from the chain directly, asking nothing to classify them.
//
//   node rawscan.mjs --sample 20         # unbiased sample across the whole history
//   node rawscan.mjs --since 2026-07-13  # exhaustive over the JIP-38 window
//   node rawscan.mjs --resume            # continue an interrupted exhaustive run
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// discover.mjs and ledger.mjs find burns by asking a burn-filtered index for
// them. On 2026-09-09 that method was proven unsound (FINDINGS.md §2a): the
// chain says at least 13,477,142 JTO has been destroyed — the mint was created
// with exactly 1,000,000,000 JTO and mintAuthority is null, so supply can fall
// by no other mechanism — while the index, sampled across the whole of JTO's
// history, returns a largest-ever burn of 0.96 JTO.
//
// This script removes the index from the loop. It pages getSignaturesForAddress
// over the mint, which is the chain's own complete record of every transaction
// touching that account, resolves each one with getTransaction, and reads burns
// out of the parsed instructions. Nothing decides what is "a burn transaction"
// except the instruction itself, so nothing can filter one out.
//
// It is expensive — the JIP-38 window holds an estimated 2.04M transactions —
// and that is the point. Soundness is the requirement.
//
// --sample takes an unbiased read instead: raw windows spread across history,
// every transaction in them resolved. It is cheap, it measures the index's true
// recall against ground truth, and it shows the real burn size distribution
// rather than the one the index chose to show.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

try { process.loadEnvFile(".env"); } catch {}

const MINT = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";
const GENESIS_SUPPLY = 1_000_000_000;          // verified on chain, see FINDINGS.md §2
const MINT_CREATED = Date.parse("2023-11-27T20:41:24Z") / 1000;

const RPC = process.env.SOLANA_RPC_URL || arg("--rpc", "");
const SINCE_ARG = arg("--since", "2026-07-13");
const SAMPLE = Number(arg("--sample", "0"));
const SAMPLE_TX = Number(arg("--sample-tx", "4000"));  // transactions per sample window
const SEGMENTS = Number(arg("--segments", "12"));
const CONC = Number(arg("--concurrency", "4"));
const BATCH = Number(arg("--batch", "50"));
const RESUME = process.argv.includes("--resume");
const OUT = arg("--out", SAMPLE ? "BURNS-sample.tsv" : "BURNS-raw.tsv");
const STATE = arg("--state", "data/rawscan-state.json");

function arg(f, d) { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
function die(m) { console.error("rawscan: " + m); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
const fmt = (n, d = 9) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
if (!RPC) die("no RPC endpoint. Set SOLANA_RPC_URL in .env or pass --rpc.");

// Rate limits are the binding constraint, not bandwidth. Backing off and
// retrying matters more than speed: a request abandoned mid-scan would drop
// transactions silently, and a dropped transaction is a dropped burn.
let rateLimited = 0, requests = 0;
async function post(body, tries = 10) {
  for (let a = 0; a < tries; a++) {
    try {
      requests++;
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
      if (r.status === 429 || r.status >= 500) { rateLimited++; await sleep(Math.min(600 * 2 ** a, 20000)); continue; }
      const text = await r.text();
      try { return JSON.parse(text); } catch { await sleep(Math.min(600 * 2 ** a, 20000)); }
    } catch { await sleep(Math.min(600 * 2 ** a, 20000)); }
  }
  return null;
}
const rpc = async (m, p) => (await post({ jsonrpc: "2.0", id: 1, method: m, params: p }))?.result;

const slotNow = await rpc("getSlot", []);
const nowSec = await rpc("getBlockTime", [slotNow]);
const supply0 = await rpc("getTokenSupply", [MINT]);
const DECIMALS = supply0.value.decimals;
const currentSupply = Number(supply0.value.uiAmountString);

// Slot time is not 400ms and drifts by a month over three years, so anchors are
// found by binary-searching real block times rather than estimated.
async function firstBlockAtOrAfter(slot) {
  for (let w = 300; w <= 400000; w *= 5) {
    const blocks = await rpc("getBlocks", [slot, Math.min(slot + w, slotNow)]);
    if (blocks?.length) {
      const b = await rpc("getBlock", [blocks[0], { transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 0 }]);
      if (b?.signatures?.length) return { slot: blocks[0], time: b.blockTime, sig: b.signatures[0] };
    }
    if (slot + w >= slotNow) break;
  }
  return null;
}
async function anchorAt(target) {
  let lo = 1, hi = slotNow;
  while (hi - lo > 3000) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await firstBlockAtOrAfter(mid);
    if (!r) { lo = mid; continue; }
    // firstBlockAtOrAfter can return a slot beyond the current upper bound when
    // a long run of slots is skipped. Clamping keeps the interval shrinking;
    // without it the search can widen and never terminate.
    if (r.time < target) lo = Math.max(lo + 1, r.slot + 1);
    else hi = Math.max(lo, Math.min(hi, r.slot));
  }
  return await firstBlockAtOrAfter(lo);
}

// Read every JTO burn instruction out of a batch of resolved transactions.
// A burn is taken from the parsed instruction and nowhere else, so a transfer
// to a terminal-looking address can never be counted as a supply reduction —
// those are different claims and JIP-38 promises the stronger one.
function burnsFrom(txs) {
  const out = [];
  for (const tx of txs) {
    if (!tx || tx.meta?.err) continue;
    const ins = [...(tx.transaction.message.instructions || []),
      ...(tx.meta?.innerInstructions || []).flatMap((x) => x.instructions || [])];
    const parsed = ins.map((x) => x.parsed).filter(Boolean);
    const closes = parsed.filter((p) => p.type === "closeAccount").length;
    const others = new Set(parsed.filter((p) => /^burn/.test(p.type)).map((p) => p.info.mint).filter((m) => m !== MINT));
    for (const x of ins) {
      const p = x.parsed;
      if (!p || !/^burn/.test(p.type) || p.info.mint !== MINT) continue;
      const raw = BigInt(p.info.tokenAmount?.amount ?? p.info.amount ?? 0);
      out.push({
        sig: tx.transaction.signatures[0], slot: tx.slot, time: tx.blockTime,
        authority: p.info.authority || p.info.multisigAuthority || "(unknown)",
        account: p.info.account, raw, amount: Number(raw) / 10 ** DECIMALS,
        closes, otherMints: others.size,
      });
    }
  }
  return out;
}

// Resolve a list of signatures in batches.
async function resolve(sigs) {
  const found = [];
  for (let i = 0; i < sigs.length; i += BATCH) {
    const chunk = sigs.slice(i, i + BATCH);
    const res = await post(chunk.map((s, n) => ({ jsonrpc: "2.0", id: n, method: "getTransaction",
      params: [s, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }] })));
    if (!Array.isArray(res)) continue;
    found.push(...burnsFrom(res.map((r) => r.result)));
  }
  return found;
}

const allBurns = [];
let scannedTx = 0;

// ===========================================================================
// SAMPLE MODE — unbiased windows across the whole history
// ===========================================================================
if (SAMPLE) {
  console.log(`rawscan --sample: ${SAMPLE} windows x ~${SAMPLE_TX} transactions, raw from chain`);
  console.log(`history: ${iso(MINT_CREATED)} -> ${iso(nowSec)}\n`);
  const span = nowSec - MINT_CREATED;
  const targets = [];
  for (let i = 0; i < SAMPLE; i++) targets.push(MINT_CREATED + Math.round((span * (i + 0.5)) / SAMPLE));

  const windows = [];
  let done = 0;
  const queue = [...targets];
  await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, async () => {
    while (queue.length) {
      const t = queue.shift();
      const a = await anchorAt(t);
      if (!a) { done++; continue; }
      let before = a.sig, sigs = [], oldest = a.time, newest = a.time;
      while (sigs.length < SAMPLE_TX) {
        const p = await rpc("getSignaturesForAddress", [MINT, { limit: 1000, before }]);
        if (!p?.length) break;
        for (const s of p) if (!s.err) sigs.push(s.signature);
        newest = Math.max(newest, p[0].blockTime ?? newest);
        oldest = p[p.length - 1].blockTime ?? oldest;
        before = p[p.length - 1].signature;
      }
      const burns = await resolve(sigs);
      scannedTx += sigs.length;
      allBurns.push(...burns);
      windows.push({ at: a.time, n: sigs.length, burns: burns.length, oldest, newest });
      done++;
      process.stdout.write(`  ${done}/${SAMPLE} windows, ${scannedTx} tx scanned, ${allBurns.length} burns   \r`);
    }
  }));
  console.log(`  ${done}/${SAMPLE} windows, ${scannedTx} tx scanned, ${allBurns.length} burns          \n`);
  windows.sort((a, b) => a.at - b.at);
  console.log("window                     tx      burns");
  for (const w of windows) console.log(`  ${iso(w.oldest).slice(0, 16)}  ${String(w.n).padStart(6)}  ${String(w.burns).padStart(6)}`);

// ===========================================================================
// EXHAUSTIVE MODE — every transaction in the window
// ===========================================================================
} else {
  const SINCE = Date.parse(SINCE_ARG + "T00:00:00Z") / 1000;
  console.log(`rawscan: exhaustive, ${SINCE_ARG} -> ${iso(nowSec)} (${((nowSec - SINCE) / 86400).toFixed(1)} days)`);
  console.log("every transaction referencing the mint, resolved from chain\n");

  mkdirSync(dirname(STATE), { recursive: true });
  let state = { since: SINCE, segments: [], burns: [], scanned: 0 };
  if (RESUME && existsSync(STATE)) {
    state = JSON.parse(readFileSync(STATE, "utf8"));
    if (state.since !== SINCE) die(`checkpoint is for --since ${iso(state.since).slice(0, 10)}; delete ${STATE} or match it`);
    console.log(`resuming: ${state.segments.filter((s) => s.done).length}/${state.segments.length} segments, ` +
      `${state.scanned} tx scanned, ${state.burns.length} burns\n`);
  } else {
    const span = nowSec - SINCE;
    for (let i = 0; i < SEGMENTS; i++) {
      state.segments.push({
        top: SINCE + Math.round((span * (i + 1)) / SEGMENTS),
        bottom: SINCE + Math.round((span * i) / SEGMENTS),
        cursor: null, reached: null, done: false, scanned: 0,
      });
    }
  }
  const save = () => writeFileSync(STATE, JSON.stringify(state));

  async function runSegment(seg) {
    if (seg.done) return;
    if (!seg.cursor) {
      const a = await anchorAt(seg.top);
      if (!a) { seg.done = true; return; }
      seg.cursor = a.sig; seg.reached = a.time;
    }
    while (!seg.done) {
      const p = await rpc("getSignaturesForAddress", [MINT, { limit: 1000, before: seg.cursor }]);
      if (!p?.length) { seg.done = true; break; }
      const keep = p.filter((s) => !s.err && (s.blockTime ?? 0) >= seg.bottom).map((s) => s.signature);
      const burns = await resolve(keep);
      for (const b of burns) state.burns.push({ ...b, raw: b.raw.toString() });
      seg.scanned += keep.length; state.scanned += keep.length;
      seg.cursor = p[p.length - 1].signature;
      seg.reached = p[p.length - 1].blockTime ?? seg.reached;
      if (seg.reached <= seg.bottom) seg.done = true;
      save();
      process.stdout.write(`  ${state.segments.filter((s) => s.done).length}/${state.segments.length} seg, ` +
        `${state.scanned} tx, ${state.burns.length} burns, ${requests} reqs (${rateLimited} throttled)   \r`);
    }
    save();
  }

  const queue = state.segments.filter((s) => !s.done);
  await Promise.all(Array.from({ length: Math.min(CONC, Math.max(queue.length, 1)) }, async () => {
    while (queue.length) await runSegment(queue.shift());
  }));
  console.log("");
  allBurns.push(...state.burns.map((b) => ({ ...b, raw: BigInt(b.raw) })));
  scannedTx = state.scanned;
}

// ===========================================================================
// report
// ===========================================================================
// Segments are seeded at their own top and walk down to the next segment's top,
// so they join without gaps — but an anchor can land a little above where the
// segment above it stopped, which double-counts a burn at the seam. Dedupe on
// the instruction's identity, because inflating a burn total is as wrong as
// understating one, just in the other direction.
{
  const seen = new Set();
  for (let i = allBurns.length - 1; i >= 0; i--) {
    const k = `${allBurns[i].sig}|${allBurns[i].account}|${allBurns[i].raw}`;
    if (seen.has(k)) allBurns.splice(i, 1); else seen.add(k);
  }
}

allBurns.sort((a, b) => Number(b.raw - a.raw));
const totalRaw = allBurns.reduce((s, b) => s + b.raw, 0n);
const total = Number(totalRaw) / 10 ** DECIMALS;

writeFileSync(OUT,
  "# JTO burns read directly from chain — no index, no classifier.\n" +
  "# Every row is a burn INSTRUCTION parsed out of a transaction resolved with\n" +
  "# getTransaction, so one transaction may appear more than once.\n" +
  `# scanned: ${scannedTx} transactions\n# generated: ${new Date().toISOString()}\n#\n` +
  "signature\tslot\tblock_time\tutc\tauthority\ttoken_account\tamount_jto\traw\tcloses\tother_mints\n" +
  allBurns.map((b) => [b.sig, b.slot, b.time, iso(b.time), b.authority, b.account,
    (Number(b.raw) / 10 ** DECIMALS).toFixed(DECIMALS), b.raw.toString(), b.closes, b.otherMints].join("\t")).join("\n") + "\n");

console.log(`\nwrote ${OUT}`);
console.log(`transactions scanned : ${fmt(scannedTx, 0)}`);
console.log(`burn instructions    : ${fmt(allBurns.length, 0)}`);
console.log(`JTO burned in scan   : ${fmt(total)}`);
console.log(`requests             : ${fmt(requests, 0)} (${fmt(rateLimited, 0)} throttled)`);

if (allBurns.length) {
  console.log("\nlargest burns found:");
  for (const b of allBurns.slice(0, 12)) {
    console.log(`  ${fmt(b.amount, 6).padStart(20)} JTO  ${iso(b.time).slice(0, 19)}  closes=${String(b.closes).padStart(2)}  ${b.authority}`);
  }
  const big = allBurns.filter((b) => b.amount >= 100);
  console.log(`\nburns >= 100 JTO: ${big.length}`);
  const byAuth = new Map();
  for (const b of allBurns) {
    const e = byAuth.get(b.authority) || { n: 0, total: 0 };
    e.n++; e.total += b.amount; byAuth.set(b.authority, e);
  }
  console.log(`distinct burn authorities: ${byAuth.size}`);
  console.log("\ntop authorities by volume:");
  for (const [a, e] of [...byAuth.entries()].sort((x, y) => y[1].total - x[1].total).slice(0, 10)) {
    console.log(`  ${fmt(e.total, 6).padStart(20)} JTO  ${String(e.n).padStart(5)} burn(s)  ${a}`);
  }
}

// The invariant that exposed the index. It applies here too: whatever this scan
// found has to be reconciled against the supply decline, and saying how far
// short it falls is more useful than any total on its own.
const destroyed = GENESIS_SUPPLY - currentSupply;
console.log("\n" + "=".repeat(70));
console.log(`JTO destroyed since genesis (chain) : ${fmt(destroyed)}`);
console.log(`accounted for by this scan          : ${fmt(total)}`);
console.log(`unaccounted                         : ${fmt(destroyed - total)}`);
console.log("=".repeat(70));
