// Offline regression tests for the chain-facing pipeline.
//
//   node test-pipeline.mjs
//
// These grew out of audit-reproductions.mjs, which CONFIRMED the defects the
// production audit found. Each case there has been turned around to assert the
// behaviour the project needs instead, so that a regression names the defect
// that came back rather than only reporting that something broke.
//
// The modules under test read the chain at import time, so each one is loaded
// into a vm with its imports stripped and its dependencies injected. That is
// awkward, and it is still worth doing: these are the paths where a wrong
// answer becomes a published number.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { findMetadataPda, parseMetadata, hostMatches, METAPLEX } from "./lib.mjs";
import {
  TREASURY, MINT, safeError, GENESIS_RAW, DECIMALS, units, decimalRaw, integer, raw, requireThat,
} from "./core.mjs";

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}
const section = (s) => console.log(`\n${s}`);

// --- verify.mjs role tests --------------------------------------------------
//
// Sliced from the source so the tests run the real logic rather than a copy of
// it. The slice starts at ReadFailure so mustRead and metadataOf come with it.

const verifySrc = readFileSync("verify.mjs", "utf8");
const verifySlice = verifySrc.slice(
  verifySrc.indexOf("class ReadFailure"),
  verifySrc.indexOf("// --- read the registry"),
);
assert.ok(verifySlice.includes("const TESTS"), "could not slice TESTS out of verify.mjs");

// Build the role tests against a scripted RPC. `answers` maps a method name to
// either a value or a function of (params).
function roleTests(answers) {
  const rpc = async (method, params) => {
    const a = answers[method];
    if (a === undefined) return { error: `no scripted answer for ${method}` };
    const v = typeof a === "function" ? a(params) : a;
    return v && Object.hasOwn(v, "error") ? v : { result: v };
  };
  return vm.runInNewContext(`${verifySlice};TESTS`, {
    rpc, JTO_MINT: MINT, TREASURY, METAPLEX, parseMetadata, hostMatches, findMetadataPda,
    Buffer, console, URL,
  });
}

const tokenAccount = (owner, mint = MINT) => ({
  value: { data: { parsed: { type: "account", info: { mint, owner, tokenAmount: { uiAmountString: "209754425.288" } } } } },
});
const mintAccount = (mintAuthority = null) => ({
  value: { data: { parsed: { type: "mint", info: { mintAuthority, freezeAuthority: null } } } },
});

section("verify: a failed read can never pass — finding 11");
await t("the historical mint authority FAILS when the mint cannot be read", async () => {
  // This is the defect exactly: an unreachable endpoint produced a null
  // authority, which read as "holds no authority over supply", and PASSED.
  const TESTS = roleTests({ getAccountInfo: { error: "unreachable after retries" } });
  await assert.rejects(() => TESTS["mint-authority-historical"]("old-authority"),
    /failed|no result/, "a failed read did not raise");
});
await t("the historical mint authority still passes on a genuine null authority", async () => {
  const TESTS = roleTests({ getAccountInfo: mintAccount(null) });
  const { ok } = await TESTS["mint-authority-historical"]("old-authority");
  assert.equal(ok, true, "a real null authority should still verify");
});
await t("the historical mint authority alarms when it IS the live authority", async () => {
  const TESTS = roleTests({ getAccountInfo: mintAccount("old-authority") });
  const { ok, notes } = await TESTS["mint-authority-historical"]("old-authority");
  assert.equal(ok, false);
  assert.match(notes.join(" "), /LIVE mint authority/);
});
await t("a mint account with no mintAuthority field is not read as null", async () => {
  const TESTS = roleTests({ getAccountInfo: { value: { data: { parsed: { type: "mint", info: {} } } } } });
  const { ok } = await TESTS["mint-authority-historical"]("old-authority");
  assert.equal(ok, false, "a missing field was treated as a confirmed null");
});

section("verify: the treasury account's owner is asserted — finding 11");
await t("a JTO account owned by someone else FAILS", async () => {
  // A JTO token account belonging to anyone at all used to satisfy the role
  // "the DAO treasury's JTO account" — the owner was printed, never compared.
  const TESTS = roleTests({ getAccountInfo: tokenAccount("not-the-dao") });
  const { ok, notes } = await TESTS["dao-treasury-token-account"]("token-acct");
  assert.equal(ok, false, "wrong owner passed");
  assert.match(notes.join(" "), /not the DAO treasury/);
});
await t("the real treasury's JTO account passes", async () => {
  const TESTS = roleTests({ getAccountInfo: tokenAccount(TREASURY) });
  const { ok } = await TESTS["dao-treasury-token-account"]("token-acct");
  assert.equal(ok, true);
});
await t("a token account holding a different mint FAILS", async () => {
  const TESTS = roleTests({ getAccountInfo: tokenAccount(TREASURY, "SomeOtherMint111111111111111111111111111111") });
  const { ok, notes } = await TESTS["dao-treasury-token-account"]("token-acct");
  assert.equal(ok, false);
  assert.match(notes.join(" "), /not JTO/);
});

section("verify: the mint's own identity — finding 11");
await t("an unavailable supply read does not leave decimals unchecked", async () => {
  const TESTS = roleTests({
    getAccountInfo: mintAccount(null),
    getTokenSupply: { error: "unavailable" },
  });
  await assert.rejects(() => TESTS["jto-mint"](MINT), /failed|no result/,
    "the mint verified without ever reading its supply");
});
await t("wrong decimals alarm", async () => {
  const TESTS = roleTests({
    getAccountInfo: (p) => (p[0] === MINT ? mintAccount(null) : { value: null }),
    getTokenSupply: { value: { uiAmountString: "1", decimals: 6 } },
  });
  const { ok, notes } = await TESTS["jto-mint"](MINT);
  assert.equal(ok, false);
  assert.match(notes.join(" "), /decimals 6/);
});

// --- track.mjs --------------------------------------------------------------
//
// Run with its imports stripped and its dependencies injected, so the real
// crawl logic executes against scripted RPC responses and in-memory writes.

const trackSrc = readFileSync("track.mjs", "utf8").replace(/^import .*;\r?\n/gm, "");
const rawSrc = readFileSync("rawscan.mjs", "utf8");

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// A transaction carrying one SPL instruction. `mint` controls what the parsed
// info declares; `balanceMint` controls what the token-balance metadata says
// the account actually holds — the two differ in exactly the case finding 10
// is about.
function txWith({ type = "transfer", info = {}, mint, balanceMint, err = null, sig = "sig1" } = {}) {
  return {
    blockTime: 1_700_000_000,
    meta: {
      err,
      preTokenBalances: balanceMint ? [{ accountIndex: 0, mint: balanceMint }] : [],
      postTokenBalances: balanceMint ? [{ accountIndex: 0, mint: balanceMint }] : [],
      innerInstructions: [],
    },
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: ["source-token-account", "dest-token-account"],
        instructions: [{
          programId: TOKEN_PROGRAM,
          parsed: { type, info: { source: "source-token-account", destination: "dest-token-account", ...(mint ? { mint } : {}), ...info } },
        }],
      },
    },
  };
}

