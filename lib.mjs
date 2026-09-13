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

// Decode a Metaplex Metadata account.
//
// Identity used to be established by searching the raw account bytes for the
// text "jito.network", which any account could contain for any reason — an
// attacker-chosen URI, a name field, or coincidence. Worse, a substring search
// never checks the one field that actually binds the metadata to the token:
// the mint it was issued for.
//
// The layout is borsh: key(1) | updateAuthority(32) | mint(32) | then three
// length-prefixed strings, name, symbol and uri.
export function parseMetadata(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 69) throw new Error("metadata account too short");
  let o = 65;
  const str = (field) => {
    if (o + 4 > buf.length) throw new Error(`metadata truncated before ${field}`);
    const len = buf.readUInt32LE(o); o += 4;
    if (len > 1000 || o + len > buf.length) throw new Error(`metadata ${field} length out of range`);
    const s = buf.subarray(o, o + len).toString("utf8").replace(/\0+$/, "").trim();
    o += len;
    return s;
  };
  return {
    key: buf[0],
    updateAuthority: b58encode(buf.subarray(1, 33)),
    mint: b58encode(buf.subarray(33, 65)),
    name: str("name"),
    symbol: str("symbol"),
    uri: str("uri"),
  };
}

// Is this URI served by `domain` or a subdomain of it?
//
// Parsed as a URL rather than matched as text, so that
// "https://jito.network.example.com/x" and "https://evil.example/?ref=jito.network"
// both fail — which a substring check passes.
export function hostMatches(uri, domain) {
  let host;
  try { host = new URL(uri).hostname.toLowerCase(); } catch { return false; }
  const d = domain.toLowerCase();
  return host === d || host.endsWith(`.${d}`);
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

// Trapezoidal integration of a signature-rate curve over [from, to], with the
// ends held flat beyond the outermost samples.
//
// Density on a hot mint is nowhere near uniform: the chain head can run an order
// of magnitude busier than the weeks behind it, so projecting one reading across
// a window overstates it several fold.
//
// Every segment is CLIPPED to the requested interval and the curve interpolated
// at the boundaries. An earlier version summed whole segments regardless of the
// interval asked for, so samples at t=0 and t=100 answered "100" for the twenty
// seconds between 40 and 60 — a five-fold overstatement of the work a scan
// would have to do, which is exactly the number a feasibility decision rests on.
export function integrateDensity(samples, from, to) {
  const pts = [...samples]
    .filter((s) => Number.isFinite(s.at) && Number.isFinite(s.rate))
    .sort((a, b) => a.at - b.at);
  if (!pts.length || !(to > from)) return 0;

  // The rate at time t along the segment a..b, linearly interpolated.
  const rateAt = (a, b, t) => (a.at === b.at ? b.rate : a.rate + (b.rate - a.rate) * ((t - a.at) / (b.at - a.at)));

  let total = 0;

  // Flat extrapolation before the first sample, but only inside [from, to].
  const headEnd = Math.min(to, pts[0].at);
  if (headEnd > from) total += pts[0].rate * (headEnd - from);

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const lo = Math.max(from, a.at), hi = Math.min(to, b.at);
    if (hi <= lo) continue;
    total += ((rateAt(a, b, lo) + rateAt(a, b, hi)) / 2) * (hi - lo);
  }

  // Flat extrapolation after the last sample, again only inside [from, to].
  const lastPt = pts[pts.length - 1];
  const tailStart = Math.max(from, lastPt.at);
  if (to > tailStart) total += lastPt.rate * (to - tailStart);

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
// The confidences the registry's own header documents. A value outside this set
// is a typo, and a typo in this column silently changes whether a figure is
// treated as load-bearing — so it is rejected rather than carried.
export const CONFIDENCES = ["confirmed", "strong", "tentative", "rejected"];

const B58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseRegistry(text) {
  // Line numbers are kept from the original file so an error names the line a
  // person can actually go and look at.
  const numbered = text.split(/\r?\n/)
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.trim() && !line.startsWith("#"));
  if (!numbered.length) throw new Error("registry has no rows");

  const header = numbered.shift().line.split("\t").map((h) => h.trim());
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const need of ["role", "address", "confidence"]) {
    if (col[need] === undefined) throw new Error(`registry has no "${need}" column`);
  }

  const entries = numbered.map(({ line, n }) => {
    const f = line.split("\t");
    const get = (name) => (f[col[name]] ?? "").trim();
    const entry = {
      role: get("role"), address: get("address"), confidence: get("confidence"),
      since: get("since"), evidence: get("evidence"), line: n,
    };
    // A malformed row used to be dropped silently, which meant a mistyped
    // address could quietly remove a role from verification and leave the
    // verifier reporting success over a registry it had never fully read.
    if (!entry.role) throw new Error(`registry line ${n}: no role`);
    if (!entry.address) throw new Error(`registry line ${n}: role "${entry.role}" has no address`);
    if (!B58_ADDRESS.test(entry.address)) {
      throw new Error(`registry line ${n}: "${entry.address}" is not a base58 address`);
    }
    if (!CONFIDENCES.includes(entry.confidence)) {
      throw new Error(`registry line ${n}: confidence "${entry.confidence}" is not one of ${CONFIDENCES.join(", ")}`);
    }
    if (!entry.evidence) throw new Error(`registry line ${n}: role "${entry.role}" has no evidence`);
    return entry;
  });

  // A header-only registry parsed as an empty list, and every consumer read
  // that as "nothing to check" and reported success. An empty registry is a
  // broken file, not a clean bill of health.
  if (!entries.length) throw new Error("registry has a header but no entries");
  return entries;
}

// A registry entry the project leans on. Anything at confirmed or strong feeds a
// published figure, so an untested role at those confidences is a hole in the
// verification, not a detail.
export function isRelied(entry) {
  return entry.confidence === "confirmed" || entry.confidence === "strong";
}
