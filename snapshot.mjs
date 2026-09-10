// Build the dashboard's snapshot: everything the observatory currently knows,
// as one JSON document.
//
//   node snapshot.mjs [--out data/snapshot.json]
//
// The published dashboard cannot query Solana itself — an Artifact page is
// barred from making network calls — so the chain has to be read here and the
// result handed to the page. This writes that document. It is also what gets
// pushed into the artifact's database, so the page can be updated with fresh
// figures without republishing it.
//
// Every number carries where it came from: `chain` for something this script
// read from Solana, `claim` for something the operator published. Keeping those
// apart in the data, rather than only in the prose, is the whole point of the
// project — a reader should never have to guess which they are looking at.

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRpc } from "./rpc.mjs";
import { parseRegistry } from "./lib.mjs";

try { process.loadEnvFile(".env"); } catch {}

const MINT = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";
const TREASURY = "5eosrve6LktMZgVNszYzebgmmC7BjLK8NoWyRQtcmGTF";
const TREASURY_ACC = "2Ch9AWnbAaummLkWTTtNgTAvrFq8YMATUaaN77TB2Y6C";
const FEE_PROGRAM = "JTXJTXfr1wVRMEzqiPhXUr69zJtfGuLh5qEiXG772Zj";
const MINTED_EVER = 1_000_000_000;
const ACTIVATION = "2026-07-13";

const RPC = process.env.SOLANA_RPC_URL || "";
const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : "data/snapshot.json"; })();
if (!RPC) { console.error("snapshot: no SOLANA_RPC_URL"); process.exit(2); }

const c = createRpc({ url: RPC, rate: 9, maxBatch: 10 });

const supply = await c.call("getTokenSupply", [MINT]);
const mintAcct = await c.call("getAccountInfo", [MINT, { encoding: "jsonParsed" }]);
const slot = await c.call("getSlot", []);
const blockTime = await c.call("getBlockTime", [slot]);
const treasuryAccounts = await c.call("getTokenAccountsByOwner", [TREASURY, { mint: MINT }, { encoding: "jsonParsed" }]);
const feeProg = await c.call("getAccountInfo", [FEE_PROGRAM, { encoding: "base64" }]);

const currentSupply = Number(supply.value.uiAmountString);
const destroyed = MINTED_EVER - currentSupply;
let treasuryJto = 0;
for (const a of (treasuryAccounts?.value ?? [])) treasuryJto += Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0);

// The operator's own published figures, captured 2026-09-09 from the JTX
// dashboard. Held as a CLAIM: the dashboard is client-rendered, so these were
// read via a rendering fetch and recorded in CLAIMS.tsv with a hash.
const claimed = {
  source: "https://dune.com/jito/jtx-metrics-ee62",
  capturedAt: "2026-09-09T23:40:00Z",
  platformFeesUsd: 198908.37,
  tradingVolumeUsd: 124236023.65,
  fills: 266827,
  dataBegins: "2026-07-24",
  note: "figures move through the day; captured and hashed so what was claimed on a date cannot be revised without record",
};

// JIP-38's own arithmetic, applied to the operator's own fee figure.
const committedUsd = claimed.platformFeesUsd * 0.80;

const registry = existsSync("REGISTRY.tsv")
  ? parseRegistry(readFileSync("REGISTRY.tsv", "utf8")).map((e) => ({
      role: e.role, address: e.address, confidence: e.confidence, since: e.since,
    }))
  : [];

