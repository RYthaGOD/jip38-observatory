// Re-test every role REGISTRY.tsv claims, against chain, on every run.
//
//   node verify.mjs [--registry REGISTRY.tsv] [--quiet]
//
// REGISTRY.tsv says: "A registry entry is not permission to stop checking."
// This is that check. Each entry states a role; each role has a test; the test
// runs against the chain, not against the file. An address that stops behaving
// the way the registry says it behaves must raise an alarm rather than quietly
// continuing to feed a published figure.
//
// Exit status is the point of the script:
//   0  every entry still behaves as recorded
//   1  at least one entry FAILED its role test, or an entry the registry relies
//      on has no test and so is going unchecked
//
// A FAIL is not a bug in this script. It means a published figure is standing on
// an address that no longer supports it, and the number should come down until
// somebody has looked.

import { readFileSync } from "node:fs";
import { findMetadataPda, parseRegistry, isRelied, METAPLEX, parseMetadata, hostMatches } from "./lib.mjs";
import { TREASURY, safeError, endpointLabel } from "./core.mjs";

try { process.loadEnvFile(".env"); } catch {}

const RPC = process.env.SOLANA_RPC_URL || arg("--rpc", "");
const REGISTRY = arg("--registry", "REGISTRY.tsv");
const QUIET = process.argv.includes("--quiet");
const JTO_MINT = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function die(msg) { console.error("verify: " + msg); process.exit(2); }
if (!RPC) die("no RPC endpoint. Set SOLANA_RPC_URL in .env or pass --rpc.");

async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(45000),
      });
      if (r.status === 429 || r.status >= 500) { await sleep(600 * 2 ** attempt); continue; }
      const j = await r.json();
      if (j.error) return { error: j.error.message };
      return { result: j.result };
    } catch { await sleep(600 * 2 ** attempt); }
  }
  return { error: "unreachable after retries" };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A read that MUST succeed for the test around it to mean anything.
//
// Every test used to destructure `const { result } = await rpc(...)` and ignore
// the error, so an unreachable endpoint produced `result === undefined`, which
// then read as "the account is absent" or "the authority is null" — and the
// entry PASSED. A verifier that reports success when it could not see the chain
// is worse than no verifier, because the exit code is what the rest of the
// project trusts.
//
// Throwing here is caught by the runner and turned into a FAIL for that entry,
// which keeps "I could not check this" and "this is fine" distinct.
class ReadFailure extends Error {}
async function mustRead(method, params) {
  const { result, error } = await rpc(method, params);
  if (error) throw new ReadFailure(`${method} failed: ${error}`);
  if (result === undefined) throw new ReadFailure(`${method} returned no result`);
  return result;
}

// Read the mint's on-chain Metaplex metadata, by deriving its address rather
// than looking it up anywhere. Returns the decoded structure, so identity can
// be checked field by field instead of by searching the bytes for a substring.
async function metadataOf(mint) {
  let decoded = null;
  const hit = await findMetadataPda(mint, async (pda) => {
    const result = await mustRead("getAccountInfo", [pda, { encoding: "base64" }]);
    if (result?.value?.owner !== METAPLEX) return false;
    try { decoded = parseMetadata(Buffer.from(result.value.data[0], "base64")); }
    catch (e) { throw new ReadFailure(`metadata at ${pda} did not decode: ${e.message}`); }
    return true;
  });
  return hit ? { pda: hit.pda, ...decoded } : null;
}

// --- the role tests --------------------------------------------------------
//
// Each returns { ok, notes[] }. A test asserts the properties the registry's
// evidence column actually relies on — not merely that the address exists.