// Run the tracker once. `sigs` throws to simulate a failed page; `txs` is the
// batchSettled outcome list. Returns the checkpoint it wrote plus its output.
async function runTracker({ sigs = () => [{ signature: "sig1", err: null }], txs, argv = [], resumeState = null,
  treasuryAccounts = () => ({ value: [{ pubkey: "seed" }] }) } = {}) {
  const logs = [];
  let state = null, events = null;
  const supply = { value: { amount: "999999999000000000", decimals: 9, uiAmountString: "999999999" } };
  const client = {
    call: async (method, params) => {
      if (method === "getTokenSupply") return supply;
      if (method === "getAccountInfo") return { value: {} };
      if (method === "getSignaturesForAddress") return sigs(params);
      if (method === "getTokenAccountsByOwner") return treasuryAccounts(params);
      throw new Error(`unscripted ${method}`);
    },
    batchSettled: async (_m, list) => txs(list),
    status: () => "",
  };
  await vm.runInNewContext(`(async()=>{${trackSrc}})()`, {
    process: {
      loadEnvFile() {}, env: { SOLANA_RPC_URL: "https://rpc.invalid" },
      argv: ["node", "track", "--batch", "1", "--max-accounts", "1", "--concurrency", "1", ...argv],
      stdout: { write() {} },
      exit(code) { throw new Error(`exit ${code}`); },
    },
    createRpc: () => client,
    parseRegistry: () => [{ role: "dao-treasury", address: "seed", confidence: "confirmed" }],
    dirname: () => "data", mkdirSync() {}, existsSync: () => argv.includes("--resume"),
    readFileSync: () => JSON.stringify({
      version: 2,
      accounts: resumeState ?? { seed: { done: false, tx: 0 } },
      events: [], seenSigs: [], counterparties: {},
    }),
    writeFileSync: (p, d) => { events = d; },
    atomicWrite: (p, d) => { state = JSON.parse(d); },
    GENESIS_RAW, DECIMALS, TREASURY, units, decimalRaw, integer, safeError,
    console: { log: (...v) => logs.push(v.join(" ")), error: (...v) => logs.push(v.join(" ")) },
    setTimeout, BigInt, Number, String, Object, Array, Set, Map, JSON, Date, RegExp, Math,
  });
  return { state, events, out: logs.join("\n"), account: state?.accounts?.seed };
}

// An account enumerated in full up to a cursor, as a monitoring cycle finds it.
const enumerated = (over = {}) => ({
  seed: { done: true, tx: 5, head: "old-sig", paginationComplete: true, coveredAt: "2026-09-01T00:00:00Z", ...over },
});

section("track: an unread page is never end-of-history — finding 9");
await t("a failed signature page leaves the account incomplete, not done", async () => {
  const r = await runTracker({
    sigs: () => { throw new Error("RPC request failed after 9 attempts"); },
    txs: () => [],
  });
  assert.equal(r.account.done, false, "a failed page marked the account fully enumerated");
  assert.match(r.account.incomplete ?? "", /pagination failed/);
});
await t("a failed page is not counted as enumerated in full", async () => {
  const r = await runTracker({
    sigs: () => { throw new Error("unreachable"); },
    txs: () => [],
  });
  assert.match(r.out, /INCOMPLETE/);
  assert.ok(!/1 enumerated in full/.test(r.out), "an unread account was reported as enumerated in full");
});
await t("an unresolved transaction is retained for retry, not skipped", async () => {
  const r = await runTracker({ txs: () => [{ ok: false, reason: "unavailable" }] });
  assert.equal(r.account.done, false, "an unresolved transaction still marked the account done");
  assert.deepEqual(r.account.unresolvedSigs, ["sig1"], "the signature was not retained");
  assert.match(r.out, /unresolved transaction/);
});
await t("a genuinely empty history completes normally", async () => {
  const r = await runTracker({ sigs: () => [], txs: () => [] });
  assert.equal(r.account.done, true, "an account with no history should complete");
  assert.equal(r.account.incomplete, undefined);
});

section("track: resume is not monitoring — finding 15");
await t("a completed account records the cursor it was complete UP TO", async () => {
  // Without a cursor there is no way to ask "what happened since?", so resume
  // could only ever mean "finish old work", never "check for new work".
  const r = await runTracker({ txs: () => [{ ok: true, result: txWith({ info: { amount: "1000000000000" }, balanceMint: MINT }) }] });
  assert.equal(r.account.done, true);
  assert.equal(r.account.head, "sig1", "no head cursor was recorded");
  assert.ok(r.account.coveredAt, "no coverage time was recorded");
});
await t("a bounded scan says so rather than implying it is current", async () => {
  const r = await runTracker({ txs: () => [{ ok: true, result: txWith({ info: { amount: "1000000000000" }, balanceMint: MINT }) }] });
  assert.match(r.out, /BOUNDED HISTORICAL SCAN/);
  assert.match(r.out, /not live monitoring/);
  assert.match(r.out, /accounts enumerated between/);
});
await t("--poll asks only for signatures NEWER than the recorded cursor", async () => {
  let untilSeen = null;
  const r = await runTracker({
    argv: ["--resume", "--poll"],
    resumeState: { seed: { done: true, tx: 1, head: "old-sig", coveredAt: "2026-09-01T00:00:00Z" } },
    sigs: (params) => {
      // The poll pass passes `until`; the enumeration pass does not.
      if (params?.[1]?.until) { untilSeen = params[1].until; return []; }
      return [{ signature: "sig1", err: null }];
    },
    txs: () => [],
  });
  assert.equal(untilSeen, "old-sig", "poll did not use the recorded cursor");
  assert.match(r.out, /polling 1 enumerated account/);
  assert.equal(r.account.done, true, "an account with no new activity should stay done");
});
await t("an account with new activity is requeued by --poll", async () => {
  const r = await runTracker({
    argv: ["--resume", "--poll"],
    resumeState: { seed: { done: true, tx: 1, head: "old-sig", coveredAt: "2026-09-01T00:00:00Z" } },
    sigs: (params) => (params?.[1]?.until ? [{ signature: "new-sig", err: null }] : [{ signature: "new-sig", err: null }]),
    txs: () => [{ ok: true, result: txWith({ sig: "new-sig", info: { amount: "1000000000000" }, balanceMint: MINT }) }],
  });
  assert.match(r.out, /1 had new activity and were requeued/);
  assert.equal(r.state.events.length, 1, "the new activity was not recorded");
});
await t("a FAILED poll is not reported as 'no new activity'", async () => {
  const r = await runTracker({
    argv: ["--resume", "--poll"],
    resumeState: { seed: { done: true, tx: 1, head: "old-sig", coveredAt: "2026-09-01T00:00:00Z" } },
    sigs: (params) => { if (params?.[1]?.until) throw new Error("RPC request failed"); return []; },
    txs: () => [],
  });
  assert.ok(r.account.pollFailed, "a failed poll left the account looking freshly confirmed");
  assert.match(r.out, /could NOT be polled/);
  assert.ok(!/is COMPLETE/.test(r.out), "completeness was claimed despite an unknown cutoff");
});

