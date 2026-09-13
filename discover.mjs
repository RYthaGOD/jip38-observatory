// Identify the JIP-38 buyback machinery from chain activity.
//
// JIP-38 names no addresses, so they have to be found.
//
//   node discover.mjs [--mint <addr>] [--since 2026-07-13]
//                     [--segments 24] [--hops 8] [--concurrency 6]
//
// Reads SOLANA_RPC_URL from .env or the environment. Writes nothing to the
// repo. Prints candidates and the evidence for each, for a human to judge
// before anything reaches REGISTRY.tsv. Nothing here decides on its own that an
// address is the Rev Splitter — the point is to narrow the search, not to
// conclude it.
//
// ---------------------------------------------------------------------------
// Two corrections, both learned by running this against mainnet on 2026-09-09.
// They are recorded here rather than quietly fixed, because each one invalidated
// something the project had written down as method.
//
// 1. THE MINT'S HISTORY CANNOT BE WALKED. The first version of this script
//    paged getSignaturesForAddress over the mint, capped at 200 pages, and
//    treated what it found as the burn population since JIP-38 activation. The
//    mint carries roughly 1,000 signatures every four minutes — about 19.8
//    million across the window. 200 pages is 200,000 signatures: the most recent
//    fourteen hours, or ~1% of the window. It would have printed "none found in
//    window" while having examined almost none of it, and understating burns is
//    the one direction of error that flatters Jito. Coverage is now measured and
//    printed alongside every count, and this script will not report an absence
//    without reporting how much of the window it actually looked at.
//
// 2. "THE AUTHORITY THAT SIGNED THE BURN IS DOWNSTREAM OF THE REV SPLITTER" IS
//    FALSE. Most SPL burns against JTO are noise. The first burn this found was
//    a wallet dust-sweep: 0.63 JTO destroyed alongside two unrelated mints and
//    seven closeAccount instructions, to reclaim rent. Burn authorities are
//    therefore classified, not ranked — see classifyAuthority() in lib.mjs — and a burn has to look
//    like a programme burn before it is worth tracing.
// ---------------------------------------------------------------------------

import {
  findMetadataPda, unionSpans, integrateDensity, classifyAuthority, METAPLEX,
} from "./lib.mjs";

try { process.loadEnvFile(".env"); } catch {}

const JTO_MINT = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";

// JTO's genesis supply. Documented as 1,000,000,000 and not, at time of
// writing, verified by this project against chain — so it is an INPUT, not a
// finding, and everything derived from it below says so.
const GENESIS_SUPPLY = 1_000_000_000;

const RPC = process.env.SOLANA_RPC_URL || arg("--rpc", "");
const MINT = arg("--mint", JTO_MINT);
const SINCE = arg("--since", "2026-07-13"); // JIP-38 activation
const SEGMENTS = Number(arg("--segments", "24"));
const HOPS = Number(arg("--hops", "8"));
const CONC = Number(arg("--concurrency", "6"));
const FULL = process.argv.includes("--full");

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function die(msg) { console.error("discover: " + msg); process.exit(1); }
function fmt(n, d = 4) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: d }); }
function iso(t) { return new Date(t * 1000).toISOString().replace(".000Z", "Z"); }
function rule(s) { console.log("\n" + s + "\n" + "-".repeat(s.length)); }

if (!RPC) die("no RPC endpoint. Set SOLANA_RPC_URL in .env or pass --rpc.");
if (!MINT) die("no mint. Pass --mint <address>.");

// The parsed-history search used for burn discovery is a Helius endpoint. It is
// an INDEX over chain data, used only to narrow the search; every burn it
// surfaces is re-fetched from the chain with getTransaction before it is
// believed. If the key is not a Helius one, discovery degrades to the mint
// checks above and says so rather than pretending.
const HELIUS_KEY = /api-key=([\w-]+)/.exec(RPC)?.[1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rate limits are a fact of shared RPC, not an error condition. Backing off and
// retrying matters more here than it looks: a 429 that aborted a scan midway
// would leave a partial burn count that reads exactly like a complete one.
async function rpc(method, params, { soft = false } = {}) {
  let last = "";
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(60000),
      });
      if (r.status === 429 || r.status >= 500) { last = `HTTP ${r.status}`; await sleep(800 * 2 ** attempt); continue; }
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); }
      catch { last = `non-JSON response: ${text.slice(0, 60)}`; await sleep(800 * 2 ** attempt); continue; }
      if (j.error) { if (soft) return null; die(`${method} -> ${j.error.message}`); }
      return j.result;
    } catch (e) { last = e.message; await sleep(800 * 2 ** attempt); }
  }
  if (soft) return null;
  die(`${method} -> ${last} (after retries)`);
}

