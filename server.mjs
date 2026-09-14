// Serve the published dashboard.
//
//   node server.mjs [--port 8080]
//
// ---------------------------------------------------------------------------
// WHY THIS SERVES AN ALLOWLIST RATHER THAN A DIRECTORY
//
// The obvious thing is to point a static file server at `dist/` and be done.
// That directory currently also holds `dashboard.html.prev` — the rollback
// payload written before each build — and three screenshots of a design that no
// longer exists. Serving it wholesale publishes all of them, and the next file
// anything writes there is published too, without anyone deciding so.
//
// So there is no filesystem routing here at all. Every URL this server answers
// is written out below, mapped to one specific file. A path it does not know is
// a 404 before any disk access happens, which makes directory traversal not so
// much blocked as absent: there is no path to traverse.
//
// The audit's requirement was "deploy only the public output, never the
// repository root or claim archives indiscriminately". An allowlist is how that
// becomes structural instead of a rule someone has to keep remembering.
//
// ---------------------------------------------------------------------------
// WHY THE CSP CARRIES HASHES
//
// The page is deliberately self-contained: no external script, style or font,
// and it makes no network requests. That means it can run under a policy that
// forbids essentially everything — but it also embeds its script and style
// inline, so a blanket `script-src 'self'` would break it, and `'unsafe-inline'`
// would give away the protection the policy exists for.
//
// The hashes are computed from the bytes actually being served, at the moment
// they are served. Nothing has to be kept in sync by hand, and a policy can
// never drift from the page it is protecting.
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { arg, integer, safeError, atomicWrite } from "./core.mjs";

// An explicit --port beats the ambient PORT, not the other way round.
//
// It was the other way round, and that is a production failure rather than a
// style point. On Railway PORT=8080 is set in the environment, the refresh runs
// in the serving process, the refresh runs check.mjs, and check.mjs starts test
// servers with `--port <something free>`. Those children inherit PORT=8080,
// ignored their own argument, tried to bind the port the live server already
// holds, and died with EADDRINUSE — failing the suite, failing the refresh, and
// reporting a deployment failure that had nothing to do with the data.
//
// A flag someone typed is more specific than a variable the platform set.
const portFlag = arg("--port", null);
const PORT = integer(portFlag ?? process.env.PORT ?? "8080", "PORT", 1, 65535);
const HOST = process.env.HOST ?? "0.0.0.0";

// Every URL this server will answer. Anything else is a 404.
const ROUTES = {
  "/": { file: "dist/dashboard.html", type: "text/html; charset=utf-8", csp: true },
  "/index.html": { file: "dist/dashboard.html", type: "text/html; charset=utf-8", csp: true },
  // The evidence, fetchable directly. The page offers this as a download, and
  // some viewers block downloads entirely — a URL always works.
  "/snapshot.json": { file: "data/snapshot.json", type: "application/json; charset=utf-8" },
  // What was last verified as published, so the served page's provenance can be
  // checked from outside the repository.
  "/release.json": { file: "RELEASE.json", type: "application/json; charset=utf-8" },
  // Produced by the live cycle below, so they may not exist yet on a fresh
  // deploy. `optional` makes their absence a 404 that says so, rather than the
  // "not built" 503 that would wrongly suggest the site itself is broken.
  "/sweeps.json": { file: "data/SWEEPS.json", type: "application/json; charset=utf-8", optional: true },
  "/fees.json": { file: "data/FEES.json", type: "application/json; charset=utf-8", optional: true },
  "/cycle.json": { file: "data/cycle.json", type: "application/json; charset=utf-8", optional: true },
};

// --- content, cached by mtime ----------------------------------------------
//
// A refresh replaces these files underneath a running server (atomically — see
// core.atomicWrite), so the cache is keyed on what the file says about itself
// rather than held for the process lifetime.
const cache = new Map();