section("track: monitoring continues from the cursor, and never retires what it watches");
await t("a reopened account is continued from its cursor, not listed from the start", async () => {
  // Listing from the start re-read a history that only grows, every cycle.
  const pages = [];
  const r = await runTracker({
    argv: ["--resume", "--poll"],
    resumeState: enumerated(),
    sigs: (params) => { pages.push(params[1]); return [{ signature: "new-sig", err: null }]; },
    txs: () => [{ ok: true, result: txWith({ sig: "new-sig", info: { amount: "1000000000000" }, balanceMint: MINT }) }],
  });
  assert.ok(pages.length >= 2, "expected a poll and a continuation");
  assert.ok(pages.every((p) => p.until === "old-sig"), `a page was listed without the cursor: ${JSON.stringify(pages)}`);
  assert.equal(r.account.done, true);
  assert.equal(r.account.head, "new-sig", "the cursor did not advance");
  assert.equal(r.account.tx, 6, "the transaction count restarted instead of accumulating");
  assert.equal(r.state.events.length, 1);
});
await t("more new activity than --max-tx leaves a watched account INCOMPLETE, never retired", async () => {
  // Marking it high-volume would have stopped watching the treasury account on
  // the day its history crossed the bound.
  const many = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, err: null }));
  const r = await runTracker({
    argv: ["--resume", "--poll", "--max-tx", "5"],
    resumeState: enumerated(),
    sigs: () => many,
    txs: () => [],
  });
  assert.equal(r.account.skipped, undefined, "a watched account was retired as high-volume");
  assert.equal(r.account.done, false);
  assert.match(r.account.incomplete ?? "", /raise --max-tx/);
  assert.equal(r.account.head, "old-sig", "the cursor moved past transactions that were never read");
});
await t("a transaction a previous run could not read is retried on continuation", async () => {
  // A continuation starts after the cursor, so an older unresolved signature
  // would never be listed again unless it is handed over explicitly.
  const asked = [];
  const r = await runTracker({
    argv: ["--resume", "--poll"],
    resumeState: enumerated({ done: false, unresolvedSigs: ["lost-sig"], incomplete: "1 transaction(s) could not be resolved" }),
    sigs: () => [],
    txs: (list) => {
      asked.push(...list.map((p) => p[0]));
      return list.map(() => ({ ok: true, result: txWith({ sig: "lost-sig", info: { amount: "1000000000000" }, balanceMint: MINT }) }));
    },
  });
  assert.deepEqual(asked, ["lost-sig"], "the unresolved signature was not retried");
  assert.equal(r.account.done, true);
  assert.equal(r.account.unresolvedSigs, undefined, "a read that succeeded is still counted as unresolved");
  assert.equal(r.state.events.length, 1);
});
await t("a successful poll clears an earlier poll failure and records when", async () => {
  const r = await runTracker({
    argv: ["--resume", "--poll"],
    resumeState: enumerated({ pollFailed: "RPC request failed" }),
    sigs: () => [],
    txs: () => [],
  });
  assert.equal(r.account.pollFailed, undefined, "one transient failure would block completeness forever");
  assert.ok(r.account.checkedAt, "the confirmation time was not recorded");
});
await t("a treasury JTO account the ledger has never seen is queued and enumerated", async () => {
  const r = await runTracker({
    argv: ["--resume", "--poll", "--max-accounts", "5"],
    resumeState: enumerated(),
    treasuryAccounts: () => ({ value: [{ pubkey: "seed" }, { pubkey: "second-treasury-account" }] }),
    sigs: () => [],
    txs: () => [],
  });
  assert.ok(r.state.accounts["second-treasury-account"], "the unwatched treasury account was not added");
  assert.equal(r.state.accounts["second-treasury-account"].done, true, "the discovered account was not enumerated");
  assert.equal(r.state.treasuryDiscovery.added, 1);
});
await t("a FAILED treasury discovery is recorded and blocks the completeness claim", async () => {
  const r = await runTracker({
    argv: ["--resume", "--poll"],
    resumeState: enumerated(),
    treasuryAccounts: () => { throw new Error("RPC request failed"); },
    sigs: () => [],
    txs: () => [],
  });
  assert.ok(r.state.treasuryDiscovery.failed, "a failed discovery was not recorded");
  assert.match(r.out, /could NOT be listed/);
  assert.ok(!/is COMPLETE/.test(r.out), "completeness was claimed without knowing every treasury account");
});

section("track: only identified JTO enters the ledger — finding 10");
await t("an unchecked transfer of another token is NOT recorded as JTO", async () => {
  // The reproduction that mattered: no mint in the parsed info, token-balance
  // metadata naming a different mint, amount 1000 -> recorded as 1,000 JTO.
  const r = await runTracker({
    txs: () => [{ ok: true, result: txWith({ info: { amount: "1000000000000" }, balanceMint: "SomeOtherMint1111111111111111111111111111111" }) }],
  });
  assert.equal(r.state.events.length, 0, `another token reached the ledger: ${JSON.stringify(r.state.events)}`);
});
await t("an unchecked transfer IS recorded when the balances identify JTO", async () => {
  const r = await runTracker({
    txs: () => [{ ok: true, result: txWith({ info: { amount: "1000000000000" }, balanceMint: MINT }) }],
  });
  assert.equal(r.state.events.length, 1, "a real JTO transfer was dropped");
  assert.equal(r.state.events[0].kind, "TRANSFER");
});
await t("an instruction whose mint nothing identifies is counted unresolved, not assumed", async () => {
  const r = await runTracker({
    txs: () => [{ ok: true, result: txWith({ info: { amount: "1000000000000" } }) }],
  });
  assert.equal(r.state.events.length, 0, "an unidentified token was recorded");
  assert.ok((r.account.unresolvedMint ?? 0) > 0, "the unresolved instruction was not counted");
  assert.match(r.out, /did not identify/);
});
await t("a failed transaction contributes no events", async () => {
  const r = await runTracker({
    txs: () => [{ ok: true, result: txWith({ type: "burn", mint: MINT, info: { amount: "5000000000", account: "a", authority: "w" }, err: { InstructionError: [0, "custom"] } }) }],
  });
  assert.equal(r.state.events.length, 0, "a burn from a FAILED transaction was recorded as executed");
});

