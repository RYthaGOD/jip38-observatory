// Archive the operator's claim, and the chain state it is a claim about.
//
//   node capture.mjs [--out data/claims]
//
// RESUME-HERE.md argues the counter-intuitive point this file implements: the
// thing worth polling is not the chain. Chain data is immutable and queryable
// on demand, so the chain is its own archive. A Dune query is the opposite — it
// can be edited, its results can change retroactively, and it can be deleted.
// So the operator's published numbers are what has to be captured on a
// schedule, so that what was claimed on a given date cannot be revised without
// record.
//
// Every capture also records the chain state at the same moment. That is what
// makes an archived claim useful later: a number on its own is not checkable,
// but a number paired with the slot and supply it was made against is.
//
// Raw bodies go to data/ (gitignored — they are bulky and grow without bound).
// The hash manifest CLAIMS.tsv is committed, so the repository carries a
// tamper-evident record of what was captured and when even though it does not
// carry the bytes. Anyone with the archive can re-hash it and check.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { endpointLabel, safeError } from "./core.mjs";

try { process.loadEnvFile(".env"); } catch {}

const RPC = process.env.SOLANA_RPC_URL || arg("--rpc", "");
const OUT = arg("--out", join("data", "claims"));
const MANIFEST = "CLAIMS.tsv";
const MINT = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";
const DUNE_KEY = process.env.DUNE_API_KEY || "";

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("-000Z", "Z");
const dir = join(OUT, stamp);
mkdirSync(dir, { recursive: true });

const rows = [];
function record(source, url, status, body, note) {
  const buf = Buffer.from(body ?? "");
  const sha = createHash("sha256").update(buf).digest("hex");
  const name = source.replace(/[^\w.-]/g, "_") + (body?.trimStart().startsWith("{") ? ".json" : ".txt");
  writeFileSync(join(dir, name), buf);
  rows.push({ captured: stamp, source, url, status, bytes: buf.length, sha256: sha, path: join(dir, name), note });
  console.log(`  ${status === "ok" ? "captured" : status.toUpperCase().padEnd(8)} ${source.padEnd(22)} ${String(buf.length).padStart(7)}B  ${note ?? ""}`);
}

async function get(url, headers = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(45000) });
    return { code: r.status, body: await r.text() };
  } catch (e) { return { code: 0, body: "", err: e.message }; }
}

console.log(`capture ${stamp}`);
console.log(`  -> ${dir}\n`);

// --- 1. the chain anchor ---------------------------------------------------
// Always available, and the reason an archived claim stays checkable.
if (RPC) {
  const q = async (method, params) => {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(45000) });
    return (await r.json()).result;
  };
  try {
    const [supply, slot] = await Promise.all([q("getTokenSupply", [MINT]), q("getSlot", [])]);
    const blockTime = await q("getBlockTime", [slot]);
    const anchor = {
      capturedAt: new Date().toISOString(), mint: MINT, slot, blockTime,
      blockTimeIso: new Date(blockTime * 1000).toISOString(),
      supply: supply.value.amount, supplyUi: supply.value.uiAmountString, decimals: supply.value.decimals,
    };
    // A sanitised endpoint label, not a hand-rolled regex over the URL. The old
    // one matched exactly one spelling of one query parameter, so credentials
    // in userinfo, a path segment or a differently named parameter went
    // straight into the committed manifest.
    record("chain-anchor", endpointLabel(RPC), "ok",
      JSON.stringify(anchor, null, 2), `supply ${anchor.supplyUi} @ slot ${slot}`);
  } catch (e) { record("chain-anchor", endpointLabel(RPC), "fail", "", safeError(e)); }
} else {
  console.log("  SKIP     chain-anchor           no SOLANA_RPC_URL — the claim will be archived unanchored");
}

// --- 2. Jito's own token metadata -----------------------------------------
const md = await get("https://metadata.jito.network/token/jto");
record("jito-token-metadata", "https://metadata.jito.network/token/jto",
  md.code === 200 ? "ok" : "fail", md.body, `http ${md.code}`);

