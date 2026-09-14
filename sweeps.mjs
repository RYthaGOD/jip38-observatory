// Decode every JTX fee sweep that paid JTO into the DAO treasury.
//
//   node sweeps.mjs            # resolve every inflow transaction, resumable
//   node sweeps.mjs --report   # re-print the summary from the checkpoint
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// Until 14 September 2026 the dashboard listed, as unverified, "that JTX fees
// are being swept into JTO — the buyback step is an operator claim, not yet
// traced on chain". Then the treasury's JTO account, already enumerated in full
// by track.mjs, turned out to have received 17,357 transfers since activation —
// and a sample of them all invoked the JTX fee program with an instruction its
// own log names `FeeSweepPrepare`, swapping fee tokens into JTO through DFlow
// and paying the JTO out, apparently 80% to the treasury.
//
// A sample is a lead, not a finding. This resolves EVERY one of those
// transactions and states, in exact base units:
//
//   - how many are fee sweeps, by the program's own log, and how many are not
//   - who signed them
//   - how much JTO each sweep acquired, and what share reached the treasury
//   - who received the rest
//   - which fee tokens were spent to buy it
//
// And it checks itself against something it did not compute: the treasury JTO
// it attributes to sweeps must reconcile with the inbound total track.mjs
// recorded from the same account by a different parse.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { createRpc } from "./rpc.mjs";
import { MINT, TREASURY, atomicWrite, units, integer, arg, safeError, readJsonFile } from "./core.mjs";

try { process.loadEnvFile(".env"); } catch { /* CI and --report need no key */ }

const JTX_PROGRAM = "JTXJTXfr1wVRMEzqiPhXUr69zJtfGuLh5qEiXG772Zj";
const TREASURY_TOKEN_ACCOUNT = "2Ch9AWnbAaummLkWTTtNgTAvrFq8YMATUaaN77TB2Y6C";
const ACTIVATION = Date.parse("2026-07-13T00:00:00Z") / 1000;
const STATE_VERSION = 1;

const TRACK = arg("--track", "data/track-state.json");
const STATE = arg("--state", "data/sweeps-state.json");
const BATCH = integer(arg("--batch", "10"), "--batch", 1, 50);
const RATE = integer(arg("--rate", "6"), "--rate", 1, 40);
const REPORT_ONLY = process.argv.includes("--report");

// Refuse a summary path that is the checkpoint path. On a case-insensitive
// filesystem data/sweeps-state.json and DATA/SWEEPS-STATE.json are one
// file, and writing the summary there would silently destroy the decoded state
// it was produced from — which happened in a test before this guard existed.
{
  const out = arg("--summary", null);
  const { resolve } = await import("node:path");
  if (out && resolve(out).toLowerCase() === resolve(STATE).toLowerCase()) {
    console.error(`sweeps: --summary ${out} is the checkpoint file itself; choose another path`);
    process.exit(2);
  }
}

// For a trial run on a few transactions before committing the RPC budget.
const LIMIT = arg("--limit", null);

// --- which transactions ------------------------------------------------------

const track = readJsonFile(TRACK, "the enumerated ledger from track.mjs");
const inflows = track.events.filter((e) => e.to === TREASURY_TOKEN_ACCOUNT && e.t >= ACTIVATION);
const allSigs = [...new Set(inflows.map((e) => e.sig))];
const sigs = LIMIT ? allSigs.slice(0, integer(LIMIT, "--limit")) : allSigs;
// The ledger side of the reconciliation covers exactly the transactions being
// resolved, so a --limit trial compares like with like.
const sigSet = new Set(sigs);
const ledgerInboundRaw = inflows.filter((e) => sigSet.has(e.sig)).reduce((s, e) => s + BigInt(e.raw), 0n);

const state = existsSync(STATE)
  ? readJsonFile(STATE, "the sweep checkpoint")
  : { version: STATE_VERSION, resolved: {} };
if (state.version !== STATE_VERSION) {
  console.error(`sweeps: ${STATE} is version ${state.version}, expected ${STATE_VERSION}`);
  process.exit(2);
}
const save = () => atomicWrite(STATE, JSON.stringify(state));

// --- decode one transaction --------------------------------------------------

