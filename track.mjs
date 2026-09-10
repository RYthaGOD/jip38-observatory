// The JTO event ledger: everything that happens to the token, except retail.
//
//   node track.mjs                     # crawl from the registry's known accounts
//   node track.mjs --resume            # continue where the last run stopped
//   node track.mjs --min-flow 10000    # frontier threshold, in JTO
//   node track.mjs --report            # re-print the summary from the checkpoint
//
// Writes EVENTS.tsv (append-only ledger) and data/track-state.json.
//
// ---------------------------------------------------------------------------
// WHY THIS SHAPE
//
// The obvious design — enumerate every transaction that touches the mint — was
// built (rawscan.mjs) and measured: ~2.04M transactions in the JIP-38 window
// alone, ~150 hours against this RPC key. It is sound and unaffordable.
//
// The reason it is so expensive is that JTO's mint history is overwhelmingly
// retail DEX flow: Jupiter routes, AMM swaps, arbitrage. That traffic is the
// one thing this project does NOT need to reconstruct — it is already served,
// in aggregate, by any on-chain DEX source.
//
// Dropping it changes the problem completely. What remains — supply changes,
// treasury and vesting movements, authority changes, governance, and the flows
// between them — lives in a few hundred accounts with hundreds of transactions
// each, not millions. That is affordable to enumerate EXHAUSTIVELY, which is
// the property the whole project depends on.
//
// So this crawls accounts, not the mint:
//
//   1. Seed from REGISTRY.tsv — the addresses already identified and evidenced.
//   2. Resolve every transaction of each seeded account, in full.
//   3. Classify each instruction into an event.
//   4. Any counterparty receiving at least --min-flow JTO joins the frontier,
//      unless it is a DEX venue. The crawl expands itself.
//   5. Reconcile against supply. Exactly 1,000,000,000 JTO was minted and
//      minting was closed on 2023-12-04, so every JTO missing from supply was
//      burned. Burns found must equal 1,000,000,000 - current supply. The
//      residual is the crawl's own error bar, and it is printed every run.
//
// The residual is the point. It says how much of the token's history this
// ledger cannot yet account for, in JTO, without anyone having to trust it.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseRegistry } from "./lib.mjs";
import { createRpc } from "./rpc.mjs";

try { process.loadEnvFile(".env"); } catch {}

const MINT = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";
const MINTED_EVER = 1_000_000_000;      // verified on chain; minting closed 2023-12-04
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const RPC = process.env.SOLANA_RPC_URL || arg("--rpc", "");
const MIN_FLOW = Number(arg("--min-flow", "10000"));     // JTO; below this we do not expand
const MAX_TX = Number(arg("--max-tx", "6000"));          // per account, before we call it high-volume
const CONC = Number(arg("--concurrency", "3"));
const BATCH = Number(arg("--batch", "10"));
const MAX_ACCOUNTS = Number(arg("--max-accounts", "400"));
const RESUME = process.argv.includes("--resume");
const REPORT_ONLY = process.argv.includes("--report");
const OUT = arg("--out", "EVENTS.tsv");
const STATE = arg("--state", "data/track-state.json");

function arg(f, d) { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
function die(m) { console.error("track: " + m); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => (t ? new Date(t * 1000).toISOString().replace(".000Z", "Z") : "");
const fmt = (n, d = 6) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });

// Venues whose accounts are retail flow. Reaching one of these ends a branch:
// its pool vaults would otherwise drag millions of swap transactions into a
// crawl that exists precisely to avoid them. Their addresses are still RECORDED
// as counterparties, so "this treasury sold into Jupiter" remains visible — it
// is only the expansion that stops.
const DEX_PROGRAMS = new Map(Object.entries({
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter v6",
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB": "Jupiter v4",
  "JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo": "Jupiter v2",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium CLMM",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": "Raydium CPMM",
  "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS": "Raydium Router",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Orca Whirlpool",
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP": "Orca v2",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora DLMM",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB": "Meteora Pools",
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN": "Meteora DBC",
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY": "Phoenix",
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX": "Serum v3",
  "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb": "OpenBook v2",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "Pump AMM",
  "SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe": "SolFi",
  "obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y": "Obric",
  "stkitrT1Uoy18Dk1fTrgPw8W6MVzoCfYoAFT4MLsmhq": "Sanctum Router",
}));

if (REPORT_ONLY) { report(JSON.parse(readFileSync(STATE, "utf8"))); process.exit(0); }
if (!RPC) die("no RPC endpoint. Set SOLANA_RPC_URL in .env or pass --rpc.");

