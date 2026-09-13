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
import { readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { arg, integer, safeError } from "./core.mjs";

const PORT = integer(process.env.PORT ?? arg("--port", "8080"), "PORT", 1, 65535);
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

const sha = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

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

server.listen(PORT, HOST, () => {
  console.log(`serving on http://${HOST}:${PORT}`);
  for (const [path, r] of Object.entries(ROUTES)) console.log(`  ${path.padEnd(16)} ${r.file}`);
  console.log(`  ${"/healthz".padEnd(16)} liveness`);
  const entry = load(ROUTES["/"]);
  console.log(entry ? `  page is built (${entry.body.length} bytes)` : "  WARNING: nothing built yet");
});

// Railway sends SIGTERM on redeploy. Finish in-flight requests rather than
// cutting them off mid-response.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`${sig} — closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