// Net change per (owner, mint), in exact base units, from the transaction's own
// balance metadata — the same source track.mjs uses for mint identity.
function netChanges(tx) {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey ?? k);
  const net = new Map();
  const add = (b, sign) => {
    const owner = b.owner ?? keys[b.accountIndex];
    const k = `${owner}|${b.mint}`;
    net.set(k, (net.get(k) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
  };
  (tx.meta.preTokenBalances ?? []).forEach((b) => add(b, -1n));
  (tx.meta.postTokenBalances ?? []).forEach((b) => add(b, 1n));
  return [...net].filter(([, d]) => d !== 0n).map(([k, d]) => {
    const [owner, mint] = k.split("|");
    return { owner, mint, raw: d.toString() };
  });
}

function decode(tx) {
  const signers = tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey ?? k);
  const logs = tx.meta.logMessages ?? [];

  // Instruction names logged while the JTX program is executing. Anchor-style
  // programs log `ix: Name`; this reads only the lines between the JTX invoke
  // and its return, so another program's logs are never attributed to it.
  const jtxIx = [];
  let depth = 0;
  for (const line of logs) {
    if (line.startsWith(`Program ${JTX_PROGRAM} invoke`)) { depth++; continue; }
    if (depth && line.startsWith(`Program ${JTX_PROGRAM} success`)) { depth--; continue; }
    if (depth && line.startsWith(`Program ${JTX_PROGRAM} failed`)) { depth--; continue; }
    const m = depth && /^Program log: ix: (\w+)/.exec(line);
    if (m) jtxIx.push(m[1]);
  }

  const changes = netChanges(tx);
  const jto = changes.filter((c) => c.mint === MINT);
  const treasuryRaw = jto.filter((c) => c.owner === TREASURY).reduce((s, c) => s + BigInt(c.raw), 0n);
  const acquiredRaw = jto.filter((c) => BigInt(c.raw) > 0n).reduce((s, c) => s + BigInt(c.raw), 0n);

  return {
    t: tx.blockTime,
    failed: !!tx.meta.err,
    signers,
    jtxIx: [...new Set(jtxIx)],
    invokesJtx: tx.transaction.message.instructions.some((i) => i.programId === JTX_PROGRAM),
    treasuryRaw: treasuryRaw.toString(),
    acquiredRaw: acquiredRaw.toString(),
    recipients: jto.filter((c) => BigInt(c.raw) > 0n && c.owner !== TREASURY).map((c) => ({ owner: c.owner, raw: c.raw })),
    spent: changes.filter((c) => c.mint !== MINT && BigInt(c.raw) < 0n).map((c) => ({ owner: c.owner, mint: c.mint, raw: c.raw })),
  };
}

// --- resolve -----------------------------------------------------------------

if (!REPORT_ONLY) {
  const RPC = process.env.SOLANA_RPC_URL;
  if (!RPC) { console.error("sweeps: no SOLANA_RPC_URL (use --report to summarise the checkpoint)"); process.exit(2); }
  const client = createRpc({ url: RPC, rate: RATE, maxBatch: BATCH });

  const todo = sigs.filter((s) => !state.resolved[s]);
  console.log(`sweeps: ${sigs.length.toLocaleString()} inflow transactions since activation, ${todo.length.toLocaleString()} to resolve`);

  let unresolved = [];
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const out = await client.batchSettled("getTransaction",
      chunk.map((s) => [s, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]));
    out.forEach((o, n) => {
      if (!o.ok || !o.result) { unresolved.push(chunk[n]); return; }
      try { state.resolved[chunk[n]] = decode(o.result); }
      catch (err) { unresolved.push(chunk[n]); console.error(`  could not decode ${chunk[n].slice(0, 12)}…: ${safeError(err)}`); }
    });
    if ((i / BATCH) % 50 === 0) {
      save();
      process.stdout.write(`  ${Object.keys(state.resolved).length.toLocaleString()}/${sigs.length.toLocaleString()} resolved, ${client.status()}      \r`);
    }
  }
  state.unresolved = unresolved;
  state.resolvedAt = new Date().toISOString();
  save();
  console.log(`\n  done: ${Object.keys(state.resolved).length.toLocaleString()} resolved, ${unresolved.length} unresolved`);
}

// --- report ------------------------------------------------------------------

const rows = sigs.map((s) => state.resolved[s]).filter(Boolean);
const missing = sigs.length - rows.length;
// A sweep is two instructions in the JTX program's own vocabulary, Prepare and
// Finalize, and JTO reaches the treasury in both. The first version of this
// report matched Prepare alone and filed 688 Finalize transactions — 8% of those
// examined at the time — as "not sweeps", which would have understated both the
// count and the JTO attributed to the buyback.
const SWEEP_IX = ["FeeSweepPrepare", "FeeSweepFinalize"];
const isSweep = (r) => r.jtxIx.some((n) => SWEEP_IX.includes(n));
const sweeps = rows.filter(isSweep);
const other = rows.filter((r) => !isSweep(r));
const sum = (list, f) => list.reduce((s, r) => s + BigInt(f(r)), 0n);