// --- 3. the Dune dashboard -------------------------------------------------
//
// This is the claim JIP-38's reporting commitment actually resolves to, and it
// is the one this script cannot reliably capture. dune.com/jito/jtx-metrics-ee62
// serves a client-rendered shell: the HTML contains the dashboard's title and
// none of its figures. Archiving that shell would create a convincing-looking
// record of nothing.
//
// So the shell is stored for completeness and the manifest says plainly that
// the figures were not captured. An honest gap in the record is worth more than
// a file that looks like evidence.
const dash = await get("https://dune.com/jito/jtx-metrics-ee62");
// A comma-formatted number is not a figure. A client-rendered shell carries
// commas in its embedded JSON, its navigation and its footer, so testing for
// "any number with a comma in it" called an empty page a successful capture the
// moment anything numeric appeared anywhere in the markup.
//
// A metric only counts as present if its LABEL appears with a number near it.
// And even then the status is `unvalidated` rather than `ok`: scraped HTML
// carries no schema, so nothing here can confirm the figure means what the
// label says. Only the API result below can be validated structurally.
const text = dash.body.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ");
const labelled = ["platform fee", "volume", "fills"].filter((label) => {
  const at = text.toLowerCase().indexOf(label);
  return at >= 0 && /[0-9]{1,3}(,[0-9]{3})+(\.[0-9]+)?/.test(text.slice(at, at + 400));
});
const hasFigures = labelled.length >= 2;
record("dune-dashboard-html", "https://dune.com/jito/jtx-metrics-ee62",
  dash.code !== 200 ? "fail" : hasFigures ? "unvalidated" : "shell", dash.body,
  dash.code !== 200 ? `http ${dash.code}`
    : hasFigures ? `http ${dash.code} — ${labelled.length} labelled metric(s) present, but scraped HTML carries no schema to validate against`
    : `http ${dash.code} — client-rendered shell, NO FIGURES CAPTURED`);

if (DUNE_KEY) {
  // Default to the query behind Jito's published JTX dashboard.
  const qid = arg("--dune-query", "8611988");

  // The SQL matters as much as the numbers, and for a different reason. JIP-38
  // names no addresses, so the operator's own query is one of the few places
  // they are written down: whatever accounts Jito filters on to produce these
  // figures are the accounts this project has been trying to identify. Captured
  // as a CLAIM — every address it yields is then re-tested against chain before
  // it earns a place in REGISTRY.tsv.
  const meta = await get(`https://api.dune.com/api/v1/query/${qid}`, { "X-Dune-API-Key": DUNE_KEY });
  record(`dune-query-${qid}-sql`, `https://api.dune.com/api/v1/query/${qid}`,
    meta.code === 200 ? "ok" : "fail", meta.body, `http ${meta.code}`);

  if (meta.code === 200) {
    const addrs = [...new Set((meta.body.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || []))];
    if (addrs.length) {
      console.log(`\n  ${addrs.length} candidate address(es) named in the operator's own query:`);
      for (const a of addrs.slice(0, 25)) console.log(`    ${a}`);
      console.log("  These are CLAIMS. Verify each on chain before it enters REGISTRY.tsv.");
    }
  }

  const r = await get(`https://api.dune.com/api/v1/query/${qid}/results`, { "X-Dune-API-Key": DUNE_KEY });

  // A 200 is transport success. It is not a validated claim. The response has
  // to carry the expected shape AND say when the query actually executed —
  // otherwise an empty result, or figures computed a fortnight ago, would be
  // archived as though they were current evidence.
  let status = r.code === 200 ? "ok" : "fail";
  let note = `http ${r.code}`;
  if (r.code === 200) {
    try {
      const j = JSON.parse(r.body);
      const resultRows = j?.result?.rows;
      const ranAt = j?.execution_ended_at;
      if (j?.state && j.state !== "QUERY_STATE_COMPLETED") {
        status = "fail"; note = `query state ${j.state} — not a completed execution`;
      } else if (!Array.isArray(resultRows) || resultRows.length === 0) {
        status = "fail"; note = "http 200 but the result carries no rows";
      } else if (!ranAt || Number.isNaN(Date.parse(ranAt))) {
        status = "fail"; note = "http 200 but no execution_ended_at — the age of these figures is unknown";
      } else {
        const ageHours = (Date.now() - Date.parse(ranAt)) / 3600000;
        note = `http 200, ${resultRows.length} row(s), executed ${ranAt} (${ageHours.toFixed(1)}h before capture)`;
        if (ageHours > 48) { status = "stale"; note += " — STALE: the operator's query has not re-run recently"; }
      }
    } catch (e) { status = "fail"; note = `http 200 but the body is not valid JSON: ${safeError(e)}`; }
  }
  record(`dune-query-${qid}-results`, `https://api.dune.com/api/v1/query/${qid}/results`, status, r.body, note);
} else {
  console.log("  BLOCKED  dune-query             no DUNE_API_KEY — the operator's figures cannot be archived");
  rows.push({ captured: stamp, source: "dune-query", url: "https://api.dune.com/api/v1/query/<id>/results",
    status: "blocked", bytes: 0, sha256: "", path: "",
    note: "no DUNE_API_KEY; dashboard is client-rendered so the public URL yields no figures" });
}