// Paced by credits, not by HTTP calls — see rpc.mjs. Batching without metering
// was what produced 68-77% throttling in earlier runs: the provider counts every
// item in a JSON-RPC batch, so a batch of 50 spends 50 requests at once.
const client = createRpc({ url: RPC, rate: Number(arg("--rate", "8")), maxBatch: BATCH });
const rpc = (m, p) => client.call(m, p);

// --- state -----------------------------------------------------------------
mkdirSync(dirname(STATE), { recursive: true });
let state;
if (RESUME && existsSync(STATE)) {
  state = JSON.parse(readFileSync(STATE, "utf8"));
  state.counterparties ??= {};
  console.log(`resuming: ${Object.values(state.accounts).filter((a) => a.done).length}/` +
    `${Object.keys(state.accounts).length} accounts crawled, ${state.events.length} events\n`);
} else {
  state = { accounts: {}, events: [], seenSigs: [], counterparties: {} };
  // Seed from the registry: these are the addresses already identified, with
  // published evidence, and re-tested by verify.mjs on every run.
  let seeded = 0;
  try {
    for (const e of parseRegistry(readFileSync("REGISTRY.tsv", "utf8"))) {
      if (e.confidence === "rejected") continue;
      if (e.role === "jto-mint") continue;              // the mint itself is the retail firehose
      state.accounts[e.address] = { label: e.role, from: "registry", done: false, tx: 0 };
      seeded++;
    }
  } catch (err) { die(`cannot read REGISTRY.tsv: ${err.message}`); }
  console.log(`seeded ${seeded} account(s) from REGISTRY.tsv\n`);
}
const seen = new Set(state.seenSigs);
const save = () => { state.seenSigs = [...seen]; writeFileSync(STATE, JSON.stringify(state)); };

// Read supply up front. Everything the crawl finds is measured against this, and
// the gap between the two is the honest statement of what is still missing.
{
  const s = await rpc("getTokenSupply", [MINT]);
  if (!s) die("cannot read token supply");
  state.currentSupply = Number(s.value.uiAmountString);
  console.log(`JTO supply now ${s.value.uiAmountString}; ${fmt(MINTED_EVER - state.currentSupply)} JTO has been burned and must be accounted for.\n`);
}

// --- the crawl -------------------------------------------------------------
function classify(tx) {
  const keys = (tx.transaction.message.accountKeys || []).map((k) => k.pubkey ?? k);
  for (const k of keys) if (DEX_PROGRAMS.has(k)) return DEX_PROGRAMS.get(k);
  return null;
}