function load(route) {
  const { file, type, csp } = route;
  if (!existsSync(file)) return null;
  const { mtimeMs, size } = statSync(file);
  const key = `${file}:${mtimeMs}:${size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit;

  const body = readFileSync(file);
  const entry = {
    key,
    type,
    body,
    gzip: gzipSync(body, { level: 9 }),
    etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`,
    csp: csp ? policyFor(body.toString("utf8")) : POLICY_DATA,
  };
  cache.set(file, entry);
  return entry;
}

// --- the policy -------------------------------------------------------------

// Everything is denied, then exactly what the page needs is named. `connect-src
// 'none'` is the one worth reading twice: this page is a static snapshot and
// must never make a request, so if it ever tries, the browser stops it and the
// console says so.
const POLICY_BASE = [
  "default-src 'none'",
  "img-src 'self' data:",
  "font-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
];
const POLICY_DATA = [...POLICY_BASE, "script-src 'none'", "style-src 'none'"].join("; ");

// Hash what the BROWSER will hash, which is not what is on disk.
//
// The HTML parser normalises CRLF to LF in the input stream before it tokenises
// anything, so the script text a browser hashes always has LF line endings —
// whatever the file contains. Hashing the raw bytes therefore produces a policy
// that matches on a Linux checkout and silently kills the page on a Windows
// one, where git hands over CRLF. The failure is the worst shape available: a
// correct-looking page serving 200 with every figure blank.
//
// Found by cloning the repository fresh and serving that, which is the only way
// this would ever have shown up.
const sha = (s) =>
  `'sha256-${createHash("sha256").update(s.replace(/\r\n/g, "\n"), "utf8").digest("base64")}'`;

function policyFor(html) {
  // Only blocks the browser would EXECUTE need a hash. The snapshot lives in a
  // <script type="application/json"> block, which is data the page reads, never
  // script the browser runs, so it is deliberately not hashed here.
  const scripts = [];
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1];
    const typeAttr = /type\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    const executes = !typeAttr || ["text/javascript", "application/javascript", "module"].includes(typeAttr);
    if (executes && m[2].trim()) scripts.push(sha(m[2]));
  }
  const styles = [];
  for (const m of html.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)) {
    if (m[2].trim()) styles.push(sha(m[2]));
  }
  return [
    ...POLICY_BASE,
    `script-src ${scripts.length ? scripts.join(" ") : "'none'"}`,
    `style-src ${styles.length ? styles.join(" ") : "'none'"}`,
  ].join("; ");
}

// --- headers ----------------------------------------------------------------

function securityHeaders(entry) {
  return {
    "content-type": entry.type,
    "content-security-policy": entry.csp,
    // The figures change every few hours, and a stale figure is the specific
    // failure this project exists to avoid. Revalidate every time; the ETag
    // makes that cheap.
    "cache-control": "no-cache, must-revalidate",
    etag: entry.etag,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()",
    // The page is a read-only record. Nothing about it should be embedded in
    // somebody else's frame and presented as theirs.
    "x-frame-options": "DENY",
  };
}

const server = createServer((req, res) => {
  const send = (code, headers, body) => {
    res.writeHead(code, { ...headers, "content-length": Buffer.byteLength(body ?? "") });
    res.end(req.method === "HEAD" ? undefined : body);
  };

  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" }, "Method not allowed\n");
    }

    // Parsed rather than string-matched, so a query string or a fragment does
    // not turn a known route into an unknown one.
    const path = new URL(req.url, "http://localhost").pathname;

    if (path === "/healthz") {
      const ok = existsSync(ROUTES["/"].file);
      return send(ok ? 200 : 503, { "content-type": "application/json; charset=utf-8" },
        `${JSON.stringify({ ok, serving: ok ? "dashboard" : "nothing built yet" })}\n`);
    }

    const route = ROUTES[path];
    if (!route) {
      return send(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
        "Not found.\n\nThis server publishes one page and its evidence:\n  /               the dashboard\n  /snapshot.json  the snapshot it was built from\n  /sweeps.json    every JTX fee sweep into the DAO treasury, decoded\n  /fees.json      JTX fees on chain: swept, and still held\n  /cycle.json     what the live tracking cycle last did, and when\n  /release.json   what was last verified as published\n");
    }

    const entry = load(route);
    if (!entry && route.optional) {
      return send(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
        `${path} has not been produced yet. The live cycle writes it; see /cycle.json.\n`);
    }
    if (!entry) {
      return send(503, { "content-type": "text/plain; charset=utf-8" },
        "Not built yet. Run: node snapshot.mjs && node build-dashboard.mjs\n");
    }

    const headers = securityHeaders(entry);
    if (req.headers["if-none-match"] === entry.etag) return send(304, headers, "");

    const wantsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
    if (wantsGzip) return send(200, { ...headers, "content-encoding": "gzip", vary: "accept-encoding" }, entry.gzip);
    return send(200, { ...headers, vary: "accept-encoding" }, entry.body);
  } catch (err) {
    // Never leak a path or an endpoint into an error page.
    console.error(`server: ${safeError(err)}`);
    return send(500, { "content-type": "text/plain; charset=utf-8" }, "Internal error.\n");
  }
});

