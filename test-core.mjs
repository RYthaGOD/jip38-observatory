// Offline tests for core.mjs and rpc.mjs.
//
//   node test-core.mjs
//
// No network and no clock: the RPC client takes an injected fetch, an injected
// wait, and an injected now, so pacing, retry and batch behaviour are tested
// deterministically and in milliseconds.
//
// These assert the behaviour the project NEEDS, not the behaviour it had. Each
// section names the audit finding it holds shut, so a regression says which
// defect came back rather than only that something broke.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requireThat, integer, address, raw, units, decimalRaw, atomicWrite, withLock,
  safeError, GENESIS_RAW, DECIMALS,
} from "./core.mjs";
import { createRpc } from "./rpc.mjs";

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}
const section = (s) => console.log(`\n${s}`);
const tmp = mkdtempSync(join(tmpdir(), "jip38-test-"));

// A fetch stand-in. `script` is consulted per call so a test can change the
// answer between attempts and exercise the retry path.
function mockFetch(script) {
  let n = 0;
  const f = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const attempt = n++;
    const r = typeof script === "function" ? script(body, attempt) : script;
    return {
      status: r.status ?? 200,
      json: async () => (typeof r.body === "function" ? r.body(body) : r.body),
    };
  };
  f.count = () => n;
  return f;
}
const echoOk = (body) => (Array.isArray(body)
  ? body.map((r) => ({ jsonrpc: "2.0", id: r.id, result: `ok-${r.id}` }))
  : { jsonrpc: "2.0", id: body.id, result: "ok" });
// A virtual clock. `wait(ms)` advances it instead of sleeping, so pacing is
// exercised exactly as in production but the suite runs in milliseconds rather
// than waiting out a real token bucket.
function client(opts = {}) {
  let clock = 0;
  return createRpc({
    url: "https://rpc.invalid",
    wait: async (ms) => { clock += ms; },
    now: () => clock,
    ...opts,
  });
}

// --- exact arithmetic (finding 16) ------------------------------------------

