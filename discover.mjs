// Identify the JIP-38 buyback machinery from chain activity.
//
// JIP-38 names no addresses, so they have to be found. This searches backwards
// from the burn, because a burn is the most identifiable event available: an SPL
// burn against the JTO mint reduces supply, verifiably, and whoever signed it is
// downstream of the Rev Splitter. Fees are the worst starting point — platform
// fees can accrue across many accounts by many routes, and picking one to follow
// would be assuming the answer.
//
//   SOLANA_RPC_URL=... node discover.mjs --mint <JTO_MINT> [--since 2026-07-13]
//
// Writes nothing. Prints candidates and the evidence for each, for a human to
// judge before anything reaches REGISTRY.tsv. Nothing here decides on its own
// that an address is the Rev Splitter — the point is to narrow the search, not
// to conclude it.
//
// The JTO mint is a required argument rather than a constant. Hardcoding a mint
// address I had not verified would put an unchecked assumption at the root of
// every figure this project ever publishes, which is precisely the failure this
// repo exists to avoid. Confirm it against a block explorer and pass it in.

const RPC = process.env.SOLANA_RPC_URL || arg("--rpc", "");
const MINT = arg("--mint", "");
const SINCE = arg("--since", "2026-07-13"); // JIP-38 activation

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function die(msg) { console.error("discover: " + msg); process.exit(1); }

if (!RPC) die("no RPC endpoint. Set SOLANA_RPC_URL or pass --rpc.");
if (!MINT) die("no JTO mint. Pass --mint <address>, confirmed against an explorer.");

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) die(`${method} -> HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) die(`${method} -> ${j.error.message}`);
  return j.result;
}

// Step 1 — establish the mint and its current supply. Everything else is
// measured as a change against this, so it is stated before anything is claimed.
const supply = await rpc("getTokenSupply", [MINT]);
console.log("mint     :", MINT);
console.log("supply   :", supply.value.uiAmountString, `(decimals ${supply.value.decimals})`);
console.log("since    :", SINCE, "(JIP-38 activation)");
console.log("");

// Step 2 — walk the mint's transaction history and keep the burns.
//
// Paged deliberately rather than pulled in one call: this history is long, and a
// silent truncation here would understate burns, which is the one direction of
// error that would flatter Jito. Better to be slow.
console.log("scanning mint history for burn instructions...");
const sinceMs = Date.parse(SINCE + "T00:00:00Z");
let before = undefined, scanned = 0, burns = [];

for (let page = 0; page < 200; page++) {
  const sigs = await rpc("getSignaturesForAddress", [MINT, { limit: 1000, before }]);
  if (!sigs.length) break;
  scanned += sigs.length;
  before = sigs[sigs.length - 1].signature;

  const oldest = sigs[sigs.length - 1].blockTime;
  for (const s of sigs) {
    if (s.err) continue;
    if (s.blockTime && s.blockTime * 1000 < sinceMs) continue;
    burns.push({ sig: s.signature, blockTime: s.blockTime, slot: s.slot });
  }
  process.stdout.write(`  ${scanned} signatures\r`);
  if (oldest && oldest * 1000 < sinceMs) break;
}
console.log(`  ${scanned} signatures scanned, ${burns.length} in window`);
console.log("");

// Step 3 — resolve each candidate and keep only real burns, recording who signed.
//
// A burn is identified from the parsed instruction rather than guessed from
// balance deltas, so that a transfer to a null-ish address is not mistaken for a
// supply reduction. Those are different claims and JIP-38 promises the stronger
// one ("permanent burns").
const signers = new Map();
let confirmed = 0;

for (const b of burns.slice(0, 500)) {
  const tx = await rpc("getTransaction", [b.sig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
  if (!tx) continue;
  const instrs = [
    ...(tx.transaction.message.instructions || []),
    ...(tx.meta?.innerInstructions || []).flatMap((i) => i.instructions || []),
  ];
  for (const ix of instrs) {
    const t = ix.parsed?.type;
    if (t !== "burn" && t !== "burnChecked") continue;
    if (ix.parsed?.info?.mint !== MINT) continue;
    confirmed++;
    const who = ix.parsed.info.authority || ix.parsed.info.multisigAuthority || "(unknown)";
    const amt = Number(ix.parsed.info.tokenAmount?.uiAmount ?? ix.parsed.info.amount ?? 0);
    const e = signers.get(who) || { count: 0, total: 0, first: b.blockTime, last: b.blockTime };
    e.count++; e.total += amt;
    e.first = Math.min(e.first, b.blockTime); e.last = Math.max(e.last, b.blockTime);
    signers.set(who, e);
  }
}

console.log(`confirmed burn instructions: ${confirmed}`);
console.log("");
console.log("burn authorities, by volume — the Rev Splitter is downstream of one of these:");
const rows = [...signers.entries()].sort((a, b) => b[1].total - a[1].total);
for (const [who, e] of rows) {
  console.log(`  ${who}`);
  console.log(`    ${e.count} burn(s), ${e.total.toLocaleString()} JTO, ` +
    `${new Date(e.first * 1000).toISOString().slice(0, 10)} -> ${new Date(e.last * 1000).toISOString().slice(0, 10)}`);
}
if (!rows.length) {
  console.log("  none found in window.");
  console.log("");
  console.log("  That is a finding, not a failure. Either the burns are not SPL burns");
  console.log("  against this mint, or the mint is wrong, or they have not happened.");
  console.log("  Establish which before assuming the third.");
}
console.log("");
console.log("Next: for each authority above, trace inbound JTO — which venue, which");
console.log("swap, funded by what — then record the outcome in REGISTRY.tsv with its");
console.log("evidence and an honest confidence. Nothing is confirmed by this script.");