section("track: amounts stay exact — finding 16");
await t("a burn is stored in raw base units, not a float", async () => {
  const r = await runTracker({
    txs: () => [{ ok: true, result: txWith({ type: "burn", mint: MINT, info: { amount: "123456789123456789", account: "a", authority: "w" } }) }],
  });
  assert.equal(r.state.events.length, 1);
  assert.equal(r.state.events[0].raw, "123456789123456789",
    "the amount passed through a float and lost base units");
});
await t("one base unit survives a full-supply-scale amount", async () => {
  const r = await runTracker({
    txs: () => [{ ok: true, result: txWith({ type: "burn", mint: MINT, info: { amount: "999999999999999999", account: "a", authority: "w" } }) }],
  });
  assert.equal(BigInt(r.state.events[0].raw), 999_999_999_999_999_999n);
});
await t("a malformed amount is not defaulted to zero", async () => {
  const r = await runTracker({
    txs: () => [{ ok: true, result: txWith({ type: "burn", mint: MINT, info: { amount: "not-a-number", account: "a", authority: "w" } }) }],
  });
  assert.equal(r.state.events.length, 0, "a malformed burn was recorded as 0 JTO");
  assert.ok((r.account.unresolvedAmount ?? 0) > 0);
});
await t("completeness requires zero unresolved reads, not just a balanced total", async () => {
  const r = await runTracker({ txs: () => [{ ok: false, reason: "unavailable" }] });
  assert.ok(!/is COMPLETE/.test(r.out), "an incomplete ledger claimed completeness");
});

// --- rawscan.mjs ------------------------------------------------------------

section("rawscan: a scan boundary never precedes what was asked for — finding 12");
// A synthetic monotonic ledger: slot N has block time N, every slot a block.
async function anchorFor(target) {
  const anchorSrc = rawSrc.slice(rawSrc.indexOf("async function firstBlockAtOrAfter"), rawSrc.indexOf("// Read every JTO burn"));
  return vm.runInNewContext(`${anchorSrc};anchorAt(${target})`, {
    slotNow: 10000,
    rpc: async (method, args) => {
      if (method === "getBlocks") {
        const [from, to] = args;
        const out = [];
        for (let s = Math.max(1, from); s <= Math.min(to, 10000); s++) out.push(s);
        return out;
      }
      return { blockTime: args[0], signatures: [`sig-${args[0]}`] };
    },
    Array, Math, Number,
  });
}
await t("an anchor is at or after the time requested, never before it", async () => {
  // The reproduction: requesting 9000 used to return a block at 7501.
  const a = await anchorFor(9000);
  assert.ok(a, "no anchor returned");
  assert.ok(a.time >= 9000, `anchor at t=${a.time} precedes the requested boundary 9000`);
});
await t("the anchor is the FIRST block at or after the boundary, not just any", async () => {
  const a = await anchorFor(9000);
  assert.equal(a.time, 9000, `expected the boundary block itself, got t=${a.time}`);
});
await t("boundaries across the range all hold", async () => {
  for (const target of [1200, 5000, 7501, 9999]) {
    const a = await anchorFor(target);
    assert.ok(a && a.time >= target, `target ${target} produced ${a ? a.time : "null"}`);
  }
});

section("rawscan: burn identity is the instruction — finding 13");
await t("two equal burns in one transaction both survive dedupe", async () => {
  const dedupe = rawSrc.slice(rawSrc.indexOf("{\n  const seen = new Set();"), rawSrc.indexOf("allBurns.sort"));
  // The exact reproduction: same signature, same account, same amount, two
  // distinct instructions. Keyed on amount, one was deleted.
  const allBurns = [
    { sig: "tx", ix: "0", account: "acc", raw: 1n },
    { sig: "tx", ix: "1", account: "acc", raw: 1n },
  ];
  vm.runInNewContext(dedupe, { allBurns, Set });
  assert.equal(allBurns.length, 2, "a distinct burn instruction was discarded as a duplicate");
});
await t("the same instruction fetched twice still collapses to one", async () => {
  const dedupe = rawSrc.slice(rawSrc.indexOf("{\n  const seen = new Set();"), rawSrc.indexOf("allBurns.sort"));
  // Segment seams re-read the same transaction; that IS what dedupe is for.
  const allBurns = [
    { sig: "tx", ix: "0", account: "acc", raw: 1n },
    { sig: "tx", ix: "0", account: "acc", raw: 1n },
  ];
  vm.runInNewContext(dedupe, { allBurns, Set });
  assert.equal(allBurns.length, 1, "a repeated retrieval was counted twice");
});
await t("burnsFrom records each instruction's position in the transaction", async () => {
  const fn = rawSrc.slice(rawSrc.indexOf("function burnsFrom"), rawSrc.indexOf("// Resolve a list of signatures"));
  const burnsFrom = vm.runInNewContext(`${fn};burnsFrom`, { MINT, DECIMALS, BigInt, Number, Set, String });
  const ix = (amount) => ({ programId: TOKEN_PROGRAM, parsed: { type: "burn", info: { mint: MINT, amount, account: "acc", authority: "who" } } });
  const out = burnsFrom([{
    slot: 1, blockTime: 1, meta: { err: null, innerInstructions: [{ index: 0, instructions: [ix("1")] }] },
    transaction: { signatures: ["tx"], message: { instructions: [ix("1"), ix("1")] } },
  }]);
  assert.equal(out.length, 3, "not every burn instruction was read");
  // Joined rather than deepEqual: the array comes from the vm's own realm, so
  // a prototype-sensitive comparison would fail on identical contents.
  assert.equal(out.map((b) => b.ix).join(","), "0,1,0.0", "instruction positions are not distinct");
});

// --- discover.mjs -----------------------------------------------------------

const discoverSrc = readFileSync("discover.mjs", "utf8");