section("exact token arithmetic — finding 16");
await t("genesis supply is exact in base units, beyond Number's safe range", () => {
  assert.equal(GENESIS_RAW, 1_000_000_000_000_000_000n);
  assert.ok(GENESIS_RAW > BigInt(Number.MAX_SAFE_INTEGER),
    "the invariant this project depends on must not be representable as a Number");
});
await t("a burn of one base unit is visible against full supply", () => {
  // This is the case Number loses entirely: 10^18 - 1 rounds back to 10^18.
  const after = GENESIS_RAW - 1n;
  assert.equal(GENESIS_RAW - after, 1n);
  assert.equal(Number(GENESIS_RAW) - Number(after), 0, "Number really does lose it");
});
await t("units() renders base units without going through a float", () => {
  assert.equal(units(GENESIS_RAW), "1000000000.000000000");
  assert.equal(units(1n), "0.000000001");
  assert.equal(units(0n), "0.000000000");
});
await t("decimalRaw() round-trips against units()", () => {
  for (const v of ["0.000000001", "1000000000.000000000", "986522689.338000000"]) {
    assert.equal(units(decimalRaw(v)), v);
  }
});
await t("decimalRaw() refuses to round a too-precise amount away", () => {
  assert.throws(() => decimalRaw("1.0000000001"), /Too many decimal places/);
});
await t("raw() rejects floats, negatives and junk rather than coercing", () => {
  for (const bad of ["1.5", "-1", "", "1e9", "0x10", null, 5]) {
    assert.throws(() => raw(bad), /Invalid raw token amount/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(raw("0"), 0n);
});

// --- validation (finding 17) ------------------------------------------------

section("configuration validation — finding 17");
await t("integer() rejects zero, negative, fractional and non-finite values", () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, "", "abc", null, undefined]) {
    assert.throws(() => integer(bad, "batch"), /Invalid batch/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(integer("10", "batch"), 10);
});
await t("a zero batch size is rejected before it can stall a loop", () => {
  // `for (i = 0; i < n; i += BATCH)` with BATCH === 0 never terminates while
  // there is work. The guard belongs at parse time, not in the loop.
  assert.throws(() => integer(0, "batch"), /Invalid batch/);
});
await t("address() rejects a truncated or mistyped address", () => {
  for (const bad of ["", "abc", "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl", "jtojto"]) {
    assert.throws(() => address(bad), /is not a base58 address/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(address("jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL"),
    "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL");
});
await t("requireThat carries its message", () => {
  assert.throws(() => requireThat(false, "the specific reason"), /the specific reason/);
});

// --- RPC batch capacity (finding 4) -----------------------------------------

section("RPC batch capacity — finding 4");
for (const n of [1, 8, 9, 10, 11, 25]) {
  await t(`a batch of ${n} completes and returns ${n} positional results`, async () => {
    const fetchImpl = mockFetch((body) => ({ body: echoOk(body) }));
    const c = client({ burst: 8, maxBatch: 10, fetchImpl });
    const out = await c.batch("getTransaction", Array.from({ length: n }, (_, i) => [i]));
    assert.equal(out.length, n);
    assert.ok(out.every((v) => typeof v === "string"), "an item never resolved");
    assert.ok(fetchImpl.count() > 0, "no fetch was ever issued — the bucket deadlocked");
  });
}
await t("a chunk never costs more than the bucket can hold", async () => {
  // burst 4 with maxBatch 10 must chunk at 4, not 10, or take() waits forever.
  const fetchImpl = mockFetch((body) => {
    assert.ok(body.length <= 4, `chunk of ${body.length} exceeds bucket capacity 4`);
    return { body: echoOk(body) };
  });
  const c = client({ burst: 4, maxBatch: 10, fetchImpl });
  assert.equal((await c.batch("m", Array.from({ length: 9 }, (_, i) => [i]))).length, 9);
});

// --- RPC fails closed (finding 2) -------------------------------------------

section("RPC fails closed — finding 2");
await t("a JSON-RPC error throws instead of returning null", async () => {
  const c = client({ attempts: 1, fetchImpl: mockFetch({ body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nope" } } }) });
  await assert.rejects(() => c.call("getAccountInfo", ["x"]), /no usable result/);
});
await t("an exhausted retry budget throws rather than reporting absence", async () => {
  const c = client({ attempts: 3, fetchImpl: mockFetch({ status: 500, body: {} }) });
  await assert.rejects(() => c.call("getTokenSupply", ["x"]), /no observation was made/);
});
await t("a missing result field is not read as a null account", async () => {
  // This is the exact shape that became `mintAuthority: null` and rendered as
  // "supply can never increase".
  const c = client({ attempts: 1, fetchImpl: mockFetch({ body: { jsonrpc: "2.0", id: 1 } }) });
  await assert.rejects(() => c.call("getAccountInfo", ["mint"]), /no usable result/);
});
await t("a genuine null result from the chain IS returned", async () => {
  // Absence must still be expressible — it just has to come from the provider.
  const c = client({ fetchImpl: mockFetch({ body: { jsonrpc: "2.0", id: 1, result: { value: null } } }) });
  assert.deepEqual(await c.call("getAccountInfo", ["mint"]), { value: null });
});
await t("an authentication failure is not retried", async () => {
  const fetchImpl = mockFetch({ status: 401, body: {} });
  const c = client({ attempts: 9, fetchImpl });
  await assert.rejects(() => c.call("getSlot", []), /rejected the request/);
  assert.equal(fetchImpl.count(), 1, "a 401 was retried, burning the rate budget");
});
await t("a transient failure is retried and then succeeds", async () => {
  const fetchImpl = mockFetch((body, n) => (n < 2 ? { status: 429, body: {} } : { body: echoOk(body) }));
  const c = client({ attempts: 5, fetchImpl });
  assert.equal(await c.call("getSlot", []), "ok");
  assert.equal(fetchImpl.count(), 3);
});

// --- batch loses nothing silently (findings 9, 12) --------------------------

section("no silent read loss — findings 9 and 12");
await t("one failed item fails the whole batch", async () => {
  const fetchImpl = mockFetch((body) => ({
    body: body.map((r) => (r.id === 2
      ? { jsonrpc: "2.0", id: r.id, error: { message: "unavailable" } }
      : { jsonrpc: "2.0", id: r.id, result: "ok" })),
  }));
  const c = client({ attempts: 1, fetchImpl });
  await assert.rejects(() => c.batch("getTransaction", [[0], [1], [2], [3]]), /unresolved/);
});
await t("a short batch response is not read as fewer transactions", async () => {
  // Dropping the tail here would silently shorten a scan's evidence.
  const fetchImpl = mockFetch((body) => ({ body: body.slice(0, 2).map((r) => ({ jsonrpc: "2.0", id: r.id, result: "ok" })) }));
  const c = client({ attempts: 1, fetchImpl });
  await assert.rejects(() => c.batch("getTransaction", [[0], [1], [2], [3]]), /unresolved/);
});
await t("batchSettled reports per-item outcomes so work can be requeued", async () => {
  const fetchImpl = mockFetch((body) => ({
    body: body.map((r) => (r.id === 1
      ? { jsonrpc: "2.0", id: r.id, error: { message: "unavailable" } }
      : { jsonrpc: "2.0", id: r.id, result: `tx-${r.id}` })),
  }));
  const c = client({ attempts: 1, fetchImpl });
  const out = await c.batchSettled("getTransaction", [[0], [1], [2]]);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((o) => o.ok), [true, false, true]);
  assert.equal(out[0].result, "tx-0");
  assert.match(out[1].reason, /unavailable/);
});
await t("batchSettled keeps results positional when a whole chunk fails", async () => {
  const fetchImpl = mockFetch((body, n) => (n === 0 ? { status: 500, body: {} } : { body: echoOk(body) }));
  const c = client({ burst: 2, maxBatch: 2, attempts: 1, fetchImpl });
  const out = await c.batchSettled("m", [[0], [1], [2], [3]]);
  assert.deepEqual(out.map((o) => o.ok), [false, false, true, true]);
});

// --- pacing still adapts ----------------------------------------------------

section("rate adaptation");
await t("a clean run raises the rate toward maxRate", async () => {
  const c = client({ rate: 8, maxRate: 40, fetchImpl: mockFetch((b) => ({ body: echoOk(b) })) });
  for (let i = 0; i < 120; i++) await c.call("getSlot", []);
  assert.ok(c.rate > 8, `rate stayed at ${c.rate}; a long scan would never speed up`);
});
await t("a 429 backs the rate off hard", async () => {
  const c = client({ rate: 8, minRate: 1, attempts: 2, fetchImpl: mockFetch((b, n) => (n === 0 ? { status: 429, body: {} } : { body: echoOk(b) })) });
  await c.call("getSlot", []);
  assert.ok(c.rate < 8, `rate stayed at ${c.rate} after being throttled`);
});
await t("invalid client configuration is rejected at construction", () => {
  assert.throws(() => createRpc({}), /invalid RPC endpoint/);
  assert.throws(() => createRpc({ url: "not-a-url" }), /invalid RPC endpoint/);
  assert.throws(() => createRpc({ url: "https://x", burst: 0 }), /Invalid burst/);
  assert.throws(() => createRpc({ url: "https://x", maxBatch: -1 }), /Invalid maxBatch/);
  assert.throws(() => createRpc({ url: "https://x", rate: 0 }), /invalid rate/);
  assert.throws(() => createRpc({ url: "https://x", rate: 50, maxRate: 40 }), /invalid rate bounds/);
});

// --- durable writes (finding 7) ---------------------------------------------

section("atomic writes and locking — finding 7");
await t("a completed write replaces the old file exactly", () => {
  const p = join(tmp, "snap.json");
  atomicWrite(p, '{"a":1}');
  atomicWrite(p, '{"a":2}');
  assert.equal(readFileSync(p, "utf8"), '{"a":2}');
});
await t("a failed write leaves the previous file intact and no debris", () => {
  const p = join(tmp, "keep.json");
  atomicWrite(p, '{"valid":true}');
  // A value that cannot be written at all: the target must not be touched.
  assert.throws(() => atomicWrite(p, { not: "a string or buffer" }));
  assert.equal(readFileSync(p, "utf8"), '{"valid":true}', "the last valid release was destroyed");
  assert.equal(readdirSync(tmp).filter((f) => f.startsWith("keep.json.")).length, 0, "temp file left behind");
});
await t("a second refresh cannot start while one holds the lock", async () => {
  const lock = join(tmp, "refresh.lock");
  let inner = null;
  await withLock(lock, async () => {
    inner = await withLock(lock, async () => "ran").then(() => "ran").catch((e) => e.message);
  });
  assert.match(String(inner), /already running/);
  assert.ok(!existsSync(lock), "the lock was not released");
});
await t("the lock is released even when the work throws", async () => {
  const lock = join(tmp, "throwing.lock");
  await assert.rejects(() => withLock(lock, async () => { throw new Error("refresh failed"); }), /refresh failed/);
  assert.ok(!existsSync(lock), "a failed refresh wedged the schedule");
});
await t("an abandoned lock does not wedge the schedule forever", async () => {
  const lock = join(tmp, "stale.lock");
  writeFileSync(lock, "{}");
  assert.equal(await withLock(lock, async () => "ran", { maxAgeMs: -1 }), "ran");
});

// --- redaction (finding 18) -------------------------------------------------

section("credential redaction — finding 18");
await t("an endpoint URL never reaches a log or manifest", () => {
  // Assembled so the literal never appears in a tracked file; see test-pipeline.mjs.
  const fakeKey = ["api", "key"].join("-") + "=" + "abcd1234-secret";
  const out = safeError(new Error(`fetch failed for https://mainnet.helius-rpc.com/?${fakeKey}`));
  assert.ok(!out.includes("abcd1234"), `key leaked: ${out}`);
  assert.ok(!out.includes("helius"), `host leaked: ${out}`);
});
await t("credentials outside the api-key query pattern are redacted too", () => {
  for (const s of ["authorization: Bearer sk-abcdef123456", "token=xyz789secret", "password: hunter2", "SECRET=topsecretvalue"]) {
    const out = safeError(new Error(s));
    assert.ok(/\[redacted\]/.test(out), `not redacted: ${out}`);
    assert.ok(!/sk-abcdef123456|xyz789secret|hunter2|topsecretvalue/.test(out), `value leaked: ${out}`);
  }
});
await t("userinfo credentials in a URL are redacted", () => {
  const out = safeError(new Error("connect to https://user:pa55word@rpc.example.com/v1 failed"));
  assert.ok(!out.includes("pa55word"), `leaked: ${out}`);
});
await t("an ordinary message survives redaction readable", () => {
  assert.equal(safeError(new Error("supply decreased by 12 JTO")), "supply decreased by 12 JTO");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