// ===========================================================================
// Step 1 — establish the mint.
//
// Everything this project publishes is a change measured against this account,
// so it is identified before anything is claimed. Format is not identity: a
// valid base58 string with a "jto" vanity prefix proves nothing on its own. The
// on-chain Metaplex metadata does — it carries the name, the symbol and a URI
// under a domain Jito controls, asserted on chain rather than in a blog post.
// ===========================================================================
rule("1. the mint");

const supply = await rpc("getTokenSupply", [MINT]);
const acct = await rpc("getAccountInfo", [MINT, { encoding: "jsonParsed" }]);
if (!acct?.value) die(`${MINT} does not exist on chain.`);
const info = acct.value.data?.parsed?.info;
if (acct.value.data?.parsed?.type !== "mint") die(`${MINT} is not an SPL mint.`);

console.log("address          :", MINT);
console.log("supply           :", supply.value.uiAmountString, `(decimals ${supply.value.decimals})`);
console.log("mint authority   :", info.mintAuthority ?? "null");
console.log("freeze authority :", info.freezeAuthority ?? "null");

// Identify it. Derive the Metaplex metadata PDA and read the name and symbol
// off chain. Bumps are walked downward and the first account that exists and is
// owned by the metadata program is the one.
let mdText = null;
const identified = await findMetadataPda(MINT, async (pda) => {
  const a = await rpc("getAccountInfo", [pda, { encoding: "base64" }], { soft: true });
  if (a?.value?.owner !== METAPLEX) return false;
  mdText = Buffer.from(a.value.data[0], "base64").toString("utf8").replace(/[^\x20-\x7e]+/g, " ").trim();
  return true;
});
if (identified) {
  console.log("metadata PDA     :", identified.pda, `(bump ${identified.bump})`);
  console.log("on-chain name    :", mdText.slice(0, 120));
} else {
  console.log("metadata PDA     : none found — the mint carries no Metaplex metadata.");
}

// The one hard gate. If the supply-only-decreases property does not hold, the
// arithmetic in step 2 is meaningless and the run should stop rather than
// publish a number built on it.
const IMMUTABLE_SUPPLY = info.mintAuthority === null;
if (!IMMUTABLE_SUPPLY) {
  console.log("\n  ! mintAuthority is set. Supply can increase, so 'genesis minus current'");
  console.log("    is NOT cumulative burn and must not be reported as one.");
}

// ===========================================================================
// Step 2 — what the supply alone establishes.
//
// This is the strongest cheap result available, and it needs no scan at all.
// With mintAuthority null, no JTO can ever be created again, so supply is
// monotonically non-increasing and every unit of decline is a permanent,
// irreversible removal. That answers, structurally, the question of whether a
// "permanent burn" is really permanent — for genuine SPL burns against this
// mint, it cannot be otherwise.
//
// It also gives a ceiling that any burn scan must respect: the total burned
// since genesis cannot exceed genesis minus current supply. A scan that finds
// more than this has a bug.
// ===========================================================================
rule("2. what supply alone establishes");

const current = Number(supply.value.uiAmountString);
if (IMMUTABLE_SUPPLY) {
  const burnedEver = GENESIS_SUPPLY - current;
  console.log("mintAuthority is null, so supply can only fall. Every decline is permanent.");
  console.log("");
  console.log("genesis supply (INPUT, not verified here) :", fmt(GENESIS_SUPPLY, 0), "JTO");
  console.log("current supply (from chain)               :", fmt(current), "JTO");
  console.log("burned since genesis                      :", fmt(burnedEver), "JTO");
  console.log("                                          =", fmt((burnedEver / GENESIS_SUPPLY) * 100, 3) + "% of genesis supply");
  console.log("");
  console.log("This is burn since GENESIS, not since JIP-38 activation. Splitting it at");
  console.log("2026-07-13 needs the supply as it stood that day, which no public RPC");
  console.log("serves — state is not retained. Until that is sourced, this figure is a");
  console.log("CEILING on JIP-38 burns, not a measurement of them.");
}

