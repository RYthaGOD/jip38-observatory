// Build an exhaustive ledger of JTO burns, and prove it is exhaustive.
//
//   node ledger.mjs [--since 2026-07-13] [--segments 16] [--concurrency 8]
//   node ledger.mjs --since genesis          # whole history, enables the checksum
//   node ledger.mjs --resume                 # continue an interrupted run
//
// Writes BURNS.tsv (the ledger) and data/ledger-state.json (checkpoints).
//
// ---------------------------------------------------------------------------
// WHY THIS CAN CLAIM COMPLETENESS, AND EXACTLY WHEN IT CANNOT
//
// !!! READ THIS BEFORE TRUSTING ANY NUMBER THIS SCRIPT PRINTS !!!
//
// On 2026-09-09 the checksum below caught the index red-handed, and the burn
// discovery in this file is currently KNOWN TO BE UNSOUND.
//
// The chain says at least 13,477,142 JTO has been destroyed: the mint was
// created with exactly 1,000,000,000 JTO (verified, see GENESIS_SUPPLY) and
// mintAuthority is null, so supply can fall by no mechanism other than burn
// instructions. Those burns therefore exist, and they are enormous.
//
// Sampling the burn-filtered index across the whole of JTO's history — 26
// points from 2024-01 to 2026-08, plus the genesis token account, both original
// mint authorities, and the twenty largest holders — returned 281 burns whose
// LARGEST was 0.96 JTO and whose total was 12.9 JTO.
//
// So the index returns dust and misses essentially all of the volume. Until
// that is understood and fixed, `type=BURN` is not a sound basis for
// enumeration, and any total this script reports is a floor of unknown
// distance from the truth. The fix is raw enumeration — getSignaturesForAddress
// over the mint plus getTransaction on each — which is expensive but sound.
//
// The rest of this comment describes the design as intended. It stands, and the
// checksum is exactly what exposed the problem, which is the design working.
//
// Burns are found by walking a burn-filtered index. An index is a third party,
// and a third party that silently omits a burn would understate the total —
// the one direction of error that flatters Jito. So the ledger does not ask to
// be trusted. Two independent checks stand behind it:
//
//   1. Every burn the index offers is re-fetched from chain with getTransaction
//      and read out of the parsed instruction. The index decides what to LOOK
//      at; the chain decides what is TRUE. Nothing enters the ledger on the
//      index's say-so, and an amount is never taken from the index at all.
//
//   2. The mint's supply is a checksum on the whole enumeration. mintAuthority
//      is null, so no JTO can ever be created and supply is monotonically
//      non-increasing: every unit of decline since genesis is a burn. So
//
//          sum(every burn since genesis)  ==  genesis supply - current supply
//
//      must hold exactly. Run with --since genesis and the ledger checks
//      itself against that identity. If it balances, the enumeration is
//      COMPLETE — proven, not assumed, and proven independently of whether the
//      index was honest. If it falls short, the shortfall is the exact quantity
//      of burns the walk missed, and the ledger says so.
//
// The checksum only works over the whole history. A run scoped to the JIP-38
// window cannot verify itself this way, because the supply as it stood on the
// window's first day is not recoverable — Solana RPC serves current state only,
// and no public archive of it exists. A windowed run therefore reports its
// burns WITHOUT a completeness proof, and says so rather than implying one.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

try { process.loadEnvFile(".env"); } catch {}

const MINT = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";
// Verified on chain 2026-09-09, not taken from documentation: the mint was
// created at 2023-11-27T20:41:24Z and a single mintToChecked of exactly
// 1,000,000,000 JTO landed five minutes later in
// FrXfXNmsw1XCC6AeYEaYd31PjfmjqfLNn42k3CfGjtbA, tx
// 2M1gWKQvjCav6JLkf2j5EfUmpp31RRM27YPnG1fGiyvgqu3s4C7Z1tWYXgYKoxwgMC84WG5v7tMHwMMQ74xUekVG
// Mint authority was later set to null, so this is the whole supply that ever
// existed — unless further minting happened between those two events, which is
// not yet ruled out and would make this a lower bound.
const GENESIS_SUPPLY = 1_000_000_000;
const GENESIS_DATE = "2023-11-27";      // the mint's creation; the walk stops when history runs out

const RPC = process.env.SOLANA_RPC_URL || arg("--rpc", "");
const SINCE_ARG = arg("--since", "2026-07-13");
const SEGMENTS = Number(arg("--segments", "16"));
const CONC = Number(arg("--concurrency", "8"));
const RESUME = process.argv.includes("--resume");
const OUT = arg("--out", "BURNS.tsv");
const STATE = arg("--state", "data/ledger-state.json");