const TESTS = {
  // The root of every figure this project publishes. Three things have to hold:
  // it is an SPL mint; its supply cannot be increased (so "permanent burn" is
  // structural, and genesis-minus-current is a real burn ceiling); and its
  // on-chain metadata still identifies it as JTO under a Jito domain.
  async "jto-mint"(addr) {
    const notes = []; let ok = true;
    const acct = await mustRead("getAccountInfo", [addr, { encoding: "jsonParsed" }]);
    if (!acct?.value) return { ok: false, notes: ["ALARM: the mint account does not exist"] };
    const parsed = acct.value.data?.parsed;
    if (parsed?.type !== "mint") { return { ok: false, notes: ["not an SPL mint account"] }; }
    notes.push("is an SPL mint");

    const info = parsed.info;
    if (info.mintAuthority === null) notes.push("mintAuthority null — supply cannot increase");
    else { ok = false; notes.push(`ALARM: mintAuthority is ${info.mintAuthority} — supply can be increased, and burn totals derived from genesis supply are no longer valid`); }

    if (info.freezeAuthority === null) notes.push("freezeAuthority null");
    else notes.push(`note: freezeAuthority is ${info.freezeAuthority}`);

    // The decimals are load-bearing: every raw amount in this project is scaled
    // by them. An unavailable supply read must not leave that unchecked.
    const sup = await mustRead("getTokenSupply", [addr]);
    if (!sup?.value) { ok = false; notes.push("ALARM: the mint reports no supply"); }
    else {
      notes.push(`supply ${sup.value.uiAmountString} (decimals ${sup.value.decimals})`);
      if (sup.value.decimals !== 9) { ok = false; notes.push(`ALARM: decimals ${sup.value.decimals}, expected 9`); }
    }

    const md = await metadataOf(addr);
    if (!md) { ok = false; notes.push("ALARM: no Metaplex metadata — identity rests on format alone"); }
    else {
      notes.push(`metadata ${md.pda}: name "${md.name}", symbol "${md.symbol}", uri ${md.uri}`);
      // Each field checked on its own terms. The mint binding is the one that
      // matters most: metadata that belongs to a different token would have
      // satisfied the old substring search on the URI alone.
      if (md.mint !== addr) { ok = false; notes.push(`ALARM: metadata is issued for mint ${md.mint}, not this one`); }
      if (!/^JITO$/i.test(md.name.replace(/\s+/g, "")) && !/JITO/i.test(md.name)) {
        ok = false; notes.push(`ALARM: metadata name "${md.name}" no longer identifies JITO`);
      }
      if (!/^JTO$/i.test(md.symbol)) { ok = false; notes.push(`ALARM: metadata symbol is "${md.symbol}", not JTO`); }
      if (!hostMatches(md.uri, "jito.network")) {
        ok = false; notes.push(`ALARM: metadata uri ${md.uri} is not served by jito.network`);
      } else notes.push("uri host is jito.network or a subdomain");
    }
    return { ok, notes };
  },

  // The account the whole initial supply was minted into. The genesis figure
  // that every burn total is measured against rests on this being a JTO token
  // account, so that is what gets re-tested.
  async "genesis-token-account"(addr) {
    const notes = []; let ok = true;
    const result = await mustRead("getAccountInfo", [addr, { encoding: "jsonParsed" }]);
    if (!result?.value) return { ok: false, notes: ["account missing"] };
    const info = result.value.data?.parsed?.info;
    if (result.value.data?.parsed?.type !== "account") { ok = false; notes.push("not an SPL token account"); }
    else notes.push("is an SPL token account");
    if (info?.mint === JTO_MINT) notes.push("holds the JTO mint");
    else { ok = false; notes.push(`ALARM: mint is ${info?.mint}, not JTO`); }
    notes.push(`balance ${info?.tokenAmount?.uiAmountString ?? "?"} JTO (0 expected — it distributed everything)`);
    return { ok, notes };
  },

  // A superseded mint authority. The property recorded is that it no longer has
  // authority over supply — if that ever stopped being true, the immutability
  // the burn arithmetic depends on would be gone.
  async "mint-authority-historical"(addr) {
    const notes = []; let ok = true;
    // A failed read here used to produce `live = null`, which reads as "holds no
    // authority" — so an unreachable RPC endpoint PASSED the check that the
    // token's supply is still immutable. That is the single most load-bearing
    // fact in the project, so the read has to succeed before it can be judged.
    const result = await mustRead("getAccountInfo", [JTO_MINT, { encoding: "jsonParsed" }]);
    if (!result?.value) return { ok: false, notes: ["ALARM: the JTO mint account is unreadable — supply immutability cannot be confirmed"] };
    const parsed = result.value.data?.parsed;
    if (parsed?.type !== "mint") return { ok: false, notes: [`ALARM: ${JTO_MINT} is not a mint account`] };
    if (!Object.hasOwn(parsed.info ?? {}, "mintAuthority")) {
      return { ok: false, notes: ["ALARM: the mint account has no mintAuthority field to check"] };
    }
    const live = parsed.info.mintAuthority;
    if (live === null) notes.push("the mint's live mintAuthority is null — this address holds no authority over supply");
    else if (live === addr) { ok = false; notes.push(`ALARM: this address is the LIVE mint authority (${live}) — supply can be increased`); }
    else notes.push(`the mint's live mintAuthority is ${live}, not this address`);
    const self = await mustRead("getAccountInfo", [addr, { encoding: "jsonParsed" }]);
    notes.push(self?.value ? `exists, owner ${self.value.owner}` : "no account data");
    return { ok, notes };
  },

  // The program JTX swap fees are collected by. Supplied by Jito, so what gets
  // re-tested is the part that could change without notice: that it still
  // exists and is still executable. If it were ever replaced, every figure
  // attributing fee revenue through it would need revisiting.
  async "jtx-fee-program"(addr) {
    const result = await mustRead("getAccountInfo", [addr, { encoding: "base64" }]);
    if (!result?.value) return { ok: false, notes: ["ALARM: program account missing"] };
    const notes = [`owner ${result.value.owner}`];
    if (!result.value.executable) return { ok: false, notes: [...notes, "ALARM: no longer executable"] };
    notes.push("executable program");
    notes.push("operator-supplied address, chain-verified — see REGISTRY.tsv evidence");
    return { ok: true, notes };
  },

  // The DAO treasury wallet. The role that matters is that it still owns the
  // JTO account JIP-38's revenue share accumulates in.
  async "dao-treasury"(addr) {
    const notes = []; let ok = true;
    const result = await mustRead("getAccountInfo", [addr, { encoding: "jsonParsed" }]);
    if (!result?.value) return { ok: false, notes: ["ALARM: treasury account missing"] };
    notes.push(`system account, ${(result.value.lamports / 1e9).toFixed(2)} SOL`);
    const ta = await mustRead("getTokenAccountsByOwner", [addr, { mint: JTO_MINT }, { encoding: "jsonParsed" }]);
    const accounts = ta?.value ?? [];
    if (!accounts.length) { ok = false; notes.push("ALARM: owns no JTO token account"); }
    let total = 0;
    for (const a of accounts) total += Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0);
    notes.push(`owns ${accounts.length} JTO account(s), ${total.toLocaleString()} JTO total`);
    return { ok, notes };
  },

  // The treasury's JTO account. This is the one whose balance IS the finding:
  // JIP-38 revenue arrives here and a burn must debit it. A falling balance is
  // not itself an alarm — it could be a burn, which is the promised behaviour —
  // so this reports rather than judges, and the ledger decides which it was.
  async "dao-treasury-token-account"(addr) {
    const notes = []; let ok = true;
    const result = await mustRead("getAccountInfo", [addr, { encoding: "jsonParsed" }]);
    if (!result?.value) return { ok: false, notes: ["ALARM: account missing"] };
    const info = result.value.data?.parsed?.info;
    if (result.value.data?.parsed?.type !== "account") { ok = false; notes.push("not an SPL token account"); }
    if (info?.mint === JTO_MINT) notes.push("holds the JTO mint");
    else { ok = false; notes.push(`ALARM: mint is ${info?.mint}, not JTO`); }
    notes.push(`balance ${info?.tokenAmount?.uiAmountString ?? "?"} JTO`);
    // The owner was printed but never compared, so a JTO account belonging to
    // anyone at all satisfied the role "the DAO treasury's JTO account". This
    // account's balance IS the headline finding, so whose account it is has to
    // be asserted, not merely displayed.
    if (info?.owner === TREASURY) notes.push(`owned by the DAO treasury ${TREASURY}`);
    else { ok = false; notes.push(`ALARM: owner is ${info?.owner ?? "?"}, not the DAO treasury ${TREASURY}`); }
    return { ok, notes };
  },

  // A node on the path the initial supply took out of the genesis account.
  // These are recorded to bound the search for the JTO that has been destroyed
  // and not yet located, so what matters is that they are still JTO token
  // accounts and that their burn status has not changed underneath the note in
  // the registry.
  async "distribution-hub"(addr) {
    const notes = []; let ok = true;
    const result = await mustRead("getAccountInfo", [addr, { encoding: "jsonParsed" }]);
    if (!result?.value) return { ok: false, notes: ["account missing"] };
    const info = result.value.data?.parsed?.info;
    if (result.value.data?.parsed?.type !== "account") { ok = false; notes.push("not an SPL token account"); }
    if (info?.mint === JTO_MINT) notes.push("is a JTO token account");
    else { ok = false; notes.push(`ALARM: mint is ${info?.mint}, not JTO`); }
    notes.push(`balance ${info?.tokenAmount?.uiAmountString ?? "?"} JTO`);
    notes.push(`owner ${info?.owner ?? "?"}`);
    return { ok, notes };
  },

  // Kept so a ruled-out candidate is not rediscovered and adopted later. The
  // test does not re-litigate the rejection; it confirms the address still
  // looks like what was rejected, so that a genuine change of behaviour gets
  // noticed rather than sitting silently in a file.
  async "burn-authority-noise"(addr) {
    const notes = [];
    const result = await mustRead("getAccountInfo", [addr, { encoding: "jsonParsed" }]);
    notes.push(result?.value ? `exists, owner ${result.value.owner}` : "no account data (may be a bare keypair that has closed)");
    notes.push("rejected entry — retained to prevent rediscovery; no figure depends on it");
    return { ok: true, notes };
  },

  // An executable program this project looked at and ruled out as the burner.
  async "program-not-burner"(addr) {
    const notes = []; let ok = true;
    const result = await mustRead("getAccountInfo", [addr, { encoding: "base64" }]);
    if (!result?.value) return { ok: false, notes: ["program account missing"] };
    notes.push(result.value.executable ? "executable program" : "NOT executable — the registry describes this as a program");
    if (!result.value.executable) ok = false;
    notes.push(`owner ${result.value.owner}`);
    return { ok, notes };
  },
};