// ===========================================================================
// Step 3 — how big is the window, really.
//
// Measured, not assumed. This is the check whose absence made the first version
// of this script dishonest.
// ===========================================================================
rule("3. scan feasibility");

const sinceSec = Date.parse(SINCE + "T00:00:00Z") / 1000;
const nowSec = Math.floor(Date.now() / 1000);
const windowSec = nowSec - sinceSec;

const slotNow = await rpc("getSlot", []);

// Anchor a cursor at an arbitrary past time. Any signature works as a position
// in the ledger — it does not have to involve the mint — so a signature is
// lifted out of a block near the target. ~400ms/slot only has to land in the
// right neighbourhood; the block's real time is read back, so drift is recorded
// rather than assumed away.
async function seedAt(targetSec) {
  const guess = Math.max(1, slotNow - Math.round((nowSec - targetSec) / 0.4));
  for (let widen = 400; widen <= 6400; widen *= 4) {
    const blocks = await rpc("getBlocks", [guess, guess + widen], { soft: true });
    if (!blocks?.length) continue;
    for (const s of blocks.slice(0, 4)) {
      const blk = await rpc("getBlock", [s, {
        transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 0,
      }], { soft: true });
      if (blk?.signatures?.length) return { sig: blk.signatures[0], time: blk.blockTime };
    }
  }
  return null;
}

// Density is NOT uniform across the window, and assuming it is was an error in
// an earlier version of this file: a single reading at the chain head put the
// window at ~14M signatures, when the head is many times busier than the weeks
// behind it. So density is measured at several points and integrated
// piecewise, and the samples are printed so the shape is visible rather than
// hidden inside one number.
const PROBES = 6;
const density = [];
for (let i = 0; i < PROBES; i++) {
  const at = sinceSec + Math.round((windowSec * i) / (PROBES - 1 || 1));
  const seed = i === PROBES - 1 ? null : await seedAt(at);
  const p = await rpc("getSignaturesForAddress",
    [MINT, seed ? { limit: 1000, before: seed.sig } : { limit: 1000 }], { soft: true });
  if (!p?.length) continue;
  const ts = p.map((s) => s.blockTime).filter(Boolean);
  if (ts.length < 2) continue;
  const span = Math.max(1, Math.max(...ts) - Math.min(...ts));
  density.push({ at: seed ? seed.time : nowSec, rate: p.length / span });
}
density.sort((a, b) => a.at - b.at);

console.log("window           :", SINCE, "->", iso(nowSec), `(${(windowSec / 86400).toFixed(1)} days)`);
console.log("");
console.log("signature density on the mint, measured across the window:");
for (const d of density) console.log(`  ${iso(d.at).slice(0, 16)}  ${fmt(d.rate, 3).padStart(8)} sig/s`);

// Integrated between the probes, so a busy head does not get projected across
// quiet weeks.
const estSigs = integrateDensity(density, sinceSec, nowSec);
const headRate = density.length ? density[density.length - 1].rate : 0;
console.log("");
console.log("est. signatures in window:", fmt(Math.round(estSigs), 0), "(integrated)");
console.log("  if the head rate were assumed throughout:", fmt(Math.round(headRate * windowSec), 0),
  `— ${(headRate * windowSec / Math.max(estSigs, 1)).toFixed(1)}x too high`);
console.log("");
console.log("Burns are found by walking a burn-filtered index backwards. Coverage is");
console.log("measured from the cursor's own timestamps and reported with every count,");
console.log("so an absence below is an absence within a stated fraction of the window.");

if (!HELIUS_KEY) {
  rule("4. burn discovery");
  console.log("Skipped: burn discovery uses a parsed-history index (Helius) to narrow the");
  console.log("search, and SOLANA_RPC_URL carries no api-key. The mint findings above");
  console.log("stand on their own and needed no index.");
  process.exit(0);
}

// ===========================================================================
// Step 4 — sample the burn population across the window.
//
// The search is seeded at points spread across the window rather than walked
// from the head, because walking from the head only ever describes the last few
// hours. Each segment anchors on a signature from a block near its target time
// — any signature works as a cursor, it only fixes a position in the ledger —
// and then hops backwards, collecting burns against this mint.
// ===========================================================================
rule("4. burn discovery (sampled)");