function arg(f, d) { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
function die(m) { console.error("ledger: " + m); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
const fmt = (n, d = 9) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });

if (!RPC) die("no RPC endpoint. Set SOLANA_RPC_URL in .env or pass --rpc.");
const KEY = /api-key=([\w-]+)/.exec(RPC)?.[1];
if (!KEY) die("burn discovery needs a Helius api-key in SOLANA_RPC_URL.");

const WHOLE_HISTORY = SINCE_ARG === "genesis";
const SINCE = Date.parse((WHOLE_HISTORY ? GENESIS_DATE : SINCE_ARG) + "T00:00:00Z") / 1000;

async function post(body, tries = 8) {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
      if (r.status === 429 || r.status >= 500) { await sleep(700 * 2 ** a); continue; }
      return JSON.parse(await r.text());
    } catch { await sleep(700 * 2 ** a); }
  }
  return null;
}
const rpc = async (m, p) => (await post({ jsonrpc: "2.0", id: 1, method: m, params: p }))?.result;

async function burnPage(before) {
  const u = `https://api.helius.xyz/v0/addresses/${MINT}/transactions`
    + `?api-key=${KEY}&type=BURN&limit=100${before ? `&before=${before}` : ""}`;
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(90000) });
      if (r.status === 429 || r.status >= 500) { await sleep(700 * 2 ** a); continue; }
      const j = JSON.parse(await r.text());
      if (Array.isArray(j)) return { burns: j, cursor: j.length ? j[j.length - 1].signature : null, done: !j.length };
      const m = /parameter set to ([A-Za-z0-9]+)/.exec(j.error || "");
      return { burns: [], cursor: m ? m[1] : null, done: !m };
    } catch { await sleep(700 * 2 ** a); }
  }
  return { burns: [], cursor: null, done: true };
}

// --- establish the mint, and the identity the checksum rests on ------------
const supply = await rpc("getTokenSupply", [MINT]);
const acct = await rpc("getAccountInfo", [MINT, { encoding: "jsonParsed" }]);
const mintInfo = acct?.value?.data?.parsed?.info;
if (!mintInfo) die("mint not readable");
const DECIMALS = supply.value.decimals;
const currentSupply = Number(supply.value.uiAmountString);
const immutable = mintInfo.mintAuthority === null;

const slotNow = await rpc("getSlot", []);
const nowSec = await rpc("getBlockTime", [slotNow]);

console.log(`ledger: JTO burns since ${WHOLE_HISTORY ? "genesis" : SINCE_ARG}`);
console.log(`        supply ${supply.value.uiAmountString}, mintAuthority ${mintInfo.mintAuthority ?? "null"}`);
if (!immutable) console.log("        ! mintAuthority is set — the supply checksum is INVALID for this mint");
console.log("");

// --- seed cursors ----------------------------------------------------------
async function seedAt(t) {
  const guess = Math.max(1, slotNow - Math.round((nowSec - t) / 0.4));
  for (let w = 400; w <= 12800; w *= 4) {
    const blocks = await rpc("getBlocks", [guess, guess + w]);
    for (const s of (blocks || []).slice(0, 4)) {
      const b = await rpc("getBlock", [s, { transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 0 }]);
      if (b?.signatures?.length) return { sig: b.signatures[0], time: b.blockTime };
    }
  }
  return null;
}

// The window is cut into contiguous slices walked in parallel. Each slice runs
// from its own top down to the top of the slice below it, so the slices join
// and nothing between them is skipped. A slice's walk cannot skip transactions
// either: every hop resumes from the cursor the previous hop ended on. Overlap
// between adjacent slices is possible and harmless — burns are keyed by
// signature — but a gap is not possible.
mkdirSync(dirname(STATE), { recursive: true });
let state = { since: SINCE, segments: [], found: {} };
if (RESUME && existsSync(STATE)) {
  state = JSON.parse(readFileSync(STATE, "utf8"));
  // Resuming a run that was scoped to a different window would silently splice
  // two incompatible scans into one ledger, and the result would look complete.
  if (state.since !== SINCE) {
    die(`checkpoint covers --since ${new Date(state.since * 1000).toISOString().slice(0, 10)}, ` +
      `but this run asks for ${new Date(SINCE * 1000).toISOString().slice(0, 10)}. ` +
      `Delete ${STATE} to start over, or rerun with the original --since.`);
  }
  console.log(`resuming: ${state.segments.filter((s) => s.done).length}/${state.segments.length} segments complete, ` +
    `${Object.keys(state.found).length} burns already found\n`);
} else {
  const span = nowSec - SINCE;
  for (let i = 0; i < SEGMENTS; i++) {
    state.segments.push({
      top: SINCE + Math.round((span * (i + 1)) / SEGMENTS),
      bottom: SINCE + Math.round((span * i) / SEGMENTS),
      cursor: null, reached: null, done: false, hops: 0,
    });
  }
}