console.log("\n" + "=".repeat(72));
console.log("JTX FEE SWEEPS INTO THE DAO TREASURY'S JTO ACCOUNT, SINCE ACTIVATION");
console.log("=".repeat(72));
console.log(`transactions      ${rows.length.toLocaleString()} resolved of ${sigs.length.toLocaleString()}${missing ? `  — ${missing} NOT RESOLVED, figures below are incomplete` : ""}`);
console.log(`fee sweeps        ${sweeps.length.toLocaleString()} carry the program's own FeeSweepPrepare or FeeSweepFinalize log`);
console.log(`not sweeps        ${other.length.toLocaleString()}`);
if (other.length) {
  const names = new Map();
  for (const r of other) for (const n of (r.jtxIx.length ? r.jtxIx : [r.invokesJtx ? "(JTX, no ix log)" : "(no JTX)"])) names.set(n, (names.get(n) ?? 0) + 1);
  for (const [n, c] of [...names].sort((a, b) => b[1] - a[1])) console.log(`                  ${String(c).padStart(6)}  ${n}`);
}
const failed = rows.filter((r) => r.failed).length;
if (failed) console.log(`failed txs        ${failed} (should be 0: track.mjs records only executed transactions)`);

const signers = new Map();
for (const r of sweeps) for (const s of r.signers) signers.set(s, (signers.get(s) ?? 0) + 1);
console.log(`\nsigners           ${signers.size}`);
for (const [s, c] of [...signers].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`                  ${String(c).padStart(6)}  ${s}`);

const treasurySweepRaw = sum(sweeps, (r) => r.treasuryRaw);
const acquiredRaw = sum(sweeps, (r) => r.acquiredRaw);
console.log(`\nJTO acquired by sweeps      ${units(acquiredRaw)}`);
console.log(`  to the DAO treasury       ${units(treasurySweepRaw)}`);
console.log(`  to everyone else          ${units(acquiredRaw - treasurySweepRaw)}`);
if (acquiredRaw > 0n) {
  const bps = (treasurySweepRaw * 1_000_000n) / acquiredRaw;
  console.log(`  treasury share, aggregate ${(Number(bps) / 10_000).toFixed(4)}%`);
}

// Per-sweep share, bucketed. JIP-38 commits 80% of fees to the DAO; a split
// that holds only in aggregate is a different claim from one that holds on
// every sweep.
const buckets = new Map();
for (const r of sweeps) {
  if (BigInt(r.acquiredRaw) === 0n) continue;
  const pct = Number((BigInt(r.treasuryRaw) * 10_000n) / BigInt(r.acquiredRaw)) / 100;
  const b = pct >= 79.99 && pct <= 80.01 ? "80.00% exactly (±0.01)" : `${Math.floor(pct / 5) * 5}–${Math.floor(pct / 5) * 5 + 5}%`;
  buckets.set(b, (buckets.get(b) ?? 0) + 1);
}
console.log(`\nper-sweep treasury share`);
for (const [b, c] of [...buckets].sort((a, b) => b[1] - a[1])) console.log(`                  ${String(c).padStart(6)}  ${b}`);

const recips = new Map();
for (const r of sweeps) for (const x of r.recipients) recips.set(x.owner, (recips.get(x.owner) ?? 0n) + BigInt(x.raw));
console.log(`\nother JTO recipients`);
for (const [o, raw] of [...recips].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 6)) {
  const share = acquiredRaw ? (Number((raw * 1_000_000n) / acquiredRaw) / 10_000).toFixed(4) : "?";
  console.log(`  ${units(raw).padStart(24)} JTO  ${share.padStart(8)}%  ${o}`);
}

// NOT a fee total. `spent` is every non-JTO outflow in the transaction, and a
// multi-hop route (USDC -> wSOL -> JTO) records the intermediate pool's wSOL
// outflow as well as the vault's USDC. It shows which tokens the sweeps route
// through; it must not be read, or published, as fees collected.
const spent = new Map();
for (const r of sweeps) for (const x of r.spent) spent.set(x.mint, (spent.get(x.mint) ?? 0n) + BigInt(x.raw));
console.log(`\ntokens routed through (gross non-JTO outflows INCLUDING swap hops — not a fee total)`);
for (const [m, raw] of [...spent].sort((a, b) => (a[1] < b[1] ? -1 : 1)).slice(0, 6)) console.log(`  ${(-raw).toString().padStart(24)} base units  ${m}`);

// --- the cross-check --------------------------------------------------------
console.log("\n" + "-".repeat(72));
console.log("RECONCILIATION against track.mjs, which parsed the same account independently");
const allTreasuryRaw = sum(rows, (r) => r.treasuryRaw);
console.log(`  ledger inbound since activation     ${units(ledgerInboundRaw)}`);
console.log(`  treasury JTO in these transactions  ${units(allTreasuryRaw)}`);
const diff = allTreasuryRaw - ledgerInboundRaw;
console.log(`  difference                          ${units(diff < 0n ? -diff : diff)}${diff === 0n ? "  — EXACT" : ""}`);
if (missing) console.log("  (unresolved transactions make this comparison incomplete)");
console.log("-".repeat(72));