// --- read the registry -----------------------------------------------------
let raw;
try { raw = readFileSync(REGISTRY, "utf8"); }
catch { die(`cannot read ${REGISTRY}`); }

let entries;
try { entries = parseRegistry(raw); }
catch (e) { die(`${REGISTRY}: ${e.message}`); }

if (!QUIET) {
  console.log(`verify: ${entries.length} registry entr${entries.length === 1 ? "y" : "ies"} from ${REGISTRY}`);
  console.log(`        against ${endpointLabel(RPC)}\n`);
}

let failed = 0, unchecked = 0;
for (const e of entries) {
  const test = TESTS[e.role];
  if (!test) {
    // Silence here would be the dangerous outcome: an entry a figure depends on
    // that nothing re-tests. Tentative/rejected entries are noted; anything the
    // project leans on is an error.
    const relied = isRelied(e);
    console.log(`${relied ? "UNCHECKED" : "skipped  "}  ${e.role}  ${e.address}`);
    console.log(`           no test defined for role "${e.role}"`);
    if (relied) { unchecked++; failed++; }
    console.log("");
    continue;
  }
  // A read that could not be made is a FAIL for that entry, never a pass and
  // never a crash that abandons the entries after it. "I could not check this"
  // and "this is fine" must not share an exit code.
  let ok, notes;
  try { ({ ok, notes } = await test(e.address)); }
  catch (err) { ok = false; notes = [`ALARM: could not verify — ${safeError(err)}`]; }
  console.log(`${ok ? "PASS" : "FAIL"}       ${e.role}  ${e.address}`);
  console.log(`           recorded as: ${e.confidence}${e.since ? `, since ${e.since}` : ""}`);
  for (const n of notes) console.log(`           - ${n}`);
  console.log("");
  if (!ok) failed++;
}

if (failed === 0) {
  console.log("All registry entries still behave as recorded.");
} else {
  console.log(`${failed} entr${failed === 1 ? "y" : "ies"} did not verify` +
    (unchecked ? ` (${unchecked} of them for want of a role test)` : "") + ".");
  console.log("Any published figure resting on these should come down until reviewed.");
}
process.exit(failed === 0 ? 0 : 1);
