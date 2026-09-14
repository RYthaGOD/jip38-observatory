// The JTO event ledger: everything that happens to the token, except retail.
//
//   node track.mjs                     # crawl from the registry's known accounts
//   node track.mjs --resume            # continue UNFINISHED work in the same scan
//   node track.mjs --poll              # check enumerated accounts for NEW activity
//   node track.mjs --min-flow 10000    # frontier threshold, in JTO
//   node track.mjs --report            # re-print the summary from the checkpoint
//
// --resume and --poll are different operations and must not be confused.
// --resume finishes a bounded historical scan; it never revisits an account it
// already completed. --poll is monitoring: it asks each completed account for
// signatures newer than the cursor recorded when it finished. A resumed run
// that reads today's supply while retaining last week's account history is
// reporting two different moments as one.
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
import { GENESIS_RAW, DECIMALS, TREASURY, units, decimalRaw, integer, safeError, atomicWrite } from "./core.mjs";

try { process.loadEnvFile(".env"); } catch {}

const MINT = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// The shape of data/track-state.json. Amounts became raw base-unit strings in
// version 2, so a version-1 checkpoint cannot be resumed into this code: its
// float amounts would silently mix with exact ones in the same reconciliation.
const STATE_VERSION = 2;

const RPC = process.env.SOLANA_RPC_URL || arg("--rpc", "");
// Every numeric argument is validated before any network or output activity.
// A zero batch, in particular, stops `i += BATCH` from making progress while
// there is still work — which looks exactly like having finished.
const MIN_FLOW_RAW = decimalRaw(arg("--min-flow", "10000"));  // JTO; below this we do not expand
const MAX_TX = integer(arg("--max-tx", "6000"), "--max-tx");  // per account, before we call it high-volume
const CONC = integer(arg("--concurrency", "3"), "--concurrency", 1, 64);
const BATCH = integer(arg("--batch", "10"), "--batch", 1, 100);
const MAX_ACCOUNTS = integer(arg("--max-accounts", "400"), "--max-accounts");
const RESUME = process.argv.includes("--resume");
const POLL = process.argv.includes("--poll");
const REPORT_ONLY = process.argv.includes("--report");
const OUT = arg("--out", "EVENTS.tsv");
const STATE = arg("--state", "data/track-state.json");

