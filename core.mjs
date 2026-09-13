// The primitives everything else is built on: identity constants, validation,
// exact token arithmetic, and writes that cannot leave a half-file behind.
//
// Kept free of network and process state so test.mjs can exercise all of it
// offline. Nothing here knows what JIP-38 is; it only knows how to be careful.

import {
  mkdirSync, openSync, writeFileSync, closeSync, renameSync, unlinkSync,
  existsSync, readFileSync, fsyncSync, statSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";

// --- the addresses this project is about ------------------------------------
//
// These are duplicated in REGISTRY.tsv with their evidence. The registry is the
// record; these are the constants the code runs on. verify.mjs checks that they
// still behave as the registry claims.

export const MINT = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";
export const TREASURY = "5eosrve6LktMZgVNszYzebgmmC7BjLK8NoWyRQtcmGTF";
export const TREASURY_ACCOUNT = "2Ch9AWnbAaummLkWTTtNgTAvrFq8YMATUaaN77TB2Y6C";
export const FEE_PROGRAM = "JTXJTXfr1wVRMEzqiPhXUr69zJtfGuLh5qEiXG772Zj";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// Exactly 1,000,000,000 JTO at 9 decimals, verified on chain by a single
// mintToChecked on 2023-11-27. Held in base units because that is the only
// representation in which the supply invariant is exact.
export const DECIMALS = 9;
export const GENESIS_RAW = 1_000_000_000_000_000_000n;

// --- validation -------------------------------------------------------------

export function requireThat(ok, message) {
  if (!ok) throw new Error(message);
}

// A safe integer within bounds, or a throw. Used for every CLI argument and
// client setting: a zero batch size silently stops `i += BATCH` from making
// progress, which looks exactly like "there was no work to do".
export function integer(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  requireThat(Number.isSafeInteger(n) && n >= min && n <= max,
    `Invalid ${name}: expected an integer in [${min}, ${max}], got ${JSON.stringify(value)}`);
  return n;
}

// A base-58 address. Not a curve check — just enough to reject a truncated or
// mistyped address before it is used to attribute money to somebody.
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function address(value, name = "address") {
  requireThat(typeof value === "string" && B58_RE.test(value),
    `Invalid ${name}: ${JSON.stringify(value)} is not a base58 address`);
  return value;
}

// --- exact token arithmetic -------------------------------------------------
//
// JTO's base-unit supply is 10^18, which is larger than Number.MAX_SAFE_INTEGER
// (~9.007 x 10^15). Converting raw amounts to Number loses base units, and the
// supply invariant this project depends on — burns == genesis - supply — is
// only a proof if it is exact. So raw amounts stay BigInt everywhere and are
// converted to a string for display at the very last moment.

export function raw(value) {
  requireThat(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value),
    `Invalid raw token amount: ${JSON.stringify(value)}`);
  return BigInt(value);
}

// Base units -> a decimal string. Never a Number: the caller is displaying it.
export function units(value, decimals = DECIMALS) {
  const n = typeof value === "bigint" ? value : raw(value);
  const sign = n < 0n ? "-" : "";
  const a = n < 0n ? -n : n;
  const scale = 10n ** BigInt(decimals);
  return sign + (a / scale) + "." + (a % scale).toString().padStart(decimals, "0");
}

// A decimal string -> base units, refusing to round. More decimal places than
// the token has is a malformed amount, not something to truncate quietly.
export function decimalRaw(value, decimals = DECIMALS) {
  requireThat(typeof value === "string" && /^\d+(\.\d+)?$/.test(value),
    `Invalid decimal amount: ${JSON.stringify(value)}`);
  const [whole, frac = ""] = value.split(".");
  requireThat(frac.length <= decimals, `Too many decimal places in ${value}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0"));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// --- writes that survive being interrupted ----------------------------------

// Read a reviewed JSON input, saying what it was for when it is missing or
// malformed. The `what` matters: these files carry judgements a script must not
// make for itself, so "ASSESSMENT.json is missing" should read as a refusal to
// proceed, not as a file-not-found.
export function readJsonFile(path, what) {
  requireThat(existsSync(path), `${path} is missing — ${what} must be an explicit, reviewed input`);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`); }
}

// Write to a temporary file, flush it to disk, then rename over the target.
// Rename is atomic within a filesystem, so a reader sees either the whole old
// file or the whole new one — never the truncated middle of a write that was
// interrupted. The dashboard build reads these files while a refresh may be
// running, so this is not theoretical.
export function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, value);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

// Refuse to run if another refresh is already running. Exclusive create ('wx')
// is the lock: it fails if the file exists. A lock older than maxAgeMs is
// treated as abandoned, because a crashed run must not wedge the schedule
// forever.
// Async so that EVERY failure — including "someone else holds the lock" —
// arrives as a rejected promise. A function that sometimes throws synchronously
// and sometimes rejects is one a caller will eventually handle only half of.
export async function withLock(path, fn, { maxAgeMs = 3600_000 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    let age = Infinity;
    // Clamped at zero: filesystem timestamps can round marginally ahead of the
    // clock, and a lock from the future is really a lock from just now — which
    // is the case where it must be respected, not discarded.
    try { age = Math.max(0, Date.now() - statSync(path).mtimeMs); } catch { /* unreadable: treat as stale */ }
    requireThat(age > maxAgeMs,
      `A refresh is already running (lock held at ${path}). Remove it if that is wrong.`);
    unlinkSync(path);
  }
  const fd = openSync(path, "wx", 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  closeSync(fd);
  return Promise.resolve().then(fn).finally(() => {
    try { unlinkSync(path); } catch { /* already gone */ }
  });
}

// --- process plumbing -------------------------------------------------------

// A --flag's value, or a fallback. Throws when the flag is present but its
// value is missing or is itself another flag, so `--batch --resume` fails
// loudly instead of parsing as batch="--resume" -> NaN.
export function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  requireThat(value !== undefined && !value.startsWith("--"), `${flag} needs a value`);
  return value;
}

// Strip anything credential-shaped out of a message before it reaches a log, a
// manifest, or the published page. The endpoint URL carries the API key as a
// query parameter, and RPC errors quote the URL back.
export function safeError(error) {
  return String(error?.message || error)
    .replace(/https?:\/\/[^\s"'<>]+/g, "[endpoint]")
    // The optional scheme word matters: "authorization: Bearer sk-xxx" would
    // otherwise redact "Bearer" and print the token it was introducing.
    .replace(
      /(api[-_]?key|token|authorization|password|secret)([=:]\s*)(?:(Bearer|Basic|Token)\s+)?[^\s,;&"']+/gi,
      (_m, key, sep, scheme) => `${key}${sep}${scheme ? scheme + " " : ""}[redacted]`,
    );
}

// A safe way to name an endpoint in a log, a manifest, or the published page.
//
// The RPC URL carries the API key as a query parameter, so it can never be
// printed. The host alone is what a reader actually wants to know — which
// provider a figure was read from — and it carries no credential.
export function endpointLabel(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return "[endpoint]";
  }
}