async function burnSearch(before) {
  const u = `https://api.helius.xyz/v0/addresses/${MINT}/transactions`
    + `?api-key=${HELIUS_KEY}&type=BURN&limit=100${before ? `&before=${before}` : ""}`;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(90000) });
      if (r.status === 429 || r.status >= 500) { await sleep(800 * 2 ** attempt); continue; }
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch { await sleep(800 * 2 ** attempt); continue; }
      if (Array.isArray(j)) return { burns: j, cursor: j.length ? j[j.length - 1].signature : null };
      const m = /parameter set to ([A-Za-z0-9]+)/.exec(j.error || "");
      return { burns: [], cursor: m ? m[1] : null };
    } catch { await sleep(800 * 2 ** attempt); }
  }
  // Giving up on a hop is survivable; pretending it returned nothing is not.
  // The caller stops this segment, and coverage shrinks to match.
  return { burns: [], cursor: null, exhausted: true };
}

async function sigTime(sig) {
  const t = await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "json" }], { soft: true });
  return t?.blockTime ?? null;
}

// The window is cut into SEGMENTS contiguous slices. Segment i is seeded at the
// top of its slice and walks backwards until its cursor passes the bottom.
//
// In --full mode a segment keeps hopping until it reaches the bottom of its
// slice, so the slices join and the whole window is covered with no gaps. In
// sampled mode each segment stops after HOPS, so the slices are islands and the
// coverage figure reports what fraction was actually examined.
//
// The walk itself cannot skip transactions: every hop resumes from the cursor
// the previous hop ended on, whether that came from a returned burn or from the
// index telling us where it stopped looking. Overlap is possible; a gap is not.
const bounds = [];
for (let i = 0; i < SEGMENTS; i++) {
  bounds.push({
    top: sinceSec + Math.round((windowSec * (i + 1)) / SEGMENTS),
    bottom: sinceSec + Math.round((windowSec * i) / SEGMENTS),
  });
}

const found = new Map(); // signature -> helius tx
const spans = [];        // [bottom, top] actually walked, for honest coverage
let segDone = 0, hopsUsed = 0;

async function runSegment({ top, bottom }) {
  const seed = await seedAt(top);
  if (!seed) { segDone++; return; }
  let cursor = seed.sig, startT = seed.time, endT = seed.time;
  const cap = FULL ? 400 : HOPS;
  for (let h = 0; h < cap; h++) {
    const { burns, cursor: next } = await burnSearch(cursor);
    hopsUsed++;
    for (const b of burns) if (JSON.stringify(b).includes(MINT)) found.set(b.signature, b);
    if (burns.length) endT = burns[burns.length - 1].timestamp;
    if (!next) break;
    cursor = next;
    if (FULL) {
      // Only pay for a timestamp lookup when it can end the loop.
      const t = await sigTime(cursor);
      if (t) { endT = t; if (t <= bottom) break; }
    }
  }
  if (!FULL) { const t = await sigTime(cursor); if (t) endT = Math.min(endT, t); }
  if (startT && endT) spans.push([Math.max(endT, sinceSec), Math.min(startT, nowSec)]);
  segDone++;
  process.stdout.write(`  segment ${segDone}/${SEGMENTS}, ${hopsUsed} hops, ${found.size} JTO burn tx found   \r`);
}

const queue = [...bounds];
await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, async () => {
  while (queue.length) await runSegment(queue.shift());
}));

// Union the spans before measuring, so overlapping segments cannot inflate
// coverage past 100%.
const coveredSec = unionSpans(spans);
const coveragePct = Math.min(100, (coveredSec / windowSec) * 100);
console.log(`  ${SEGMENTS} segments, ${hopsUsed} hops total${FULL ? " (full mode)" : `, ${HOPS} hops each`}          `);
if (!FULL) {
  const perHop = coveredSec / Math.max(hopsUsed, 1);
  console.log(`  ~${fmt(perHop / 3600, 2)}h of chain per hop -> ~${fmt(Math.ceil(windowSec / Math.max(perHop, 1)), 0)} hops for full coverage (--full)`);
}
console.log("");
console.log("sampled coverage :", fmt(coveredSec / 3600, 1), "hours of", fmt(windowSec / 3600, 1),
  `= ${coveragePct.toFixed(3)}% of the window`);
console.log("JTO burn tx found:", found.size);