// --- seeding the volume ------------------------------------------------------
//
// A volume mounted at /app/data SHADOWS the committed data/ directory. The
// volume starts empty, so on the first boot after it is attached, the snapshot
// and — worse — data/history.jsonl are simply gone. The treasury series is
// evidence that is never back-filled, so the volume added to protect it would
// have been what destroyed it.
//
// The build step copies data/ to data-seed/ BEFORE the volume is mounted, which
// is the only moment the committed files are reachable. On boot, anything
// missing from the volume is restored from that seed. Existing files are never
// touched: the volume is the live record once it has one.
// The two files need opposite rules, and getting that wrong is visible.
//
//   history.jsonl is APPEND-ONLY EVIDENCE. Each line is a reading taken at a
//   moment that will not come again, and it is never back-filled. The volume's
//   copy always wins; the seed is a floor, not a replacement.
//
//   snapshot.json is a POINT IN TIME, and the page is built from it. If the
//   volume keeps an older one while the deployed page carries a newer, then
//   /snapshot.json serves evidence that disagrees with the figures beside it —
//   which, in a project whose whole argument is that the reader can check the
//   numbers, is about the worst small bug available. So the later generatedAt
//   wins, whichever side it is on.
function seedDataVolume() {
  const seedDir = "data-seed";
  if (!existsSync(seedDir)) return;
  mkdirSync("data", { recursive: true });

  const generatedAt = (path) => {
    try { return Date.parse(JSON.parse(readFileSync(path, "utf8")).generatedAt) || 0; }
    catch { return 0; }
  };

  let acted = 0;
  for (const name of readdirSync(seedDir)) {
    const from = join(seedDir, name);
    const to = join("data", name);
    if (statSync(from).isDirectory()) continue;

    if (!existsSync(to)) {
      copyFileSync(from, to);
      console.log(`  seeded       data/${name} (the volume had none)`);
      acted++;
      continue;
    }

    // Present on both sides, and the two files need different answers.
    if (name === "history.jsonl") {
      // UNION, not "volume wins".
      //
      // Two machines can both be taking readings — a local scheduled task and
      // this one — and each series then holds readings the other does not.
      // Keeping only one side silently drops real observations of a balance at
      // a moment that will not come again. Every line is a genuine reading, so
      // every line is kept; duplicates collapse on their timestamp.
      const merged = mergeReadings(readFileSync(to, "utf8"), readFileSync(from, "utf8"));
      if (merged.added) {
        writeFileSync(to, merged.text);
        console.log(`  merged       data/${name} — ${merged.added} reading(s) the volume did not have`);
        acted++;
      }
      continue;
    }

    // Point-in-time documents: the later generatedAt wins, whichever side.
    if (POINT_IN_TIME.has(name) && generatedAt(from) > generatedAt(to)) {
      copyFileSync(from, to);
      console.log(`  refreshed    data/${name} — this build carries a newer copy than the volume held`);
      acted++;
    }
  }

  // Working state for the live cycle: the enumerated ledger and the decoded
  // sweeps. Tens of megabytes, built over hours of RPC, so a deploy carries it
  // compressed in bootstrap/ rather than making the container re-crawl the chain.
  //
  // SEEDED ONLY WHEN MISSING, and never replaced. Once the live cycle has
  // advanced these files on the volume they are the record, and the copy
  // shipped with a deploy is by definition older. Overwriting would silently
  // roll the ledger back and re-decode work already done.
  if (existsSync("bootstrap")) {
    for (const name of readdirSync("bootstrap").filter((n) => n.endsWith(".json.gz"))) {
      const to = join("data", name.replace(/\.gz$/, ""));
      if (existsSync(to)) continue;
      writeFileSync(to, gunzipSync(readFileSync(join("bootstrap", name))));
      console.log(`  bootstrapped ${to} from the compressed state shipped with this deploy`);
      acted++;
    }
  }
  if (!acted) console.log("  volume       up to date; nothing seeded");
}