async function crawl(addr) {
  const acct = state.accounts[addr];
  if (acct.done) return;

  // What is this thing? A token account, a wallet, or a program.
  const ai = await rpc("getAccountInfo", [addr, { encoding: "jsonParsed" }]);
  const parsed = ai?.value?.data?.parsed;
  acct.kind = parsed?.type ?? (ai?.value?.executable ? "program" : "wallet");
  if (parsed?.type === "account") {
    acct.mint = parsed.info?.mint;
    acct.owner = parsed.info?.owner;
    acct.balance = parsed.info?.tokenAmount?.uiAmountString;
    // A token account for some other mint is not this project's business.
    if (acct.mint && acct.mint !== MINT) { acct.done = true; acct.skipped = "not a JTO account"; return; }
  }

  let before, sigs = [];
  while (sigs.length < MAX_TX) {
    const p = await rpc("getSignaturesForAddress", [addr, before ? { limit: 1000, before } : { limit: 1000 }]);
    if (!p?.length) break;
    sigs.push(...p.filter((s) => !s.err));
    before = p[p.length - 1].signature;
    if (p.length < 1000) break;
  }
  acct.tx = sigs.length;
  if (sigs.length >= MAX_TX) {
    // Almost always a venue or an exchange wallet. Recorded, not enumerated:
    // pretending to have crawled it would be worse than saying we did not.
    acct.done = true; acct.skipped = `high-volume (>=${MAX_TX} tx) — not enumerated`;
    return;
  }

  const fresh = sigs.filter((s) => !seen.has(s.signature));
  for (let i = 0; i < fresh.length; i += BATCH) {
    const res = await client.batch("getTransaction",
      fresh.slice(i, i + BATCH).map((s) => [s.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]));
    for (const tx of res) {
      if (!tx || tx.meta?.err) continue;
      const sig = tx.transaction.signatures[0];
      if (seen.has(sig)) continue;
      seen.add(sig);
      const venue = classify(tx);
      const ins = [...(tx.transaction.message.instructions || []),
        ...(tx.meta?.innerInstructions || []).flatMap((x) => x.instructions || [])];

      // EVERY JTO token instruction in this transaction is recorded, not only
      // the ones naming the account being crawled.
      //
      // Scoping to the crawled account was a bug that silently emptied the
      // ledger. A transaction is marked seen once and never re-read, so
      // whatever is not captured on that single visit is lost — and a WALLET
      // never appears as the source or destination of an SPL transfer, only its
      // token account does. Crawling AtNgME7… (owner of the main distribution
      // hub) therefore consumed all 125 of that hub's transfer transactions and
      // recorded none of them: the hub showed 130 transactions and 5 events,
      // with its 224,999,279 JTO outflow missing entirely.
      //
      // Recording everything in a transaction we have already paid to fetch is
      // also simply cheaper, and it makes the ledger independent of the order
      // accounts happen to be crawled in.
      for (const x of ins) {
        const p = x.parsed;
        if (!p || x.programId !== TOKEN_PROGRAM) continue;
        const info = p.info || {};
        if (info.mint && info.mint !== MINT) continue;
        const amt = Number(info.tokenAmount?.amount ?? info.amount ?? 0) / 1e9;

        if (/^burn/.test(p.type) && info.mint === MINT) {
          state.events.push({ t: tx.blockTime, kind: "BURN", amt, from: info.account,
            to: "", who: info.authority || info.multisigAuthority || "", venue: venue ?? "", sig });
        } else if (/^mintTo/.test(p.type) && info.mint === MINT) {
          state.events.push({ t: tx.blockTime, kind: "MINT", amt, from: "", to: info.account,
            who: info.mintAuthority || "", venue: venue ?? "", sig });
        } else if (p.type === "setAuthority") {
          state.events.push({ t: tx.blockTime, kind: "AUTHORITY", amt: 0, from: info.account ?? info.mint ?? "",
            to: info.newAuthority ?? "null", who: info.authorityType ?? "", venue: venue ?? "", sig });
        } else if (p.type === "closeAccount") {
          state.events.push({ t: tx.blockTime, kind: "CLOSE", amt: 0, from: info.account ?? "",
            to: info.destination ?? "", who: info.owner ?? "", venue: venue ?? "", sig });
        } else if (/^transfer/.test(p.type)) {
          if (amt <= 0) continue;
          state.events.push({ t: tx.blockTime, kind: venue ? "DEX-FLOW" : "TRANSFER", amt,
            from: info.source ?? "", to: info.destination ?? "", who: info.authority ?? "", venue: venue ?? "", sig });

          // Both sides are remembered, whether or not there is budget to crawl
          // them now. Recording only what fit under the cap was a bug: once the
          // known accounts were all crawled their transactions were in `seen`,
          // so raising the cap and resuming could never discover anything. The
          // frontier has to outlive the budget.
          if (!venue) {
            for (const other of [info.source, info.destination]) {
              if (!other || other === addr) continue;
              const c = state.counterparties[other] ?? { maxFlow: 0, via: addr };
              if (amt > c.maxFlow) { c.maxFlow = amt; c.via = addr; }
              state.counterparties[other] = c;
            }
          }
        }
      }
    }
    process.stdout.write(`  ${Object.values(state.accounts).filter((a) => a.done).length}/` +
      `${Object.keys(state.accounts).length} accounts, ${state.events.length} events, ` +
      `${client.status()}      \r`);
  }
  acct.done = true;
  save();
}

// Promote the biggest known counterparties that are not yet accounts, up to the
// budget. Largest flows first: the JTO that has left supply moved in size, so
// the biggest unexplored branch is the likeliest place to find it.
function promote() {
  let added = 0;
  const candidates = Object.entries(state.counterparties)
    .filter(([a, c]) => !state.accounts[a] && c.maxFlow >= MIN_FLOW)
    .sort((x, y) => y[1].maxFlow - x[1].maxFlow);
  for (const [a, c] of candidates) {
    if (Object.keys(state.accounts).length >= MAX_ACCOUNTS) break;
    state.accounts[a] = { label: `found via ${c.via.slice(0, 8)}`, from: c.via, done: false, tx: 0, firstFlow: c.maxFlow };
    added++;
  }
  return added;
}

// Counterparties seen in earlier runs are rebuilt from the events already on
// disk, so a resume with a bigger budget picks up where the frontier stopped
// instead of re-crawling everything.
for (const e of state.events) {
  if (e.kind !== "TRANSFER") continue;
  for (const a of [e.from, e.to]) {
    if (!a) continue;
    const c = state.counterparties[a] ?? { maxFlow: 0, via: e.from || e.to };
    if (e.amt > c.maxFlow) c.maxFlow = e.amt;
    state.counterparties[a] = c;
  }
}
console.log(`${Object.keys(state.counterparties).length} counterparties known, ` +
  `${Object.keys(state.accounts).length} of them queued as accounts`);
console.log(`promoted ${promote()} more into the crawl (budget ${MAX_ACCOUNTS})\n`);