section("discover: a failed transaction burns nothing — finding 14");
async function verifiedCount(err) {
  const stage = discoverSrc.slice(
    discoverSrc.indexOf("const authorities = new Map();"),
    discoverSrc.indexOf("console.log(`verified burn instructions"),
  );
  const tx = {
    blockTime: 1, meta: { err },
    transaction: { message: { instructions: [{ parsed: { type: "burn", info: { mint: MINT, amount: "1000000000", authority: "who" } } }] } },
  };
  return vm.runInNewContext(`(async()=>{${stage};return {verified, failedTx};})()`, {
    found: new Map([["somesig", {}]]), rpc: async () => tx, MINT,
    supply: { value: { decimals: 9 } }, Map, Set, Number, Math, console,
  });
}
await t("a burn inside a FAILED transaction is not counted as verified", async () => {
  const { verified, failedTx } = await verifiedCount({ InstructionError: [1, "failure"] });
  assert.equal(verified, 0, "a failed transaction's burn was counted as verified");
  assert.equal(failedTx, 1, "the exclusion was not recorded");
});
await t("a burn in a successful transaction is still counted", async () => {
  const { verified } = await verifiedCount(null);
  assert.equal(verified, 1, "a real burn was dropped");
});

// --- snapshot.mjs assessment state machine ----------------------------------
//
// The guard that stops a refresh from restamping a conclusion it did not reach.
// Extracted as a pure function so the decision can be tested without a chain.

const snapSrc = readFileSync("snapshot.mjs", "utf8");
const evalSrc = snapSrc.slice(snapSrc.indexOf("function evaluateAssessment"));
const evaluateAssessment = vm.runInNewContext(
  `${evalSrc}\nfunction daysBetween(a,b){return Math.floor((b-a)/86400000);}\nevaluateAssessment`,
  { requireThat, raw, decimalRaw, units, Date, Number, Math, Object, String, BigInt, JSON },
);

// The real ASSESSMENT.json, so the tests cannot drift from the shipped file.
const ASSESSMENT = JSON.parse(readFileSync("ASSESSMENT.json", "utf8"));
const anchorSupply = decimalRaw(ASSESSMENT.anchor.supply);
const anchorTreasury = decimalRaw(ASSESSMENT.anchor.treasury);
// A recent assessedAt, so expiry does not fire in tests about other triggers.
const fresh = (over = {}) => ({ ...ASSESSMENT, assessedAt: new Date().toISOString(), ...over });

section("snapshot: a refresh cannot restamp a stale zero — finding 1");
await t("an unchanged chain leaves the assessment current", () => {
  const a = evaluateAssessment(fresh(), { currentSupplyRaw: anchorSupply, treasuryRaw: anchorTreasury });
  assert.equal(a.state, "current", a.reasons.join("; "));
  assert.deepEqual([...a.reasons], []);
});
await t("dust-scale supply drift does NOT trigger review", () => {
  // Supply always drifts down from rent reclaim; flagging that would make the
  // page cry wolf until nobody read it.
  const a = evaluateAssessment(fresh(), {
    currentSupplyRaw: anchorSupply - decimalRaw("45.107"), treasuryRaw: anchorTreasury,
  });
  assert.equal(a.state, "current", a.reasons.join("; "));
});
await t("a programme-scale supply fall FORCES review", () => {
  const a = evaluateAssessment(fresh(), {
    currentSupplyRaw: anchorSupply - decimalRaw("50000"), treasuryRaw: anchorTreasury,
  });
  assert.equal(a.state, "review-required");
  assert.match(a.reasons.join(" "), /supply has fallen/);
});
await t("ANY treasury fall forces review — this is the first-burn signal", () => {
  const a = evaluateAssessment(fresh(), {
    currentSupplyRaw: anchorSupply, treasuryRaw: anchorTreasury - decimalRaw("0.001"),
  });
  assert.equal(a.state, "review-required");
  assert.match(a.reasons.join(" "), /treasury/);
});
await t("a rising treasury does not trigger review", () => {
  // Fees accumulating is the expected behaviour, not an anomaly.
  const a = evaluateAssessment(fresh(), {
    currentSupplyRaw: anchorSupply, treasuryRaw: anchorTreasury + decimalRaw("7145.77"),
  });
  assert.equal(a.state, "current", a.reasons.join("; "));
});
await t("an expired assessment forces review even with a quiet chain", () => {
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const a = evaluateAssessment(fresh({ assessedAt: old }), {
    currentSupplyRaw: anchorSupply, treasuryRaw: anchorTreasury,
  });
  assert.equal(a.state, "review-required");
  assert.match(a.reasons.join(" "), /days old/);
});
await t("a non-zero burn without a documented valuation cannot produce a ratio", () => {
  // The project has no price source, so valuing a burn is an input, not a
  // computation. Without it the ratio stays unknown rather than invented.
  const a = evaluateAssessment(fresh({ burnedRaw: "5000000000000", burnedValuation: null }), {
    currentSupplyRaw: anchorSupply, treasuryRaw: anchorTreasury,
  });
  assert.equal(a.state, "review-required");
  assert.match(a.reasons.join(" "), /burnedValuation/);
});
await t("a non-zero burn WITH a documented valuation is accepted", () => {
  const a = evaluateAssessment(fresh({
    burnedRaw: "5000000000000",
    burnedValuation: { usd: 3200, basis: "VWAP of the buyback transactions", pricedAt: "2026-09-11T00:00:00Z" },
  }), { currentSupplyRaw: anchorSupply, treasuryRaw: anchorTreasury });
  assert.equal(a.state, "current", a.reasons.join("; "));
  assert.equal(a.burnedUsd, 3200);
});
await t("several triggers are all reported, not just the first", () => {
  const a = evaluateAssessment(fresh({ assessedAt: new Date(Date.now() - 30 * 86400000).toISOString() }), {
    currentSupplyRaw: anchorSupply - decimalRaw("50000"), treasuryRaw: anchorTreasury - decimalRaw("1"),
  });
  assert.equal(a.state, "review-required");
  assert.equal(a.reasons.length, 3, `expected supply, treasury and expiry: ${a.reasons.join("; ")}`);
});
await t("a malformed assessment file is rejected outright", () => {
  assert.throws(() => evaluateAssessment({ assessedAt: "never", burnedRaw: "0" }, {
    currentSupplyRaw: anchorSupply, treasuryRaw: anchorTreasury,
  }), /assessedAt/);
  assert.throws(() => evaluateAssessment({ assessedAt: new Date().toISOString(), burnedRaw: 0 }, {
    currentSupplyRaw: anchorSupply, treasuryRaw: anchorTreasury,
  }), /burnedRaw/);
});
await t("the shipped ASSESSMENT.json is well-formed and its anchor is real", () => {
  // Guards against the anchor being edited to something that can never trigger.
  assert.ok(anchorSupply > 0n && anchorTreasury > 0n);
  assert.ok(anchorSupply <= GENESIS_RAW, "the anchor supply exceeds genesis");
  assert.equal(raw(ASSESSMENT.burnedRaw), 0n, "the shipped assessment is no longer zero — update these tests deliberately");
});