// ===========================================================================
// Step 5 — verify each sampled burn against chain, and classify it.
//
// The index is not trusted. Each candidate is re-fetched with getTransaction
// and the burn is read out of the parsed instruction, so a transfer to a
// terminal-looking address is never mistaken for a supply reduction. Those are
// different claims and JIP-38 promises the stronger one.
//
// Classification exists because of correction 2 in the header: a dust-sweep and
// a programme burn are both "a burn against the JTO mint", and only one of them
// is worth tracing.
// ===========================================================================
rule("5. verified burns, by authority");

const authorities = new Map();
let verified = 0;
let failedTx = 0;

for (const sig of found.keys()) {
  const tx = await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }], { soft: true });
  if (!tx) continue;
  // A transaction that failed executed nothing. Its burn instruction is a
  // request, not a supply reduction — and this loop is what produces the
  // "verified burns" figure. track, ledger and rawscan all reject these; this
  // one did not, so a failed attempt could be counted as a verified burn.
  if (tx.meta?.err) { failedTx++; continue; }
  const instrs = [
    ...(tx.transaction.message.instructions || []),
    ...(tx.meta?.innerInstructions || []).flatMap((i) => i.instructions || []),
  ];
  const parsed = instrs.map((i) => i.parsed).filter(Boolean);
  const closes = parsed.filter((p) => p.type === "closeAccount").length;
  const mints = new Set(parsed.filter((p) => p.type === "burn" || p.type === "burnChecked").map((p) => p.info.mint));

  for (const ix of instrs) {
    const t = ix.parsed?.type;
    if (t !== "burn" && t !== "burnChecked") continue;
    if (ix.parsed.info.mint !== MINT) continue;
    verified++;
    const who = ix.parsed.info.authority || ix.parsed.info.multisigAuthority || "(unknown)";
    const raw = Number(ix.parsed.info.tokenAmount?.amount ?? ix.parsed.info.amount ?? 0);
    const amt = raw / 10 ** supply.value.decimals;
    const e = authorities.get(who) || {
      count: 0, total: 0, first: tx.blockTime, last: tx.blockTime,
      closes: 0, multiMint: 0, sigs: [],
    };
    e.count++; e.total += amt;
    e.first = Math.min(e.first, tx.blockTime); e.last = Math.max(e.last, tx.blockTime);
    if (closes) e.closes++;
    if (mints.size > 1) e.multiMint++;
    if (e.sigs.length < 3) e.sigs.push(sig);
    authorities.set(who, e);
  }
}

console.log(`verified burn instructions against this mint: ${verified}` +
  (failedTx ? ` (${failedTx} failed transaction(s) excluded — they executed nothing)` : ""));
console.log("");
const rows = [...authorities.entries()].sort((a, b) => b[1].total - a[1].total);
for (const [who, e] of rows) {
  console.log(`  ${who}`);
  console.log(`    ${e.count} burn(s), ${fmt(e.total)} JTO, ${iso(e.first).slice(0, 10)} -> ${iso(e.last).slice(0, 10)}`);
  console.log(`    ${classifyAuthority(e)}`);
  if (e.closes || e.multiMint) console.log(`    (${e.closes} tx with closeAccount, ${e.multiMint} tx burning other mints too)`);
  console.log(`    e.g. ${e.sigs[0]}`);
}

if (!rows.length) {
  console.log("  No burns against this mint in the sampled fraction of the window.");
  console.log("");
  console.log(`  Read this as: none in ${coveragePct.toFixed(3)}% of the window. It is NOT`);
  console.log("  evidence that no burns occurred. Raise --segments and --hops to sample");
  console.log("  harder before drawing anything from it.");
}

// ===========================================================================
rule("what this run did not establish");
console.log("- Exhaustiveness. Coverage was " + coveragePct.toFixed(3) + "% of the window; the true");
console.log("  burn population is larger than what is listed above.");
console.log("- That any authority above is the Rev Splitter. None of them is, unless a");
console.log("  human traced its inbound JTO to JTX fee revenue and wrote down why.");
console.log("- The split of burns either side of JIP-38 activation, which needs the");
console.log("  supply as it stood on " + SINCE + " and is not yet sourced.");
console.log("");
console.log("Next: for a PROGRAMME-SCALE authority, trace inbound JTO — which venue,");
console.log("which swap, funded by what — then record the outcome in REGISTRY.tsv with");
console.log("its evidence and an honest confidence. Record rejected candidates too, so a");
console.log("ruled-out address is not rediscovered and adopted later.");
