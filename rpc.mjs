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
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRpc({
  url,
  rate = 8,          // starting credits/second — deliberately below the measured ceiling
  minRate = 1,
  maxRate = 40,
  burst = 8,         // bucket capacity; keeps a batch from arriving as one spike
  maxBatch = 10,     // items per HTTP call; above ~10 the provider starts refusing
  timeout = 90000,
} = {}) {
  if (!url) throw new Error("createRpc: no url");

  let tokens = burst;
  let last = Date.now();
  let current = rate;
  const stats = { requests: 0, credits: 0, throttled: 0, errors: 0, retries: 0, waitedMs: 0 };

  // Token bucket. Costing a batch at N tokens is the whole point: it is what
  // stops a "single" HTTP call from spending fifty requests' worth of budget.
  async function take(cost) {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * current);
      last = now;
      if (tokens >= cost) { tokens -= cost; return; }
      const need = (cost - tokens) / current;
      const ms = Math.max(20, Math.ceil(need * 1000));
      stats.waitedMs += ms;
      await sleep(ms);
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
    for (let attempt = 0; attempt < 9; attempt++) {
      await take(cost);
      try {
        stats.requests++; stats.credits += cost;
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
        if (r.status === 429 || r.status >= 500) {
          stats.throttled++; stats.retries++; onThrottle();
          await sleep(Math.min(400 * 2 ** attempt, 8000) + Math.random() * 250);
          continue;
        }
        const text = await r.text();
        let j;
        try { j = JSON.parse(text); }
        catch { stats.errors++; stats.retries++; await sleep(300 * 2 ** attempt); continue; }
        onSuccess();
        return j;
      } catch {
        stats.errors++; stats.retries++;
        await sleep(Math.min(400 * 2 ** attempt, 8000));
      }
    }
    return null;
  }

  // One method call.
  async function call(method, params) {
    const j = await send({ jsonrpc: "2.0", id: 1, method, params }, 1);
    if (!j || j.error) return null;
    return j.result;
  }

  // Many calls of the same method, split into batches the provider will accept
  // and paced by credits. Returns results positionally, null where a call
  // failed — never silently short, because a dropped result is a dropped
  // transaction and a dropped transaction could be a dropped burn.
  async function batch(method, paramsList) {
    const out = new Array(paramsList.length).fill(null);
    for (let i = 0; i < paramsList.length; i += maxBatch) {
      const chunk = paramsList.slice(i, i + maxBatch);
      const j = await send(chunk.map((p, n) => ({ jsonrpc: "2.0", id: n, method, params: p })), chunk.length);
      if (!Array.isArray(j)) continue;
      for (const r of j) {
        if (typeof r?.id === "number" && r.id >= 0 && r.id < chunk.length) out[i + r.id] = r.error ? null : r.result;
      }
    }
    return out;
  }

  const line = () =>
    `${stats.requests} calls / ${stats.credits} credits, ${stats.throttled} throttled ` +
    `(${((stats.throttled / Math.max(stats.requests, 1)) * 100).toFixed(1)}%), ${current.toFixed(1)}/s`;

  return { call, batch, stats, status: line, get rate() { return current; } };
}