// --- snapshot.mjs: what the live cycle established ---------------------------
//
// The summaries the snapshot embeds from the live cycle's outputs. The ledger
// block is the one that matters most: it is what turns a burn the ledger has
// recorded into a review on the public page.

const liveSrc = snapSrc.slice(snapSrc.indexOf("function readOptional"), snapSrc.indexOf("// Does the recorded assessment"));
assert.ok(liveSrc.includes("function ledgerBlock") && liveSrc.includes("function feesBlock"), "could not slice the live-cycle summaries out of snapshot.mjs");
const live = vm.runInNewContext(`${liveSrc};({ ledgerBlock, buybackBlock, feesBlock, chainExecution, unverifiedWithBuyback })`, {
  requireThat, raw, units, existsSync: () => false, readJsonFile: () => null,
  Date, Number, Math, Object, String, BigInt, JSON, Set, Array,
});

const ACTIVATION_SEC = Date.parse("2026-07-13T00:00:00Z") / 1000;
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const ledgerState = (over = {}) => ({
  polledAt: hoursAgo(1),
  treasuryDiscovery: { at: hoursAgo(1), accounts: 1, added: 0 },
  accounts: {
    "treasury-jto": { done: true, head: "h", coveredAt: hoursAgo(30), checkedAt: hoursAgo(1) },
    "venue": { done: true, skipped: "high-volume (>=60000 tx) — not enumerated", label: "jtx-fee-program" },
  },
  events: [
    { t: ACTIVATION_SEC - 86400, kind: "BURN", raw: "7000000000", from: "old", who: "x", sig: "before-activation" },
    { t: ACTIVATION_SEC + 3600, kind: "TRANSFER", raw: "5000000000", from: "a", to: "b", sig: "t1" },
  ],
  ...over,
});
const ledgerOpts = { activationSec: ACTIVATION_SEC, treasuryTokenAccounts: ["treasury-jto"] };

section("snapshot: the live ledger reaches the page — burns, staleness, coverage");
await t("a quiet, current ledger reports no burn since activation and is complete", () => {
  const b = live.ledgerBlock(ledgerState(), ledgerOpts);
  assert.equal(b.burnsSinceActivation, 0, "a burn before activation was counted as a JIP-38 burn");
  assert.equal(b.burnedSinceActivationRaw, "0");
  assert.equal(b.stale, false);
  assert.equal(b.complete, true);
  assert.deepEqual([...b.treasuryTokenAccountsNotWatched], []);
  // The last successful poll, not the original enumeration, is what is current.
  assert.ok(Date.parse(b.currentThrough.newest) > Date.now() - 2 * 3_600_000,
    `coverage was dated from the original enumeration, not the last poll: ${b.currentThrough.newest}`);
});
await t("a burn after activation is counted exactly and carried with its transaction", () => {
  const st = ledgerState();
  st.events.push({ t: ACTIVATION_SEC + 7200, kind: "BURN", raw: "123456789012345678", from: "treasury-jto", who: "dao", sig: "the-burn" });
  const b = live.ledgerBlock(st, ledgerOpts);
  assert.equal(b.burnsSinceActivation, 1);
  assert.equal(b.burnedSinceActivationRaw, "123456789012345678");
  assert.equal(b.burnedSinceActivation, "123456789.012345678");
  assert.equal(b.burns[0].signature, "the-burn");
  assert.equal(b.burns[0].account, "treasury-jto");
});
await t("a ledger not polled within a day is stale; one never polled is stale", () => {
  assert.equal(live.ledgerBlock(ledgerState({ polledAt: hoursAgo(30) }), ledgerOpts).stale, true);
  assert.equal(live.ledgerBlock(ledgerState({ polledAt: undefined }), ledgerOpts).stale, true);
});
await t("a treasury JTO account the ledger does not enumerate is named", () => {
  const b = live.ledgerBlock(ledgerState(), { ...ledgerOpts, treasuryTokenAccounts: ["treasury-jto", "venue", "brand-new"] });
  // A skipped account is recorded, not watched: it cannot count as coverage.
  assert.deepEqual([...b.treasuryTokenAccountsNotWatched], ["venue", "brand-new"]);
});
await t("unresolved reads, failed polls and failed discovery each make the ledger incomplete", () => {
  const withIncomplete = ledgerState();
  withIncomplete.accounts["treasury-jto"] = { done: false, incomplete: "2 transaction(s) could not be resolved", unresolvedSigs: ["a", "b"] };
  const b1 = live.ledgerBlock(withIncomplete, ledgerOpts);
  assert.equal(b1.complete, false);
  assert.equal(b1.unresolvedTransactions, 2);
  const withPollFailure = ledgerState();
  withPollFailure.accounts["treasury-jto"].pollFailed = "RPC request failed";
  assert.equal(live.ledgerBlock(withPollFailure, ledgerOpts).complete, false);
  assert.equal(live.ledgerBlock(ledgerState({ treasuryDiscovery: { failed: "RPC request failed" } }), ledgerOpts).complete, false);
});
await t("something that is not a ledger is rejected, not summarised as empty", () => {
  assert.throws(() => live.ledgerBlock({ accounts: {} }, ledgerOpts), /not a track.mjs checkpoint/);
  const bad = ledgerState();
  bad.events.push({ t: ACTIVATION_SEC + 1, kind: "BURN", raw: "12.5", sig: "x" });
  assert.throws(() => live.ledgerBlock(bad, ledgerOpts), /base-unit/);
});

section("snapshot: the buyback and fee summaries stay exact and consistent");
await t("the committed SWEEPS.json summarises, and its parts add up", () => {
  const b = live.buybackBlock(JSON.parse(readFileSync("SWEEPS.json", "utf8")));
  assert.equal(BigInt(b.jto.toTreasuryRaw) + BigInt(b.jto.toOthersRaw), BigInt(b.jto.acquiredRaw));
  assert.ok(b.sweeps > 0 && b.lastSweep, "no sweeps summarised");
  assert.equal(b.detail, "/sweeps.json");
});
await t("a sweeps summary whose parts do not add up is refused", () => {
  const s = JSON.parse(readFileSync("SWEEPS.json", "utf8"));
  s.jto.toOthersRaw = (BigInt(s.jto.toOthersRaw) + 1n).toString();
  assert.throws(() => live.buybackBlock(s), /does not add up/);
});
await t("the committed FEES.json summarises per token, exactly, never summed across tokens", () => {
  const f = live.feesBlock(JSON.parse(readFileSync("FEES.json", "utf8")));
  const usdc = f.stablecoins.find((c) => c.symbol === "USDC");
  assert.ok(usdc, "USDC missing from the fee summary");
  assert.equal(usdc.collected, units(BigInt(usdc.collectedRaw), 6));
  assert.equal(BigInt(usdc.sweptRaw) + BigInt(usdc.heldRaw), BigInt(usdc.collectedRaw));
  assert.equal(typeof f.complete, "boolean");
});