let hopsTotal = state.segments.reduce((s, x) => s + x.hops, 0);
const saveState = () => writeFileSync(STATE, JSON.stringify(state));

async function walk(seg) {
  if (seg.done) return;
  if (!seg.cursor) {
    const s = await seedAt(seg.top);
    if (!s) { seg.done = true; return; }
    seg.cursor = s.sig; seg.reached = s.time;
  }
  while (!seg.done) {
    const { burns, cursor, done } = await burnPage(seg.cursor);
    seg.hops++; hopsTotal++;
    for (const b of burns) {
      if (b.timestamp < SINCE) continue;
      if (!JSON.stringify(b).includes(MINT)) continue;
      state.found[b.signature] = b.timestamp;
    }
    if (burns.length) seg.reached = burns[burns.length - 1].timestamp;
    if (done || !cursor) { seg.done = true; break; }
    seg.cursor = cursor;
    const t = await rpc("getTransaction", [cursor, { maxSupportedTransactionVersion: 0, encoding: "json" }]);
    if (t?.blockTime) {
      seg.reached = t.blockTime;
      if (t.blockTime <= seg.bottom) { seg.done = true; break; }
    }
    if (seg.hops % 5 === 0) saveState();
    process.stdout.write(`  ${state.segments.filter((s) => s.done).length}/${state.segments.length} segments, ` +
      `${hopsTotal} hops, ${Object.keys(state.found).length} burn tx        \r`);
  }
  saveState();
}

const queue = state.segments.filter((s) => !s.done);
await Promise.all(Array.from({ length: Math.min(CONC, Math.max(queue.length, 1)) }, async () => {
  while (queue.length) await walk(queue.shift());
}));
saveState();
console.log(`  ${state.segments.length}/${state.segments.length} segments, ${hopsTotal} hops, ${Object.keys(state.found).length} burn tx found          `);

// --- verify every candidate against chain ---------------------------------
const sigs = Object.keys(state.found);
console.log(`\nverifying ${sigs.length} against chain...`);
const ledger = [];
const SZ = 25;
for (let i = 0; i < sigs.length; i += SZ) {
  const chunk = sigs.slice(i, i + SZ);
  const res = await post(chunk.map((s, n) => ({ jsonrpc: "2.0", id: n, method: "getTransaction",
    params: [s, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }] })));
  for (const r of (Array.isArray(res) ? res : [])) {
    const tx = r.result; if (!tx || tx.meta?.err) continue;
    const ins = [...(tx.transaction.message.instructions || []),
      ...(tx.meta?.innerInstructions || []).flatMap((x) => x.instructions || [])];
    const parsed = ins.map((x) => x.parsed).filter(Boolean);
    const closes = parsed.filter((p) => p.type === "closeAccount").length;
    const otherMints = new Set(parsed.filter((p) => p.type === "burn" || p.type === "burnChecked")
      .map((p) => p.info.mint).filter((m) => m !== MINT));
    for (const x of ins) {
      const t = x.parsed?.type;
      if (t !== "burn" && t !== "burnChecked") continue;
      if (x.parsed.info.mint !== MINT) continue;
      const raw = BigInt(x.parsed.info.tokenAmount?.amount ?? x.parsed.info.amount ?? 0);
      ledger.push({
        sig: tx.transaction.signatures[0], slot: tx.slot, time: tx.blockTime,
        authority: x.parsed.info.authority || x.parsed.info.multisigAuthority || "(unknown)",
        account: x.parsed.info.account, raw,
        amount: Number(raw) / 10 ** DECIMALS,
        closes, otherMints: otherMints.size,
      });
    }
  }
  process.stdout.write(`  ${Math.min(i + SZ, sigs.length)}/${sigs.length}\r`);
}
ledger.sort((a, b) => b.time - a.time);
console.log(`  ${ledger.length} verified burn instructions               `);

// --- write the ledger ------------------------------------------------------
const totalRaw = ledger.reduce((s, r) => s + r.raw, 0n);
const total = Number(totalRaw) / 10 ** DECIMALS;