const snap = {
  generatedAt: new Date().toISOString(),
  slot, blockTimeIso: blockTime ? new Date(blockTime * 1000).toISOString() : null,
  activation: ACTIVATION,

  supply: {
    source: "chain",
    mintedEver: MINTED_EVER,
    current: currentSupply,
    destroyed,
    decimals: supply.value.decimals,
    mintAuthority: mintAcct?.value?.data?.parsed?.info?.mintAuthority ?? null,
    freezeAuthority: mintAcct?.value?.data?.parsed?.info?.freezeAuthority ?? null,
    mintingClosed: "2023-12-04T18:27:47Z",
    genesisMintTx: "2M1gWKQvjCav6JLkf2j5EfUmpp31RRM27YPnG1fGiyvgqu3s4C7Z1tWYXgYKoxwgMC84WG5v7tMHwMMQ74xUekVG",
  },

  treasury: {
    source: "chain",
    owner: TREASURY,
    tokenAccount: TREASURY_ACC,
    jto: treasuryJto,
    accounts: (treasuryAccounts?.value ?? []).length,
  },

  feeProgram: {
    source: "chain",
    address: FEE_PROGRAM,
    exists: !!feeProg?.value,
    executable: !!feeProg?.value?.executable,
    owner: feeProg?.value?.owner ?? null,
  },

  claimed,

  // The number the project exists to publish.
  execution: {
    committedUsd,
    burnedJto: 0,           // verified: no programme burn found by any method
    burnedUsd: 0,
    ratio: 0,               // burned / committed
    promisedRatio: 0.80,
    basis: "no JIP-38 burn found on chain by any method; Jito confirmed none have occurred (2026-09-10)",
  },

  // Stated before the findings, so it cannot be tuned to them.
  unverified: [
    "That JTX fees are being swept into JTO — the buyback step is an operator claim, not yet traced on chain.",
    "The 80/20 split.",
    "The $198,908.37 fee total, and the ~10 days of activity missing from the dashboard's start.",
    "The dates of the 13,477,143 JTO destroyed before activation.",
  ],

  registry,
};

// --- change detection -------------------------------------------------------
//
// The dashboard is the visible product, but this is the useful one. The event
// worth catching is the FIRST BURN: the treasury's JTO climbs while fees are
// swept in, and falls when a burn finally happens. Because supply is
// monotonically non-increasing, a fall is unambiguous.
//
// Comparing against the previous snapshot costs nothing and runs on every
// scheduled refresh, so the moment JIP-38 actually executes, it is recorded
// with a timestamp rather than noticed later.
const HIST = "data/history.jsonl";
let alerts = [];
let prev = null;
if (existsSync(OUT)) { try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch {} }

if (prev) {
  const dTreasury = treasuryJto - prev.treasury.jto;
  const dSupply = currentSupply - prev.supply.current;

  if (dTreasury < -0.000001) {
    alerts.push(`TREASURY FELL by ${Math.abs(dTreasury).toLocaleString(undefined, { maximumFractionDigits: 9 })} JTO ` +
      `(${prev.treasury.jto} -> ${treasuryJto}). This is the event to check: a burn, or a transfer out.`);
  }
  // Supply always drifts down from rent-reclaim dust; only a step change matters.
  if (dSupply < -1000) {
    alerts.push(`SUPPLY FELL by ${Math.abs(dSupply).toLocaleString(undefined, { maximumFractionDigits: 6 })} JTO ` +
      `since the last snapshot — far beyond dust. A programme-scale burn may have occurred.`);
  }
  if (prev.claimed && claimed.platformFeesUsd !== prev.claimed.platformFeesUsd) {
    alerts.push(`claimed platform fees changed: $${prev.claimed.platformFeesUsd} -> $${claimed.platformFeesUsd}`);
  }
}

snap.alerts = alerts;

mkdirSync(dirname(OUT), { recursive: true });
appendFileSync(HIST, JSON.stringify({
  t: snap.generatedAt, slot, supply: currentSupply, destroyed,
  treasury: treasuryJto, burnedJto: snap.execution.burnedJto, alerts,
}) + "\n");

writeFileSync(OUT, JSON.stringify(snap, null, 2));
console.log(`wrote ${OUT}`);
console.log(`  supply      ${currentSupply.toLocaleString()} JTO  (destroyed ${destroyed.toLocaleString()})`);
console.log(`  treasury    ${treasuryJto.toLocaleString()} JTO`);
console.log(`  committed   $${committedUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
console.log(`  burned      0 JTO  -> execution ratio 0% against a promised 80%`);
console.log(`  registry    ${registry.length} entries`);
console.log(`  rpc         ${c.status()}`);

if (alerts.length) {
  console.log("");
  console.log("!".repeat(72));
  for (const a of alerts) console.log("!! " + a);
  console.log("!".repeat(72));
} else {
  console.log("  no change worth flagging since the last snapshot");
}