section("snapshot: the headline on chain alone — burned JTO against JTO bought back");
const committedBuyback = () => live.buybackBlock(JSON.parse(readFileSync("SWEEPS.json", "utf8")));
await t("a current zero assessment publishes 0 of the JTO bought for the DAO, against a 100% target", () => {
  const b = committedBuyback();
  const e = live.chainExecution({ state: "current", burnedRaw: "0" }, b);
  assert.equal(e.ratio, 0);
  assert.equal(e.burnedJto, "0.000000000");
  assert.equal(e.boughtForDaoRaw, b.jto.toTreasuryRaw, "the denominator is not the JTO paid to the treasury");
  assert.equal(e.promisedRatio, 1, "JIP-38 commits all of the DAO's share to buybacks and burns");
});
await t("the ratio is exact integer arithmetic on base units", () => {
  const b = { jto: { toTreasuryRaw: "300000000000000" }, sweeps: 1, lastSweep: null };
  const e = live.chainExecution({ state: "current", burnedRaw: "100000000000000" }, b);
  assert.equal(e.ratio, 0.333333);
});
await t("no figure is published while the assessment needs review", () => {
  const e = live.chainExecution({ state: "review-required", burnedRaw: "0" }, committedBuyback());
  assert.equal(e.ratio, null, "a stale zero was published as the chain headline");
  assert.equal(e.burnedJto, null);
  assert.ok(e.boughtForDao, "the traced buyback is still a chain fact and should still be shown");
});
await t("without decoded sweeps there is no chain headline, rather than a zero", () => {
  assert.equal(live.chainExecution({ state: "current", burnedRaw: "0" }, null), null);
});
await t("the limits list names the recipients and the 64% sweeps from the data, not from a frozen sentence", () => {
  const list = live.unverifiedWithBuyback(committedBuyback(), 13477350761501620n);
  assert.equal(list.length, 4);
  assert.match(list[0], /8DBak2z2… \(19\.\d%\) and DTA5YXD9… \(3\.\d%\)/);
  assert.match(list[1], /about half of all sweeps pay the treasury 64% rather than 80%\. Overall it received 76\.\d\d%/);
  assert.ok(!list.some((v) => /not yet traced/.test(v)), "the retired 'buyback not traced' limit survived");
  assert.match(list[3], /destroyed before activation/, "the page maps this item by that phrase");
});
await t("when the 64% pattern is not about half, the sentence says how many instead", () => {
  const b = { ...committedBuyback(), sweeps: 100, splitPatterns: [{ sweeps: 10, basisPoints: { treasury: 6400 } }, { sweeps: 90, basisPoints: { treasury: 8000 } }] };
  assert.match(live.unverifiedWithBuyback(b, 0n)[1], /^Why 10% of sweeps pay the treasury 64%/);
  const none = { ...b, splitPatterns: [{ sweeps: 100, basisPoints: { treasury: 8000 } }] };
  assert.match(live.unverifiedWithBuyback(none, 0n)[1], /^Why the treasury received/);
});

// --- sweeps.mjs --------------------------------------------------------------
//
// The decoder behind the buyback finding. Sliced out so it runs on synthetic
// transactions: the properties that matter are exact splits and never
// attributing another program's log to the JTX program.

const sweepsSrc = readFileSync("sweeps.mjs", "utf8");
const decodeSweep = vm.runInNewContext(
  `${sweepsSrc.slice(sweepsSrc.indexOf("function netChanges"), sweepsSrc.indexOf("// --- resolve"))};decode`,
  { MINT, TREASURY, JTX_PROGRAM: "JTXJTXfr1wVRMEzqiPhXUr69zJtfGuLh5qEiXG772Zj", BigInt, Map, Set },
);
const JTX = "JTXJTXfr1wVRMEzqiPhXUr69zJtfGuLh5qEiXG772Zj";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// A sweep: the vault spends USDC, a pool gives up JTO, JTO lands with the
// treasury and with a second recipient.
function sweepTx({ treasury = "80000000000", other = "20000000000", logs, err = null } = {}) {
  const bal = (owner, mint, amount, i) => ({ accountIndex: i, owner, mint, uiTokenAmount: { amount, decimals: mint === USDC ? 6 : 9 } });
  const acquired = (BigInt(treasury) + BigInt(other)).toString();
  return {
    blockTime: 1_756_000_000,
    meta: {
      err,
      logMessages: logs ?? [
        `Program ${JTX} invoke [1]`,
        "Program log: ix: FeeSweepPrepare",
        `Program ${JTX} success`,
      ],
      preTokenBalances: [
        bal(TREASURY, MINT, "1000000000000", 0),
        bal("dev-wallet", MINT, "0", 1),
        bal("pool", MINT, "500000000000", 2),
        bal("vault", USDC, "29348070600", 3),
      ],
      postTokenBalances: [
        bal(TREASURY, MINT, (1000000000000n + BigInt(treasury)).toString(), 0),
        bal("dev-wallet", MINT, other, 1),
        bal("pool", MINT, (500000000000n - BigInt(acquired)).toString(), 2),
        bal("vault", USDC, "0", 3),
      ],
    },
    transaction: {
      message: {
        accountKeys: [{ pubkey: "keeper", signer: true }, { pubkey: "x", signer: false }],
        instructions: [{ programId: JTX }],
      },
    },
  };
}