let guard = 0;
while (guard++ < MAX_ACCOUNTS * 4) {
  let pending = Object.keys(state.accounts).filter((a) => !state.accounts[a].done);
  if (!pending.length) { if (!promote()) break; pending = Object.keys(state.accounts).filter((a) => !state.accounts[a].done); }
  if (!pending.length) break;
  await Promise.all(pending.slice(0, CONC).map((a) => crawl(a)));
}
save();
console.log("");
report(state);

// ===========================================================================
function report(st) {
  const ev = st.events.slice().sort((a, b) => a.t - b.t);
  const accounts = st.accounts;
  writeFileSync(OUT,
    "# Every JTO event this project has reconstructed from chain, except retail DEX trading.\n" +
    "#\n" +
    "# Retail flow is deliberately excluded: it is ~99% of the mint's transaction\n" +
    "# history, it is what made exhaustive enumeration unaffordable, and it is already\n" +
    "# served in aggregate by any on-chain DEX source. Movements that touch a venue are\n" +
    "# still recorded as DEX-FLOW when a tracked account is on one side, so 'this\n" +
    "# treasury sold into Jupiter' stays visible; the crawl simply does not expand\n" +
    "# through the venue.\n" +
    "#\n" +
    "# kind: BURN | MINT | AUTHORITY | CLOSE | TRANSFER | DEX-FLOW\n" +
    `# generated: ${new Date().toISOString()}\n#\n` +
    "utc\tblock_time\tkind\tamount_jto\tfrom\tto\tauthority\tvenue\tsignature\n" +
    ev.map((e) => [iso(e.t), e.t, e.kind, e.amt ? e.amt.toFixed(9) : "", e.from, e.to, e.who, e.venue, e.sig].join("\t")).join("\n") + "\n");

  const by = (k) => ev.filter((e) => e.kind === k);
  const burns = by("BURN");
  const burned = burns.reduce((s, e) => s + e.amt, 0);
  const crawled = Object.values(accounts).filter((a) => a.done && !a.skipped).length;
  const skipped = Object.values(accounts).filter((a) => a.skipped);

  console.log(`\nwrote ${OUT}`);
  console.log(`\naccounts:  ${crawled} enumerated in full, ${skipped.length} recorded but not enumerated, ` +
    `${Object.keys(accounts).length} known`);
  console.log(`events:    ${ev.length}`);
  for (const k of ["BURN", "MINT", "AUTHORITY", "CLOSE", "TRANSFER", "DEX-FLOW"]) {
    const rows = by(k);
    if (rows.length) console.log(`  ${k.padEnd(10)} ${String(rows.length).padStart(6)}   ${fmt(rows.reduce((s, e) => s + e.amt, 0))} JTO`);
  }
  if (ev.length) console.log(`span:      ${iso(ev[0].t)} -> ${iso(ev[ev.length - 1].t)}`);

  if (skipped.length) {
    console.log(`\nnot enumerated (recorded as endpoints):`);
    for (const [a, v] of Object.entries(accounts).filter(([, v]) => v.skipped).slice(0, 12)) {
      console.log(`  ${a}  ${v.skipped}`);
    }
  }

  if (burns.length) {
    console.log(`\nlargest burns found:`);
    for (const b of burns.slice().sort((x, y) => y.amt - x.amt).slice(0, 10)) {
      console.log(`  ${fmt(b.amt).padStart(18)} JTO  ${iso(b.t).slice(0, 19)}  ${b.who}`);
    }
  }

  // The reconciliation. This is the number that says how much of the token's
  // history the ledger cannot yet account for.
  console.log("\n" + "=".repeat(72));
  console.log("SUPPLY RECONCILIATION");
  console.log(`  minted ever (chain-verified, minting closed 2023-12-04) : ${fmt(MINTED_EVER, 0)}`);
  console.log(`  burns in this ledger                                    : ${fmt(burned)}`);
  console.log(`  => supply this ledger implies                           : ${fmt(MINTED_EVER - burned)}`);
  if (st.currentSupply) {
    const residual = (MINTED_EVER - st.currentSupply) - burned;
    console.log(`  actual supply (chain)                                   : ${fmt(st.currentSupply)}`);
    console.log(`  UNACCOUNTED BURNS                                       : ${fmt(residual)}`);
    if (Math.abs(residual) < 1e-6) {
      console.log("\n  RECONCILED. Every JTO missing from supply is accounted for by a burn");
      console.log("  in this ledger. The record of supply-affecting events is COMPLETE.");
    } else {
      console.log(`\n  ${fmt(residual)} JTO has left supply without appearing in this ledger.`);
      console.log("  The crawl has not reached the accounts that burned it. Raise --min-flow");
      console.log("  coverage or --max-accounts and resume; the residual is the error bar.");
    }
  }
  console.log("=".repeat(72));
}