// Summaries that describe a single moment, where the newer one is correct.
const POINT_IN_TIME = new Set(["snapshot.json", "SWEEPS.json", "FEES.json"]);

// Union two append-only reading series on their timestamps, oldest first.
//
// A malformed line is dropped rather than allowed to break the merge — the
// series is read back defensively everywhere else too, for the same reason.
function mergeReadings(existing, incoming) {
  const byTime = new Map();
  let kept = 0;
  for (const text of [existing, incoming]) {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row?.t !== "string") continue;
      // First writer of a timestamp wins, so the volume's own reading is kept
      // when both sides recorded the same moment.
      if (!byTime.has(row.t)) { byTime.set(row.t, line.trim()); kept++; }
    }
  }
  const before = existing.split("\n").filter((l) => l.trim()).length;
  const sorted = [...byTime.entries()].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
  return { text: sorted.map(([, line]) => line).join("\n") + "\n", added: kept - before };
}

// --- refreshing, in this process ---------------------------------------------
//
// WHY THE REFRESH LIVES HERE RATHER THAN IN ITS OWN SERVICE
//
// The obvious split is two services: one serving, one reading the chain on a
// cron. It was built that way first, and it does not work — and the way it
// fails is silent, which is what makes it worth this comment.
//
// Each Railway service is its own container with its own disk. A refresh
// service rebuilds dist/dashboard.html inside ITSELF; the web service keeps
// serving its own copy and never sees the new one. Both deployments stay green,
// the cron reports success every six hours, and the page never changes. A
// volume cannot bridge it either: a volume instance binds to exactly one
// service.
//
// So the refresh runs in the process that serves. One disk, no synchronisation,
// nothing to keep in step. The server already re-reads the page when its mtime
// changes, so a completed rebuild is live on the next request.
//
// Off by default: REFRESH_INTERVAL_MINUTES is what turns it on, so a local
// `npm start` serves what is already built and never touches the chain.
//
// ---------------------------------------------------------------------------
// THE LIVE CYCLE
//
// Until 14 September 2026 the live site refreshed only the snapshot — supply,
// the treasury balance, the fee program's existence — with the registry
// verifier switched off. Everything the research had actually established ran
// on one laptop: the enumerated ledger that detects a burn, the decoded sweeps
// that prove the buyback, the on-chain fee measurement. The public page was
// tracking a fraction of what it claimed to.
//
// So each cycle now runs the whole pipeline, one step at a time, in the only
// order that keeps its figures consistent with each other:
//
//   1. ledger   poll every enumerated account for new activity (burns, flows)
//   2. sweeps   decode any new fee sweeps into the treasury
//   3. fees     read what is still held unswept — daily, and only after 1 and 2,
//               because reading balances before the sweeps are up to date
//               counts a fee held-then-swept twice
//   4. refresh  verify the registry, read the chain, rebuild the page
//
// Step 4 ALWAYS runs. A failure in 1–3 is recorded and the page is still
// rebuilt from what is known, rather than freezing on the last good cycle.
// Steps run serially: they share a disk, a lock and an RPC budget.
//
// What the cycle did, when, and whether each step succeeded is written to
// data/cycle.json and served at /cycle.json — so "is it tracking?" is a question
// anyone can answer from outside, not a claim to take on trust.
// ---------------------------------------------------------------------------
const CYCLE_MINUTES = Number(process.env.REFRESH_INTERVAL_MINUTES ?? 0);
const FEES_EVERY_MINUTES = Number(process.env.FEES_INTERVAL_MINUTES ?? 1440);
const FIRST_CYCLE_DELAY_MS = Number(process.env.FIRST_CYCLE_DELAY_SECONDS ?? 120) * 1000;