section("sweeps: the buyback decoder is exact and scoped");
await t("the treasury's share and the JTO acquired are exact base units", () => {
  const r = decodeSweep(sweepTx({ treasury: "51974800320", other: "12993700080" }));
  assert.equal(r.treasuryRaw, "51974800320");
  assert.equal(r.acquiredRaw, "64968500400");
  // 80.000% exactly, in integers — no float anywhere near it.
  assert.equal(BigInt(r.treasuryRaw) * 10n, BigInt(r.acquiredRaw) * 8n);
});
await t("the pool that GAVE UP JTO is not counted as acquiring it", () => {
  const r = decodeSweep(sweepTx());
  assert.equal(r.acquiredRaw, "100000000000", "a negative delta leaked into JTO acquired");
});
await t("other recipients exclude the treasury and include only gains", () => {
  const r = decodeSweep(sweepTx());
  assert.equal(r.recipients.length, 1);
  assert.equal(r.recipients[0].owner, "dev-wallet");
});
await t("fee tokens spent are recorded by mint", () => {
  const r = decodeSweep(sweepTx());
  assert.equal(r.spent.length, 1);
  assert.equal(r.spent[0].mint, USDC);
  assert.equal(r.spent[0].raw, "-29348070600");
});
await t("a FeeSweepPrepare log from ANOTHER program is not attributed to JTX", () => {
  // Log lines are flat. Without scoping to the JTX program's own invoke
  // window, any program logging `ix: FeeSweepPrepare` would make an unrelated
  // transaction look like a JTX buyback.
  const r = decodeSweep(sweepTx({ logs: [
    "Program SomeOtherProgram111111111111111111111111111 invoke [1]",
    "Program log: ix: FeeSweepPrepare",
    "Program SomeOtherProgram111111111111111111111111111 success",
    `Program ${JTX} invoke [1]`,
    "Program log: ix: SomethingElse",
    `Program ${JTX} success`,
  ] }));
  assert.ok(!r.jtxIx.includes("FeeSweepPrepare"), "another program's log was read as the JTX instruction");
  assert.ok(r.jtxIx.includes("SomethingElse"));
});
await t("logs after the JTX program returns are not attributed to it", () => {
  const r = decodeSweep(sweepTx({ logs: [
    `Program ${JTX} invoke [1]`,
    `Program ${JTX} success`,
    "Program log: ix: FeeSweepPrepare",
  ] }));
  assert.equal(r.jtxIx.length, 0);
});
await t("a failed transaction is flagged", () => {
  assert.equal(decodeSweep(sweepTx({ err: { InstructionError: [1, "Custom"] } })).failed, true);
  assert.equal(decodeSweep(sweepTx()).failed, false);
});

// --- fees.mjs -----------------------------------------------------------------
//
// Run in --report mode against synthetic checkpoints, so the two rules that
// decide whether its figure means anything are tested without a chain.

section("fees: only fee accounts count, and misaligned halves are never complete");
{
  const { mkdtempSync, writeFileSync: wf, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "jip38-fees-"));
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const sweepAt = Date.parse("2026-09-13T04:00:00Z") / 1000;

  // One sweep: a JTX fee account pays 10 USDC, and a DEX pool routes 10 USDC
  // onward in the same transaction. Summing every outflow would report 20.
  const sweepsState = { version: 1, resolved: { sig: {
    t: sweepAt, jtxIx: ["FeeSweepPrepare"], signers: ["keeper"], failed: false, treasuryRaw: "0", acquiredRaw: "0",
    recipients: [], spent: [
      { owner: "fee-account", mint: USDC, raw: "-10000000" },
      { owner: "dex-pool", mint: USDC, raw: "-10000000" },
    ],
  } } };
  // State and summary get unrelated names on purpose: on a case-insensitive
  // filesystem fees.json and FEES.json are the same file, and the summary would
  // silently overwrite the checkpoint it was produced from.
  const run = (readAt) => {
    const feesState = { version: 1, readAt, programAccounts: 2, feeTypes: ["3|132"], holderCount: 1, everSwept: 1,
      holderSet: ["fee-account"], slotRange: { from: 1, to: 2 }, unresolved: [],
      balances: [{ owner: "fee-account", program: "SPL Token", mint: USDC, raw: "2500000", decimals: 6 }] };
    wf(join(dir, "sweeps.json"), JSON.stringify(sweepsState));
    wf(join(dir, "fees-state.json"), JSON.stringify(feesState));
    const r = spawnSync(process.execPath, ["fees.mjs", "--report", "--sweeps", join(dir, "sweeps.json"),
      "--state", join(dir, "fees-state.json"), "--summary", join(dir, "fees-summary.json")], { encoding: "utf8" });
    return { out: r.stdout + r.stderr, status: r.status, summary: JSON.parse(readFileSync(join(dir, "fees-summary.json"), "utf8")) };
  };

  const aligned = run("2026-09-13T05:00:00Z");
  const usdc = () => aligned.summary.stablecoins.find((s) => s.symbol === "USDC");
  await t("a DEX pool's outflow in a sweep is not counted as a fee", () => {
    assert.equal(aligned.status, 0, aligned.out);
    assert.equal(usdc().sweptRaw, "10000000", "the pool hop was counted as a fee");
  });
  await t("collected is swept plus held, exactly", () => {
    assert.equal(usdc().heldRaw, "2500000");
    assert.equal(usdc().collectedRaw, "12500000");
  });
  await t("halves read an hour apart are reported complete", () => {
    assert.equal(aligned.summary.complete, true, aligned.out);
    assert.match(aligned.out, /COMPLETE: every fee-holding account/);
  });
  await t("halves read a day apart are NOT complete, and say why", () => {
    // A fee swept between the two instants is in neither side.
    const misaligned = run("2026-09-14T05:00:00Z");
    assert.equal(misaligned.summary.complete, false, "a 25-hour gap was accepted as complete");
    assert.match(misaligned.out, /in NEITHER side/);
    assert.equal(misaligned.summary.gapHours, 25);
  });
  await t("unresolved balance reads make the held side incomplete", () => {
    const feesState = JSON.parse(readFileSync(join(dir, "fees-state.json"), "utf8"));
    feesState.readAt = "2026-09-13T05:00:00Z"; feesState.unresolved = ["some-account"];
    wf(join(dir, "fees-state.json"), JSON.stringify(feesState));
    const r = spawnSync(process.execPath, ["fees.mjs", "--report", "--sweeps", join(dir, "sweeps.json"),
      "--state", join(dir, "fees-state.json")], { encoding: "utf8" });
    assert.match(r.stdout, /held side is INCOMPLETE/, `status ${r.status}; stderr: ${r.stderr}`);
    assert.match(r.stdout, /NOT COMPLETE/);
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}

section("credential redaction reaches the verifier — finding 18");
await t("a verifier failure note cannot carry the endpoint", () => {
  // Assembled rather than written out: a key-shaped literal in a tracked file
  // is what the repository's own secret scan exists to catch, and an exception
  // for test files would be a blind spot exactly where a real key gets pasted
  // by accident. The runtime value is identical.
  const fakeKey = ["api", "key"].join("-") + "=" + "live-secret-key";
  const note = `ALARM: could not verify — ${safeError(new Error(`getAccountInfo failed: fetch to https://mainnet.helius-rpc.com/?${fakeKey} refused`))}`;
  assert.ok(!note.includes("live-secret-key"), `key leaked: ${note}`);
  assert.ok(!note.includes("helius"), `host leaked: ${note}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