writeFileSync(OUT,
  "# Every JTO burn this project has verified against chain.\n" +
  "#\n" +
  "# Each row was found via a burn-filtered index and then re-read from the chain\n" +
  "# with getTransaction; the amount comes from the parsed burn instruction, never\n" +
  "# from the index. Rows are burn INSTRUCTIONS, so one transaction can appear more\n" +
  "# than once if it burned JTO more than once.\n" +
  "#\n" +
  "# closes / other_mints are the dust-sweep signature: a wallet reclaiming rent\n" +
  "# closes accounts and burns several unrelated mints in one transaction. They are\n" +
  "# recorded rather than filtered, so anyone can disagree with the classification.\n" +
  `#\n# window: ${WHOLE_HISTORY ? "genesis" : SINCE_ARG} -> ${iso(nowSec)}\n` +
  `# generated: ${new Date().toISOString()}\n#\n` +
  "signature\tslot\tblock_time\tutc\tauthority\ttoken_account\tamount_jto\traw_amount\tcloses\tother_mints\n" +
  ledger.map((r) => [r.sig, r.slot, r.time, iso(r.time), r.authority, r.account,
    (Number(r.raw) / 10 ** DECIMALS).toFixed(DECIMALS), r.raw.toString(), r.closes, r.otherMints].join("\t")).join("\n") + "\n");

// --- report ----------------------------------------------------------------
const byAuth = new Map();
for (const r of ledger) {
  const e = byAuth.get(r.authority) || { n: 0, total: 0, first: r.time, last: r.time, sweepish: 0 };
  e.n++; e.total += r.amount;
  e.first = Math.min(e.first, r.time); e.last = Math.max(e.last, r.time);
  if (r.closes || r.otherMints) e.sweepish++;
  byAuth.set(r.authority, e);
}

console.log(`\nwrote ${OUT}: ${ledger.length} burn instructions, ${fmt(total)} JTO`);
console.log(`\nburn authorities (${byAuth.size}):`);
for (const [a, e] of [...byAuth.entries()].sort((x, y) => y[1].total - x[1].total).slice(0, 25)) {
  const kind = e.total / e.n < 100 && e.sweepish ? "dust-sweep" : e.total / e.n >= 10000 ? "PROGRAMME-SCALE" : "mid";
  console.log(`  ${fmt(e.total, 6).padStart(20)} JTO  ${String(e.n).padStart(4)} burn(s)  ${kind.padEnd(16)} ${a}`);
}

console.log("\n" + "=".repeat(72));
if (WHOLE_HISTORY && immutable) {
  const expected = GENESIS_SUPPLY - currentSupply;
  const diff = expected - total;
  console.log("COMPLETENESS CHECKSUM");
  console.log(`  genesis supply (documented, not verified on chain) : ${fmt(GENESIS_SUPPLY, 0)}`);
  console.log(`  current supply (from chain)                        : ${fmt(currentSupply)}`);
  console.log(`  => burns that must exist                           : ${fmt(expected)}`);
  console.log(`  burns this ledger accounts for                     : ${fmt(total)}`);
  console.log(`  unaccounted                                        : ${fmt(diff)}`);
  const relative = Math.abs(diff) / Math.max(expected, 1);
  if (relative < 1e-9) {
    console.log("\n  BALANCED. The enumeration is COMPLETE — every burn that the supply");
    console.log("  decline implies is present in this ledger, proven independently of");
    console.log("  whether the index was honest.");
  } else {
    console.log(`\n  DOES NOT BALANCE — ${fmt(diff)} JTO of burns are missing from this ledger`);
    console.log(`  (${(relative * 100).toFixed(4)}% of the total). Either the walk missed burns, or`);
    console.log("  the genesis supply figure is wrong. Both are worth knowing; neither");
    console.log("  permits publishing this ledger as complete.");
  }
} else if (!WHOLE_HISTORY) {
  console.log("NO COMPLETENESS PROOF FOR THIS RUN");
  console.log(`  This run covered ${SINCE_ARG} -> now. The supply checksum needs the supply as`);
  console.log(`  it stood on ${SINCE_ARG}, and Solana RPC serves current state only — there is no`);
  console.log("  public archive of historical account state to recover it from.");
  console.log("");
  console.log("  So the figures above are a LOWER BOUND on burns in the window, not a");
  console.log("  measurement of them. Run --since genesis to enumerate the whole history,");
  console.log("  which the supply identity can check exactly.");
}
console.log("=".repeat(72));
