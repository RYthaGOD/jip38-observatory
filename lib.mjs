// Pure helpers shared by the scripts, kept free of network and process state so
// they can be tested offline. test.mjs exercises everything in here.

import { createHash } from "node:crypto";

export const METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const b = [];
  while (n > 0n) { b.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === B58[0]) b.unshift(0); else break; }
  return Buffer.from(b);
}

export function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = B58[0] + s; else break; }
  return s;
}

// The Metaplex metadata address for a mint, at a given bump. Derived rather than
// looked up in any list, so identifying a mint depends on nothing but the chain
// and this arithmetic.
export function metadataPda(mint, bump) {
  const h = createHash("sha256");
  h.update(Buffer.from("metadata"));
  h.update(b58decode(METAPLEX));
  h.update(b58decode(mint));
  h.update(Buffer.from([bump]));
  h.update(b58decode(METAPLEX));
  h.update(Buffer.from("ProgramDerivedAddress"));
  return b58encode(h.digest());
}

// Walk bumps downward and return the first candidate `exists` accepts. The
// caller decides what "exists" means (owned by the metadata program).
export async function findMetadataPda(mint, exists, lowest = 240) {
  for (let bump = 255; bump >= lowest; bump--) {
    const pda = metadataPda(mint, bump);
    if (await exists(pda)) return { pda, bump };
  }
  return null;
}

// Total seconds covered by a set of [lo, hi] spans, counting overlap once.
//
// This is what keeps a coverage figure honest. Segments walked in parallel can
// overrun into each other, and naively summing their lengths would report more
// than 100% of a window as examined — an error that would make a burn scan look
// more complete than it was.
export function unionSpans(spans) {
  const clean = spans
    .filter((s) => Array.isArray(s) && s.length === 2 && s[1] > s[0])
    .map(([lo, hi]) => [lo, hi])
    .sort((a, b) => a[0] - b[0]);
  let total = 0, lo = null, hi = null;
  for (const [a, b] of clean) {
    if (hi === null) { lo = a; hi = b; continue; }
    if (a <= hi) hi = Math.max(hi, b);
    else { total += hi - lo; lo = a; hi = b; }
  }
  if (hi !== null) total += hi - lo;
  return total;
}

// Trapezoidal integration of a signature-rate curve, with the ends held flat.
//
// Density on a hot mint is nowhere near uniform: the chain head can run an order
// of magnitude busier than the weeks behind it, so projecting one reading across
// a window overstates it several fold.
export function integrateDensity(samples, from, to) {
  const pts = [...samples].filter((s) => Number.isFinite(s.at) && Number.isFinite(s.rate)).sort((a, b) => a.at - b.at);
  if (!pts.length) return 0;
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += ((pts[i].rate + pts[i - 1].rate) / 2) * (pts[i].at - pts[i - 1].at);
  }
  total += pts[0].rate * Math.max(0, pts[0].at - from);
  total += pts[pts.length - 1].rate * Math.max(0, to - pts[pts.length - 1].at);
  return total;
}

// Is this burn authority worth tracing?
//
// Ranking burn authorities by volume ranks noise: most JTO burns are wallets
// sweeping dust to reclaim rent, which shows up as a tiny amount arriving
// alongside account closures or unrelated mints. The size threshold is
// deliberately generous, because misclassifying a real programme burn as noise
// is the expensive error and the reverse merely wastes a look.
export function classifyAuthority({ count, total, closes = 0, multiMint = 0 }) {
  if (!count) return "no burns";
  const avg = total / count;
  const sweepish = closes > 0 || multiMint > 0;
  if (avg < 100 && sweepish) return "dust-sweep (rent reclaim) — not programme activity";
  if (avg < 100) return "small — unlikely programme activity";
  if (avg >= 10000) return "PROGRAMME-SCALE — trace this";
  return "mid-size — worth a look";
}

// Parse REGISTRY.tsv. Comments start with #; the first non-comment line is the
// header. Throws rather than guessing if a required column is absent — a
// silently mis-parsed registry would verify the wrong thing.
export function parseRegistry(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (!lines.length) throw new Error("registry has no rows");
  const header = lines.shift().split("\t").map((h) => h.trim());
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const need of ["role", "address", "confidence"]) {
    if (col[need] === undefined) throw new Error(`registry has no "${need}" column`);
  }
  return lines.map((l) => {
    const f = l.split("\t");
    return {
      role: (f[col.role] ?? "").trim(),
      address: (f[col.address] ?? "").trim(),
      confidence: (f[col.confidence] ?? "").trim(),
      since: (f[col.since] ?? "").trim(),
      evidence: (f[col.evidence] ?? "").trim(),
    };
  }).filter((e) => e.role && e.address);
}

// A registry entry the project leans on. Anything at confirmed or strong feeds a
// published figure, so an untested role at those confidences is a hole in the
// verification, not a detail.
export function isRelied(entry) {
  return entry.confidence === "confirmed" || entry.confidence === "strong";
}