// --- manifest --------------------------------------------------------------
const header = "captured\tsource\turl\tstatus\tbytes\tsha256\tpath\tnote\n";
if (!existsSync(MANIFEST)) {
  writeFileSync(MANIFEST,
    "# Every capture of the operator's claim, and the chain state it was made against.\n" +
    "#\n" +
    "# Raw bodies live under data/ and are NOT committed — they are bulky and grow\n" +
    "# without bound. The sha256 here is what makes the archive tamper-evident: anyone\n" +
    "# holding the bytes can re-hash them and check them against this file's git history.\n" +
    "#\n" +
    "# status:\n" +
    "#   ok       captured, and the body contains what was wanted\n" +
    "#   shell    fetched successfully but the figures were not in it (client-rendered page)\n" +
    "#   blocked  could not be attempted — a credential is missing\n" +
    "#   fail     the fetch itself failed\n" +
    "#\n" +
    "# A run of 'shell' or 'blocked' rows is a finding, not a malfunction: it dates the\n" +
    "# point at which the operator's published figures were not archivable by this project.\n" +
    "#\n" + header);
}
for (const r of rows) {
  appendFileSync(MANIFEST, [r.captured, r.source, r.url, r.status, r.bytes, r.sha256, r.path, r.note ?? ""].join("\t") + "\n");
}

const blocked = rows.filter((r) => !["ok", "unvalidated"].includes(r.status));
console.log(`\n${rows.length} row(s) appended to ${MANIFEST}`);
if (blocked.length) {
  console.log(`\n${blocked.length} of them did not capture a validated claim:`);
  for (const b of blocked) console.log(`  ${b.status.toUpperCase()}  ${b.source}: ${b.note}`);
  console.log("\nThe reporting JIP-38 commits to is therefore not being archived by this");
  console.log("project yet. That gap is dated in CLAIMS.tsv rather than left implicit.");
}

// A run that captured nothing usable must not look like a successful one.
//
// The exit code is what a scheduler sees. This script previously exited 0 no
// matter what, so a run in which every required capture was blocked or failed
// reported success — and the gap in the archive was visible only to whoever
// read the log. `blocked` is a finding, and a finding is not a clean run.
//
// The chain anchor and the operator's figures are the two required captures:
// without the first an archived claim is not checkable later, and without the
// second there is no claim archived at all.
const REQUIRED = ["chain-anchor", "dune-query", "dune-dashboard-html"];
const missing = REQUIRED.filter((name) => {
  const got = rows.filter((r) => r.source.startsWith(name));
  return got.length === 0 || got.every((r) => !["ok", "unvalidated"].includes(r.status));
});
if (missing.length) {
  console.log(`\nFAILED: required capture(s) did not validate: ${missing.join(", ")}.`);
  console.log("CLAIMS.tsv records the attempt; this run is not evidence of a captured claim.");
  process.exit(1);
}