function arg(f, d) { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
function die(m) { console.error("track: " + m); process.exit(2); }
const iso = (t) => (t ? new Date(t * 1000).toISOString().replace(".000Z", "Z") : "");

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
const client = createRpc({ url: RPC, rate: integer(arg("--rate", "8"), "--rate", 1, 100), maxBatch: BATCH });
const rpc = (m, p) => client.call(m, p);

// --- state -----------------------------------------------------------------
mkdirSync(dirname(STATE), { recursive: true });
let state;
if ((RESUME || POLL) && existsSync(STATE)) {
  state = JSON.parse(readFileSync(STATE, "utf8"));
  // A checkpoint written before amounts became exact cannot be resumed into
  // this code: its float amounts would be summed alongside base-unit ones in
  // the same reconciliation, and the residual would be quietly meaningless.
  if ((state.version ?? 1) !== STATE_VERSION) {
    die(`${STATE} is version ${state.version ?? 1}, this build writes version ${STATE_VERSION}. ` +
      `Amounts are now exact base units; re-run without --resume to rebuild it.`);
  }
  state.counterparties ??= {};
  console.log(`resuming: ${Object.values(state.accounts).filter((a) => a.done).length}/` +
    `${Object.keys(state.accounts).length} accounts crawled, ${state.events.length} events\n`);
} else {
  state = { version: STATE_VERSION, accounts: {}, events: [], seenSigs: [], counterparties: {} };
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
const save = () => { state.version = STATE_VERSION; state.seenSigs = [...seen]; atomicWrite(STATE, JSON.stringify(state)); };

// Read supply up front. Everything the crawl finds is measured against this, and
// the gap between the two is the honest statement of what is still missing.
{
  const s = await rpc("getTokenSupply", [MINT]);
  if (!s?.value?.amount) die("cannot read token supply");
  if (s.value.decimals !== DECIMALS) die(`mint reports ${s.value.decimals} decimals, expected ${DECIMALS}`);
  // The raw base-unit amount, not the display string. This is the figure the
  // whole reconciliation is measured against, so it stays exact.
  state.currentSupplyRaw = String(s.value.amount);
  const outstanding = GENESIS_RAW - BigInt(state.currentSupplyRaw);
  console.log(`JTO supply now ${units(BigInt(state.currentSupplyRaw))}; ${units(outstanding)} JTO has been burned and must be accounted for.\n`);
}

// --- the crawl -------------------------------------------------------------
function classify(tx) {
  const keys = (tx.transaction.message.accountKeys || []).map((k) => k.pubkey ?? k);
  for (const k of keys) if (DEX_PROGRAMS.has(k)) return DEX_PROGRAMS.get(k);
  return null;
}

// Which mint does each token account in this transaction hold?
//
// An UNCHECKED SPL transfer carries no mint in its parsed info — only
// `transferChecked` does. The code used to accept that absence and scale the
// amount by 1e9 anyway, so in a multi-token transaction an unrelated token was
// recorded as JTO and its counterparties promoted into the crawl. The ledger
// this project publishes would have contained other people's tokens.
//
// The transaction's own token-balance metadata settles it: pre/postTokenBalances
// name the mint for every token account the transaction touched, by index into
// accountKeys.
function tokenMints(tx) {
  const keys = (tx.transaction.message.accountKeys || []).map((k) => k.pubkey ?? k);
  const mints = new Map();
  for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
    const addr = keys[b.accountIndex];
    if (addr && b.mint) mints.set(addr, b.mint);
  }
  return mints;
}

// The mint an instruction operates on, or null if the transaction does not say.
// Null means UNRESOLVED — never "probably JTO".
function mintOf(info, mints) {
  if (info.mint) return info.mint;
  for (const key of ["account", "source", "destination"]) {
    const addr = info[key];
    if (addr && mints.has(addr)) return mints.get(addr);
  }
  return null;
}

// The raw base-unit amount an instruction moves, as BigInt. Returns null when
// the amount is absent or malformed, which must not become zero: a burn
// recorded as 0 JTO is worse than a burn recorded as unresolved.
function rawAmount(info) {
  const v = info.tokenAmount?.amount ?? info.amount;
  if (v === undefined || v === null) return null;
  const s = String(v);
  if (!/^(0|[1-9][0-9]*)$/.test(s)) return null;
  return BigInt(s);
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

  // Pagination has to distinguish "the account has no more history" from "the
  // page could not be read". Both used to break the loop, and the account was
  // then marked done — so a single failed page permanently retired an account
  // as fully enumerated, and resume would skip it forever.
  //
  // The client throws on a failed read, so reaching the end of this loop
  // without an exception IS the completeness proof.
  //
  // An account that was enumerated in full before, and has been reopened by
  // --poll, CONTINUES from its cursor instead of being listed again from the
  // start. Listing from the start was correct and was a trap for monitoring:
  // the treasury's JTO account gains a few hundred transactions a day, so every
  // cycle re-listed a history that only grows — and on the day it crossed
  // --max-tx, the account the burn detection rests on would have been marked
  // high-volume and retired from the ledger, silently, by the code that was
  // meant to be watching it.
  const continuing = Boolean(acct.head && acct.paginationComplete && !acct.skipped);
  let before, sigs = [], paginationComplete = false;
  try {
    while (sigs.length < MAX_TX) {
      const page = { limit: 1000 };
      if (before) page.before = before;
      if (continuing) page.until = acct.head;
      const p = await rpc("getSignaturesForAddress", [addr, page]);
      if (!Array.isArray(p)) throw new Error("getSignaturesForAddress returned a non-array");
      if (!p.length) { paginationComplete = true; break; }
      sigs.push(...p.filter((s) => !s.err));
      before = p[p.length - 1].signature;
      if (p.length < 1000) { paginationComplete = true; break; }
    }
  } catch (err) {
    // Not done, not enumerated, and retained for a later run to finish.
    acct.incomplete = `signature pagination failed: ${safeError(err)}`;
    acct.done = false;
    save();
    return;
  }
  if (continuing && !paginationComplete) {
    // More new activity than one run may list. This account is already part of
    // the ledger, so it is NOT retired as high-volume — that would stop watching
    // it. The cursor stays where it was and the account stays visibly incomplete.
    acct.incomplete = `more than ${MAX_TX} new transactions since the last cursor — raise --max-tx to continue`;
    acct.done = false;
    save();
    return;
  }
  acct.tx = continuing ? (acct.tx ?? 0) + sigs.length : sigs.length;
  acct.paginationComplete = continuing ? true : paginationComplete;
  // The newest signature this account has been enumerated up to. It is the
  // cursor `--poll` uses to ask for anything newer, and it is what makes the
  // difference between "this account was complete as of X" and "this account
  // is complete", which are not the same claim.
  if (sigs.length) acct.head = sigs[0].signature;
  acct.coveredAt = new Date().toISOString();
  if (!continuing && sigs.length >= MAX_TX) {
    // Almost always a venue or an exchange wallet. Recorded, not enumerated:
    // pretending to have crawled it would be worse than saying we did not.
    acct.done = true; acct.skipped = `high-volume (>=${MAX_TX} tx) — not enumerated`;
    return;
  }

  // Transactions a previous run could not read are retried here. A full listing
  // includes them anyway; a continuation starts after the cursor, so it has to
  // be handed them explicitly or they would never be looked at again.
  const retry = (acct.unresolvedSigs ?? []).map((signature) => ({ signature }));
  const fresh = [...new Map([...sigs, ...retry].map((s) => [s.signature, s])).values()]
    .filter((s) => !seen.has(s.signature));
  const unresolved = [];
  for (let i = 0; i < fresh.length; i += BATCH) {
    const chunk = fresh.slice(i, i + BATCH);
    // batchSettled rather than batch: a transaction that could not be read is
    // retained by signature so a later run can retry it. Skipping it and then
    // marking the account done was how omitted transactions became permanent.
    const res = await client.batchSettled("getTransaction",
      chunk.map((s) => [s.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]));
    for (let n = 0; n < res.length; n++) {
      const outcome = res[n];
      if (!outcome.ok || !outcome.result) {
        unresolved.push(chunk[n].signature);
        continue;
      }
      const tx = outcome.result;
      // A failed transaction executed nothing. Its instructions are requests,
      // not events, and must never reach the ledger.
      if (tx.meta?.err) { seen.add(tx.transaction.signatures[0]); continue; }
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
      const mints = tokenMints(tx);
      for (const x of ins) {
        const p = x.parsed;
        if (!p || x.programId !== TOKEN_PROGRAM) continue;
        const info = p.info || {};

        // Positive JTO identification is required before anything is recorded
        // or any counterparty is promoted. An unchecked transfer names no mint,
        // and taking that silence for JTO put other people's tokens in this
        // ledger. Unknown stays unknown.
        const mint = mintOf(info, mints);
        if (mint !== MINT) {
          if (mint === null) acct.unresolvedMint = (acct.unresolvedMint ?? 0) + 1;
          continue;
        }

        // Base units, exactly. A malformed amount is skipped rather than
        // defaulted to zero, because a burn recorded as 0 JTO is a false
        // reconciliation, not a missing one.
        const amountRaw = rawAmount(info);
        const needsAmount = /^burn|^mintTo|^transfer/.test(p.type);
        if (needsAmount && amountRaw === null) {
          acct.unresolvedAmount = (acct.unresolvedAmount ?? 0) + 1;
          continue;
        }
        const raw = (amountRaw ?? 0n).toString();

        if (/^burn/.test(p.type)) {
          state.events.push({ t: tx.blockTime, kind: "BURN", raw, from: info.account,
            to: "", who: info.authority || info.multisigAuthority || "", venue: venue ?? "", sig });
        } else if (/^mintTo/.test(p.type)) {
          state.events.push({ t: tx.blockTime, kind: "MINT", raw, from: "", to: info.account,
            who: info.mintAuthority || "", venue: venue ?? "", sig });
        } else if (p.type === "setAuthority") {
          state.events.push({ t: tx.blockTime, kind: "AUTHORITY", raw: "0", from: info.account ?? info.mint ?? "",
            to: info.newAuthority ?? "null", who: info.authorityType ?? "", venue: venue ?? "", sig });
        } else if (p.type === "closeAccount") {
          state.events.push({ t: tx.blockTime, kind: "CLOSE", raw: "0", from: info.account ?? "",
            to: info.destination ?? "", who: info.owner ?? "", venue: venue ?? "", sig });
        } else if (/^transfer/.test(p.type)) {
          if (amountRaw <= 0n) continue;
          state.events.push({ t: tx.blockTime, kind: venue ? "DEX-FLOW" : "TRANSFER", raw,
            from: info.source ?? "", to: info.destination ?? "", who: info.authority ?? "", venue: venue ?? "", sig });

          // Both sides are remembered, whether or not there is budget to crawl
          // them now. Recording only what fit under the cap was a bug: once the
          // known accounts were all crawled their transactions were in `seen`,
          // so raising the cap and resuming could never discover anything. The
          // frontier has to outlive the budget.
          if (!venue) {
            for (const other of [info.source, info.destination]) {
              if (!other || other === addr) continue;
              const c = state.counterparties[other] ?? { maxFlowRaw: "0", via: addr };
              if (amountRaw > BigInt(c.maxFlowRaw)) { c.maxFlowRaw = raw; c.via = addr; }
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

  // Done means every expected response was validated — not merely that the
  // loop ran out of things it could read. An account with unresolved
  // transactions keeps them queued and stays incomplete, so a later run
  // retries rather than skipping it forever.
  if (unresolved.length) {
    // Only what is STILL unresolved. Every earlier failure was retried above, so
    // carrying the old list forward would keep counting reads that succeeded.
    acct.unresolvedSigs = [...new Set(unresolved)];
    acct.incomplete = `${acct.unresolvedSigs.length} transaction(s) could not be resolved`;
    acct.done = false;
  } else {
    delete acct.unresolvedSigs;
    delete acct.incomplete;
    acct.done = true;
  }
  save();
}

// Promote the biggest known counterparties that are not yet accounts, up to the
// budget. Largest flows first: the JTO that has left supply moved in size, so
// the biggest unexplored branch is the likeliest place to find it.
function promote() {
  let added = 0;
  const candidates = Object.entries(state.counterparties)
    .filter(([a, c]) => !state.accounts[a] && BigInt(c.maxFlowRaw) >= MIN_FLOW_RAW)
    .sort((x, y) => (BigInt(y[1].maxFlowRaw) > BigInt(x[1].maxFlowRaw) ? 1 : -1));
  for (const [a, c] of candidates) {
    if (Object.keys(state.accounts).length >= MAX_ACCOUNTS) break;
    state.accounts[a] = { label: `found via ${c.via.slice(0, 8)}`, from: c.via, done: false, tx: 0, firstFlowRaw: c.maxFlowRaw };
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
    const c = state.counterparties[a] ?? { maxFlowRaw: "0", via: e.from || e.to };
    if (BigInt(e.raw) > BigInt(c.maxFlowRaw)) c.maxFlowRaw = e.raw;
    state.counterparties[a] = c;
  }
}
console.log(`${Object.keys(state.counterparties).length} counterparties known, ` +
  `${Object.keys(state.accounts).length} of them queued as accounts`);
console.log(`promoted ${promote()} more into the crawl (budget ${MAX_ACCOUNTS})\n`);

// --- polling: monitoring, which resume is not -------------------------------
//
// `--resume` continues UNFINISHED work. It is the right thing for a bounded
// historical scan and the wrong thing for monitoring, because an account that
// finished is never looked at again — so a resumed run would read today's
// supply, retain last week's account history, and report the pair as though
// they described the same moment.
//
// `--poll` is the other operation: for every account already enumerated, ask
// only for signatures NEWER than the cursor recorded when it completed. An
// account with new activity is returned to the queue; one without is left
// alone at the cost of a single call.
if (POLL) {
  // Every JTO account the DAO treasury owns is watched — not only the one the
  // registry names. On 14 September 2026 the treasury held a second JTO account,
  // empty, that this ledger had never enumerated: JTO paid into it and burned
  // there would never have touched the account the burn detection rests on. So
  // each poll asks the chain which accounts exist and queues any it has not seen.
  try {
    const owned = await rpc("getTokenAccountsByOwner", [TREASURY, { mint: MINT }, { encoding: "jsonParsed" }]);
    if (!Array.isArray(owned?.value)) throw new Error("getTokenAccountsByOwner returned no account list");
    let added = 0;
    for (const { pubkey } of owned.value) {
      if (state.accounts[pubkey]) continue;
      state.accounts[pubkey] = { label: "dao-treasury-jto-account", from: "treasury discovery", done: false, tx: 0 };
      added++;
    }
    state.treasuryDiscovery = { at: new Date().toISOString(), accounts: owned.value.length, added };
    console.log(`treasury owns ${owned.value.length} JTO account(s); ${added} new to this ledger and queued`);
  } catch (err) {
    // Not "no new accounts". Recorded, and it blocks the completeness claim.
    state.treasuryDiscovery = { at: new Date().toISOString(), failed: safeError(err) };
    console.log(`treasury account discovery FAILED: ${safeError(err)}`);
  }

  const done = Object.entries(state.accounts).filter(([, a]) => a.done && a.head && !a.skipped);
  console.log(`polling ${done.length} enumerated account(s) for new activity...`);
  let reopened = 0, checked = 0;
  for (let i = 0; i < done.length; i += CONC) {
    await Promise.all(done.slice(i, i + CONC).map(async ([addr, acct]) => {
      try {
        const fresh = await rpc("getSignaturesForAddress", [addr, { until: acct.head, limit: 1000 }]);
        checked++;
        // A poll that succeeded clears an earlier failure — otherwise one
        // transient error would block the completeness claim forever — and
        // records the moment this account was last confirmed current.
        delete acct.pollFailed;
        acct.checkedAt = new Date().toISOString();
        if (Array.isArray(fresh) && fresh.length) {
          // Re-enumerate this account. Transactions already in `seen` are
          // skipped, so the cost is listing signatures, not resolving them
          // again.
          acct.done = false;
          acct.newSince = fresh.length;
          reopened++;
        }
      } catch (err) {
        // A failed poll is not "no new activity". Say so rather than leaving
        // the account looking freshly confirmed.
        acct.pollFailed = safeError(err);
      }
    }));
  }
  state.polledAt = new Date().toISOString();
  console.log(`  ${checked} checked, ${reopened} had new activity and were requeued\n`);
  save();
}

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
    "utc\tblock_time\tkind\tamount_jto\tamount_raw\tfrom\tto\tauthority\tvenue\tsignature\n" +
    ev.map((e) => [iso(e.t), e.t, e.kind, e.raw === "0" ? "" : units(BigInt(e.raw)), e.raw,
      e.from, e.to, e.who, e.venue, e.sig].join("\t")).join("\n") + "\n");

  const by = (k) => ev.filter((e) => e.kind === k);
  const sumRaw = (rows) => rows.reduce((s, e) => s + BigInt(e.raw), 0n);
  const burns = by("BURN");
  const burnedRaw = sumRaw(burns);

  // "Enumerated in full" now means exactly that: pagination completed and every
  // transaction resolved. An account carrying unresolved work is counted
  // separately rather than silently included in the completeness claim.
  const all = Object.values(accounts);
  const skipped = all.filter((a) => a.skipped);
  const incomplete = all.filter((a) => a.incomplete);
  const crawled = all.filter((a) => a.done && !a.skipped && !a.incomplete).length;
  const unresolvedSigs = incomplete.reduce((s, a) => s + (a.unresolvedSigs?.length ?? 0), 0);
  const unresolvedMint = all.reduce((s, a) => s + (a.unresolvedMint ?? 0), 0);

  console.log(`\nwrote ${OUT}`);

  // Coverage is stated before the figures, because it decides what they mean.
  // A supply reconciliation read NOW against accounts enumerated a week ago is
  // comparing two different moments, and the report used to present that pair
  // without saying so.
  const covered = all.map((a) => a.coveredAt).filter(Boolean).sort();
  const pollFailures = all.filter((a) => a.pollFailed);
  console.log("\ncoverage:");
  if (covered.length) {
    console.log(`  accounts enumerated between ${covered[0].slice(0, 19)}Z and ${covered.at(-1).slice(0, 19)}Z`);
    if (!st.polledAt) {
      console.log("  this is a BOUNDED HISTORICAL SCAN as of those times, not live monitoring —");
      console.log("  activity after an account's cutoff is not in this ledger. Run --poll for that.");
    }
  }
  if (st.polledAt) console.log(`  polled for new activity at ${st.polledAt.slice(0, 19)}Z`);
  const discoveryFailed = st.treasuryDiscovery?.failed;
  if (discoveryFailed) {
    console.log(`  the treasury's JTO accounts could NOT be listed — one this ledger does not watch may exist: ${discoveryFailed}`);
  }
  if (pollFailures.length) {
    console.log(`  ${pollFailures.length} account(s) could NOT be polled — their cutoff is unknown, not current:`);
    for (const [a, v] of Object.entries(accounts).filter(([, v]) => v.pollFailed).slice(0, 5)) {
      console.log(`    ${a}  ${v.pollFailed}`);
    }
  }

  console.log(`\naccounts:  ${crawled} enumerated in full, ${skipped.length} recorded but not enumerated, ` +
    `${incomplete.length} INCOMPLETE, ${Object.keys(accounts).length} known`);
  if (incomplete.length) {
    console.log(`           ${unresolvedSigs} unresolved transaction(s) retained for retry — this ledger is NOT complete`);
    for (const [a, v] of Object.entries(accounts).filter(([, v]) => v.incomplete).slice(0, 8)) {
      console.log(`           ${a}  ${v.incomplete}`);
    }
  }
  if (unresolvedMint) {
    console.log(`           ${unresolvedMint} token instruction(s) whose mint the transaction did not identify — excluded, not assumed JTO`);
  }
  console.log(`events:    ${ev.length}`);
  for (const k of ["BURN", "MINT", "AUTHORITY", "CLOSE", "TRANSFER", "DEX-FLOW"]) {
    const rows = by(k);
    if (rows.length) console.log(`  ${k.padEnd(10)} ${String(rows.length).padStart(6)}   ${units(sumRaw(rows))} JTO`);
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
    for (const b of burns.slice().sort((x, y) => (BigInt(y.raw) > BigInt(x.raw) ? 1 : -1)).slice(0, 10)) {
      console.log(`  ${units(BigInt(b.raw)).padStart(22)} JTO  ${iso(b.t).slice(0, 19)}  ${b.who}`);
    }
  }

  // The reconciliation. This is the number that says how much of the token's
  // history the ledger cannot yet account for.
  console.log("\n" + "=".repeat(72));
  console.log("SUPPLY RECONCILIATION");
  console.log(`  minted ever (chain-verified, minting closed 2023-12-04) : ${units(GENESIS_RAW)}`);
  console.log(`  burns in this ledger                                    : ${units(burnedRaw)}`);
  console.log(`  => supply this ledger implies                           : ${units(GENESIS_RAW - burnedRaw)}`);
  if (st.currentSupplyRaw) {
    // Exact, in base units. Subtracting displayed supplies as Numbers lost base
    // units at this magnitude, so a residual of "0" could never be trusted to
    // mean zero — and zero is the whole claim.
    const supplyRaw = BigInt(st.currentSupplyRaw);
    const residualRaw = (GENESIS_RAW - supplyRaw) - burnedRaw;
    console.log(`  actual supply (chain)                                   : ${units(supplyRaw)}`);
    console.log(`  UNACCOUNTED BURNS                                       : ${units(residualRaw)}`);

    // Completeness is a conjunction, not an arithmetic coincidence. A balanced
    // aggregate over an incomplete read set is not a proof: duplicates and
    // omissions can cancel. Zero unresolved reads is required alongside it.
    if (residualRaw === 0n && !incomplete.length && !unresolvedSigs && !pollFailures.length && !discoveryFailed) {
      console.log("\n  RECONCILED. Every JTO missing from supply is accounted for by a burn");
      console.log("  in this ledger, and every expected read was resolved. The record of");
      console.log("  supply-affecting events is COMPLETE.");
    } else if (residualRaw === 0n) {
      console.log("\n  The aggregate balances, but this ledger has unresolved reads. A balanced");
      console.log("  total over an incomplete read set is not a proof of completeness —");
      console.log("  omissions and duplicates can cancel. Resolve the outstanding reads first.");
    } else {
      console.log(`\n  ${units(residualRaw)} JTO has left supply without appearing in this ledger.`);
      console.log("  The crawl has not reached the accounts that burned it. Raise --min-flow");
      console.log("  coverage or --max-accounts and resume; the residual is the error bar.");
    }
  }
  console.log("=".repeat(72));
}