// Each step is bounded. A step that hangs past its budget is killed, recorded
// as a timeout, and the cycle moves on — a stuck RPC call must not stop the
// page being rebuilt for the rest of the day.
const STEPS = {
  ledger: { argv: ["track.mjs", "--resume", "--poll", "--max-tx", "60000", "--max-accounts", "80",
    "--concurrency", "4", "--rate", "8"], timeoutMin: 120 },
  sweeps: { argv: ["sweeps.mjs", "--rate", "8", "--summary", "data/SWEEPS.json"], timeoutMin: 60 },
  fees: { argv: ["fees.mjs", "--rate", "8", "--summary", "data/FEES.json"], timeoutMin: 90 },
  refresh: { argv: ["refresh.mjs"], timeoutMin: 20 },
};

// The step in progress, so a shutdown can stop it rather than orphan it.
let runningChild = null;

function runStep(name) {
  const { argv, timeoutMin } = STEPS[name];
  const started = Date.now();
  console.log(`cycle: ${name} — starting`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { stdio: "inherit" });
    runningChild = child;
    let timedOut = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMin * 60_000);
    // Exactly once, whichever arrives. A child that fails to START emits "error"
    // and may never emit "exit" — and a promise that never settles would leave
    // the cycle marked as running forever, which stops tracking without a word.
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runningChild = null;
      const r = { step: name, ok: code === 0 && !timedOut && !error, exit: code, timedOut,
        seconds: Number(((Date.now() - started) / 1000).toFixed(1)), ...(error ? { error } : {}) };
      const outcome = r.ok ? "ok" : timedOut ? `TIMED OUT after ${timeoutMin}m`
        : error ? `could not start: ${error}` : `FAILED (exit ${code})`;
      console.log(`cycle: ${name} — ${outcome} in ${r.seconds}s`);
      resolve(r);
    };
    child.on("exit", (code) => finish(code));
    child.on("error", (err) => finish(null, safeError(err)));
  });
}

// The headline times from the snapshot the cycle just built, so /cycle.json
// answers "is it tracking?" with the chain's own dates, not only exit codes.
function latestTimes() {
  try {
    const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"));
    return {
      chainObservedAt: snap.chain?.observedAt ?? null,
      ledgerPolledAt: snap.tracking?.ledger?.polledAt ?? null,
      ledgerStale: snap.tracking?.ledger?.stale ?? null,
      burnsSinceActivation: snap.tracking?.ledger?.burnsSinceActivation ?? null,
      lastSweep: snap.tracking?.buyback?.lastSweep ?? null,
      feesHeldReadAt: snap.tracking?.fees?.heldReadAt ?? null,
      assessmentState: snap.assessment?.state ?? null,
      unreviewedAlerts: Array.isArray(snap.alerts) ? snap.alerts.length : null,
    };
  } catch { return null; }
}

function feesDue() {
  try {
    const at = Date.parse(JSON.parse(readFileSync("data/FEES.json", "utf8")).generatedAt);
    return !Number.isFinite(at) || Date.now() - at >= FEES_EVERY_MINUTES * 60_000;
  } catch { return true; } // never measured on this volume
}

