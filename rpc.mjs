// A rate-aware Solana RPC client, shared by every script here.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// Earlier runs saw 68-77% of requests rejected with HTTP 429 and retried under
// exponential backoff, which made an exhaustive scan look unaffordable. That
// was self-inflicted, and measuring it settled the cause:
//
//   singles, back-to-back : 25 ok /  0 throttled  (5.5 req/s, latency-bound)
//   JSON-RPC batch of 5   :  5 ok /  0 throttled
//   JSON-RPC batch of 25  :  1 ok /  4 throttled
//   JSON-RPC batch of 50  :  0 ok /  5 throttled
//
// The provider counts EVERY ITEM in a JSON-RPC batch against the rate limit. A
// batch of 50 is 50 requests fired in the same instant, so it blows any
// per-second budget immediately. Batching was reducing HTTP overhead while
// destroying throughput.
//
// So this client meters CREDITS, not HTTP calls: a batch of N costs N. It paces
// against a token bucket instead of discovering the limit by being refused, and
// adapts — additive increase while clean, multiplicative decrease on a 429 —
// so it converges on whatever the key actually allows without being told.
//
// The practical effect is that a 429 becomes rare rather than routine, and rare
// 429s are what make a long scan predictable enough to leave running.
//
// ---------------------------------------------------------------------------
// WHY IT FAILS CLOSED
//
// This client used to return null when a call failed, which read as "no such
// account" at every call site. A failed mint read then became `mintAuthority:
// null`, and the dashboard renders that as "supply can never increase" — an
// RPC timeout promoted to a verified fact about the token.
//
// So there is now exactly one rule: a call either returns an observation the
// provider actually made, or it throws. Absence has to come from the chain
// saying so, never from the network failing to answer. Callers that can
// tolerate a gap must say so explicitly by using `batchSettled`, which reports
// per-item outcomes so unresolved work can be queued and retried rather than
// silently skipped.
// ---------------------------------------------------------------------------

import { integer, requireThat } from "./core.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Thrown for responses that will never succeed on retry — a bad key, a
// malformed request. Retrying these only burns the rate budget.
class FatalRpcError extends Error {}