// Count each distinct split, in basis points per recipient, largest first.
function splitPatterns(list) {
  const counts = new Map();
  for (const r of list) {
    const whole = BigInt(r.acquiredRaw);
    if (whole === 0n) continue;
    const bp = (raw) => Number((BigInt(raw) * 10_000n) / whole);
    const parts = [["treasury", bp(r.treasuryRaw)], ...r.recipients.map((x) => [x.owner, bp(x.raw)])]
      .sort((a, b) => b[1] - a[1]);
    const key = JSON.stringify(parts);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([key, sweeps]) => ({ sweeps, basisPoints: Object.fromEntries(JSON.parse(key)) }));
}

// --- the committed record ----------------------------------------------------
//
// The checkpoint holds every decoded transaction and stays out of git. What is
// committed is this summary, reviewed like CLAIM.json and ASSESSMENT.json: dated,
// exact, and carrying its own reconciliation so a reader can see whether the
// figures were complete when they were written.
const SUMMARY = arg("--summary", null);
if (SUMMARY) {
  const firstSweep = sweeps.length ? Math.min(...sweeps.map((r) => r.t)) : null;
  const lastSweep = sweeps.length ? Math.max(...sweeps.map((r) => r.t)) : null;
  const ppm = (part, whole) => (whole > 0n ? Number((part * 1_000_000n) / whole) : null);
  let exact80 = 0, notExact = 0;
  for (const r of sweeps) {
    if (BigInt(r.acquiredRaw) === 0n) continue;
    // 80.00% within one basis point, in integers.
    const bps = (BigInt(r.treasuryRaw) * 10_000n) / BigInt(r.acquiredRaw);
    if (bps >= 7999n && bps <= 8001n) exact80++; else notExact++;
  }
  const summary = {
    _comment: [
      "JTX fee sweeps that paid JTO into the DAO treasury's JTO account, since JIP-38 activation.",
      "Produced by sweeps.mjs from every inflow transaction track.mjs recorded for that account.",
      "A sweep is a transaction in which the JTX program itself logs `ix: FeeSweepPrepare`.",
      "Amounts are exact base units (9 decimals). This is a dated record, not a live figure.",
    ],
    generatedAt: new Date().toISOString(),
    resolvedAt: state.resolvedAt ?? null,
    program: JTX_PROGRAM,
    treasury: TREASURY,
    treasuryTokenAccount: TREASURY_TOKEN_ACCOUNT,
    window: {
      activation: new Date(ACTIVATION * 1000).toISOString(),
      firstSweep: firstSweep ? new Date(firstSweep * 1000).toISOString() : null,
      lastSweep: lastSweep ? new Date(lastSweep * 1000).toISOString() : null,
    },
    transactions: {
      inflows: sigs.length,
      resolved: rows.length,
      unresolved: missing,
      sweeps: sweeps.length,
      notSweeps: other.length,
      failed: rows.filter((r) => r.failed).length,
    },
    signers: [...signers].sort((a, b) => b[1] - a[1]).map(([address, count]) => ({ address, count })),
    jto: {
      acquiredRaw: acquiredRaw.toString(),
      toTreasuryRaw: treasurySweepRaw.toString(),
      toOthersRaw: (acquiredRaw - treasurySweepRaw).toString(),
      treasurySharePpm: ppm(treasurySweepRaw, acquiredRaw),
    },
    perSweepTreasuryShare: { within1bpOf80pct: exact80, other: notExact },
    // Every distinct way a sweep split its JTO, in basis points of the JTO it
    // acquired. The treasury-to-largest-other ratio is what JIP-38's 80/20 is
    // about; a third recipient taking a share first is recorded, not judged.
    splitPatterns: splitPatterns(sweeps),
    otherRecipients: [...recips].sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .map(([owner, raw]) => ({ owner, raw: raw.toString(), sharePpm: ppm(raw, acquiredRaw) })),
    reconciliation: {
      against: "track.mjs inbound total for the same account, parsed independently",
      ledgerInboundRaw: ledgerInboundRaw.toString(),
      attributedRaw: allTreasuryRaw.toString(),
      differenceRaw: (diff < 0n ? -diff : diff).toString(),
      exact: diff === 0n && missing === 0,
    },
    notEstablished: [
      "The USD value of the JTO acquired: sweeps spend several tokens and this record holds no price series.",
      "Total fees collected: tokens routed through a sweep include intermediate swap hops, so outflows are not a fee total.",
      "Who controls the recipient accounts. They are recorded by address and on-chain account type only.",
    ],
  };
  atomicWrite(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nwrote ${SUMMARY}`);
}