let cycleRunning = false;
async function cycle() {
  if (cycleRunning) { console.log("cycle: previous cycle still running, skipping this tick"); return; }
  cycleRunning = true;
  const startedAt = new Date().toISOString();
  const steps = [];
  try {
    // The ledger only runs once it has state to continue from. A fresh volume
    // with no bootstrap would otherwise start a multi-hour crawl inside a cycle.
    if (existsSync("data/track-state.json")) {
      const ledger = await runStep("ledger"); steps.push(ledger);
      if (ledger.ok) {
        const sweeps = await runStep("sweeps"); steps.push(sweeps);
        // Fees read balances LAST, and only when the swept side is current.
        if (sweeps.ok && feesDue()) steps.push(await runStep("fees"));
        else if (sweeps.ok) steps.push({ step: "fees", ok: true, skipped: `not due (every ${FEES_EVERY_MINUTES}m)` });
      }
    } else {
      steps.push({ step: "ledger", ok: false, skipped: "no data/track-state.json on this volume — ledger not bootstrapped" });
    }
    steps.push(await runStep("refresh"));
  } finally {
    const record = {
      _comment: "What the live tracking cycle last did. Written by server.mjs after every cycle.",
      startedAt,
      finishedAt: new Date().toISOString(),
      everyMinutes: CYCLE_MINUTES,
      feesEveryMinutes: FEES_EVERY_MINUTES,
      ok: steps.every((s) => s.ok),
      steps,
      latest: latestTimes(),
      nextCycleAround: new Date(Date.parse(startedAt) + CYCLE_MINUTES * 60_000).toISOString(),
    };
    try { atomicWrite("data/cycle.json", `${JSON.stringify(record, null, 2)}\n`); } catch (e) { console.error(`cycle: could not record status: ${safeError(e)}`); }
    console.log(`cycle: finished — ${record.ok ? "every step ok" : "one or more steps did not succeed; see /cycle.json"}`);
    cycleRunning = false;
  }
}

function scheduleCycle() {
  if (!Number.isFinite(CYCLE_MINUTES) || CYCLE_MINUTES <= 0) {
    console.log("  tracking     disabled (set REFRESH_INTERVAL_MINUTES to enable)");
    return;
  }
  if (!process.env.SOLANA_RPC_URL) {
    console.log("  tracking     REFRESH_INTERVAL_MINUTES is set but SOLANA_RPC_URL is not — not scheduling");
    return;
  }
  console.log(`  tracking     full cycle every ${CYCLE_MINUTES}m (ledger, sweeps, fees every ${FEES_EVERY_MINUTES}m, refresh), first in ${FIRST_CYCLE_DELAY_MS / 1000}s`);
  // Shortly after boot, not at it: the build already produced a page, and the
  // server should be answering before it starts reading chain. But soon enough
  // that a deploy shows current tracking within minutes, not six hours.
  firstCycleTimer = setTimeout(cycle, FIRST_CYCLE_DELAY_MS);
  refreshTimer = setInterval(cycle, CYCLE_MINUTES * 60_000);
}
let refreshTimer, firstCycleTimer;

server.listen(PORT, HOST, () => {
  console.log(`serving on http://${HOST}:${PORT}`);
  for (const [path, r] of Object.entries(ROUTES)) console.log(`  ${path.padEnd(16)} ${r.file}`);
  console.log(`  ${"/healthz".padEnd(16)} liveness`);
  seedDataVolume();
  const entry = load(ROUTES["/"]);
  console.log(entry ? `  page is built (${entry.body.length} bytes)` : "  WARNING: nothing built yet");
  scheduleCycle();
});

// Railway sends SIGTERM on redeploy. Finish in-flight requests rather than
// cutting them off mid-response.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`${sig} — closing`);
    if (refreshTimer) clearInterval(refreshTimer);
    if (firstCycleTimer) clearTimeout(firstCycleTimer);
    // Every step writes atomically, so stopping one mid-run loses only its
    // progress since the last checkpoint — never a half-written file.
    if (runningChild) runningChild.kill("SIGTERM");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
