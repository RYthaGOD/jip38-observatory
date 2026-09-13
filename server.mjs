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
import { readFileSync, statSync, existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { arg, integer, safeError } from "./core.mjs";

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
        "Not found.\n\nThis server publishes one page and its evidence:\n  /               the dashboard\n  /snapshot.json  the snapshot it was built from\n  /release.json   what was last verified as published\n");
    }

    const entry = load(route);
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

    // Present on both sides. Append-only evidence is left exactly alone.
    if (name !== "snapshot.json") continue;

    if (generatedAt(from) > generatedAt(to)) {
      copyFileSync(from, to);
      console.log(`  refreshed    data/${name} — this build carries a newer snapshot than the volume held`);
      acted++;
    }
  }
  if (!acted) console.log("  volume       up to date; nothing seeded");
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
const REFRESH_MINUTES = Number(process.env.REFRESH_INTERVAL_MINUTES ?? 0);

function scheduleRefresh() {
  if (!Number.isFinite(REFRESH_MINUTES) || REFRESH_MINUTES <= 0) {
    console.log("  refresh      disabled (set REFRESH_INTERVAL_MINUTES to enable)");
    return;
  }
  if (!process.env.SOLANA_RPC_URL) {
    console.log("  refresh      REFRESH_INTERVAL_MINUTES is set but SOLANA_RPC_URL is not — not scheduling");
    return;
  }
  console.log(`  refresh      every ${REFRESH_MINUTES} minute(s), in this process`);

  let running = false;
  const run = () => {
    // A refresh that overruns its interval must not start a second one beside
    // itself. snapshot.mjs also takes a lock, so this is belt and braces.
    if (running) { console.log("refresh: previous run still going, skipping this tick"); return; }
    running = true;
    const started = Date.now();
    const child = spawn(process.execPath, ["refresh.mjs", "--skip-verify"], { stdio: "inherit" });
    child.on("exit", (code) => {
      running = false;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      // A failed refresh leaves the previously built page untouched and the
      // server keeps serving it. Stale and honest beats broken.
      console.log(code === 0
        ? `refresh: done in ${secs}s; the page is live on the next request`
        : `refresh: FAILED (exit ${code}) after ${secs}s — still serving the previous page`);
    });
  };

  // Not at boot: the build step already produced a page from the committed
  // snapshot, so a deploy comes up serving rather than reading chain.
  refreshTimer = setInterval(run, REFRESH_MINUTES * 60_000);
}
let refreshTimer;

server.listen(PORT, HOST, () => {
  console.log(`serving on http://${HOST}:${PORT}`);
  for (const [path, r] of Object.entries(ROUTES)) console.log(`  ${path.padEnd(16)} ${r.file}`);
  console.log(`  ${"/healthz".padEnd(16)} liveness`);
  seedDataVolume();
  const entry = load(ROUTES["/"]);
  console.log(entry ? `  page is built (${entry.body.length} bytes)` : "  WARNING: nothing built yet");
  scheduleRefresh();
});

// Railway sends SIGTERM on redeploy. Finish in-flight requests rather than
// cutting them off mid-response.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`${sig} — closing`);
    if (refreshTimer) clearInterval(refreshTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