export function createRpc({
  url,
  rate = 8,          // starting credits/second — deliberately below the measured ceiling
  minRate = 1,
  maxRate = 40,
  burst = 8,         // bucket capacity; keeps a batch from arriving as one spike
  maxBatch = 10,     // items per HTTP call; above ~10 the provider starts refusing
  timeout = 90000,
  attempts = 9,
  // Injected so pacing and retry logic can be tested without a network or a
  // real clock. Production passes none of these.
  fetchImpl = fetch,
  wait = sleep,
  now = Date.now,
} = {}) {
  requireThat(typeof url === "string" && /^https?:\/\//.test(url), "createRpc: invalid RPC endpoint");
  for (const [name, v] of Object.entries({ rate, minRate, maxRate })) {
    requireThat(Number.isFinite(v) && v > 0, `createRpc: invalid ${name}`);
  }
  requireThat(minRate <= rate && rate <= maxRate, "createRpc: invalid rate bounds");
  integer(burst, "burst");
  integer(maxBatch, "maxBatch");
  integer(timeout, "timeout", 1, 2147483647);
  integer(attempts, "attempts", 1, 20);

  // A chunk costs one credit per item, so it can never be allowed to exceed the
  // bucket's capacity — otherwise `take` waits for a token count the bucket can
  // never hold and the batch hangs forever, with no fetch ever issued.
  const chunkSize = Math.min(burst, maxBatch);

  let tokens = burst;
  let last = now();
  let current = rate;
  const stats = { requests: 0, credits: 0, throttled: 0, errors: 0, retries: 0, waitedMs: 0 };

  // Token bucket. Costing a batch at N tokens is the whole point: it is what
  // stops a "single" HTTP call from spending fifty requests' worth of budget.
  async function take(cost) {
    for (;;) {
      const t = now();
      tokens = Math.min(burst, tokens + (Math.max(0, t - last) / 1000) * current);
      last = t;
      if (tokens >= cost) { tokens -= cost; return; }
      const ms = Math.max(20, Math.ceil(((cost - tokens) / current) * 1000));
      stats.waitedMs += ms;
      await wait(ms);
    }
  }

  // Additive increase, multiplicative decrease. Being refused is expensive, so
  // back off hard and recover gently.
  let cleanRun = 0;
  function onSuccess() {
    if (++cleanRun >= 40) { cleanRun = 0; current = Math.min(maxRate, current + 0.5); }
  }
  function onThrottle() {
    cleanRun = 0;
    current = Math.max(minRate, current * 0.6);
    tokens = 0;
  }

  async function send(body, cost) {
    let lastReason = "no attempt made";
    for (let attempt = 0; attempt < attempts; attempt++) {
      await take(cost);
      stats.requests++; stats.credits += cost;
      try {
        const r = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
        if (r.status === 429 || r.status >= 500) {
          stats.throttled++; onThrottle();
          lastReason = `HTTP ${r.status}`;
          throw new Error(lastReason);
        }
        if (r.status < 200 || r.status >= 300) {
          throw new FatalRpcError(`RPC rejected the request (HTTP ${r.status})`);
        }
        const j = await r.json();
        onSuccess();
        return j;
      } catch (e) {
        stats.errors++;
        if (e instanceof FatalRpcError) throw e;
        lastReason = e?.message || String(e);
        if (attempt === attempts - 1) break;
        stats.retries++;
        await wait(Math.min(400 * 2 ** attempt, 8000) + Math.random() * 250);
      }
    }
    // Out of attempts. Returning null here is what used to turn a network
    // failure into a fact about the chain, so this throws instead.
    throw new Error(`RPC request failed after ${attempts} attempts (${lastReason}); no observation was made`);
  }

  // One method call. Throws unless the provider actually answered it.
  async function call(method, params) {
    const j = await send({ jsonrpc: "2.0", id: 1, method, params }, 1);
    requireThat(j && j.id === 1 && !j.error && Object.hasOwn(j, "result"),
      `RPC returned no usable result for ${method}`);
    return j.result;
  }

  // Many calls of the same method, split into batches the provider will accept
  // and paced by credits. Throws unless EVERY item resolved: a dropped result
  // is a dropped transaction, and a dropped transaction could be a dropped
  // burn. Callers that intend to survive a gap use batchSettled instead.
  async function batch(method, paramsList) {
    const settled = await batchSettled(method, paramsList);
    const failed = settled.filter((s) => !s.ok);
    requireThat(failed.length === 0,
      `RPC batch for ${method} left ${failed.length}/${settled.length} item(s) unresolved`);
    return settled.map((s) => s.result);
  }

  // The same work, reported per item: { ok: true, result } or { ok: false,
  // reason }. Positional, never short. This is what lets a scanner persist the
  // signatures it could not resolve instead of advancing past them.
  async function batchSettled(method, paramsList) {
    requireThat(Array.isArray(paramsList), "RPC batch needs an array of params");
    const out = new Array(paramsList.length);
    for (let i = 0; i < paramsList.length; i += chunkSize) {
      const chunk = paramsList.slice(i, i + chunkSize);
      let j;
      try {
        j = await send(chunk.map((params, id) => ({ jsonrpc: "2.0", id, method, params })), chunk.length);
      } catch (e) {
        if (e instanceof FatalRpcError) throw e;
        for (let n = 0; n < chunk.length; n++) out[i + n] = { ok: false, reason: e.message };
        continue;
      }
      // A short or duplicated batch response is a provider fault, not an
      // answer. Mark the whole chunk unresolved rather than guessing which
      // item a missing id belonged to.
      if (!Array.isArray(j) || j.length !== chunk.length) {
        for (let n = 0; n < chunk.length; n++) out[i + n] = { ok: false, reason: "incomplete batch response" };
        continue;
      }
      for (let n = 0; n < chunk.length; n++) out[i + n] = { ok: false, reason: "no response for this id" };
      const seen = new Set();
      for (const r of j) {
        if (!r || !Number.isInteger(r.id) || r.id < 0 || r.id >= chunk.length || seen.has(r.id)) continue;
        seen.add(r.id);
        out[i + r.id] = r.error || !Object.hasOwn(r, "result")
          ? { ok: false, reason: r.error?.message || "no result" }
          : { ok: true, result: r.result };
      }
    }
    return out;
  }

  const line = () =>
    `${stats.requests} calls / ${stats.credits} credits, ${stats.throttled} throttled ` +
    `(${((stats.throttled / Math.max(stats.requests, 1)) * 100).toFixed(1)}%), ${current.toFixed(1)}/s`;

  return { call, batch, batchSettled, stats, status: line, get rate() { return current; } };
}
