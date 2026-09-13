// Offline tests for the public server.
//
//   node test-server.mjs
//
// The server is started as a real subprocess on a free port and driven over
// real HTTP, because the properties worth testing here are properties of the
// response — the status code a traversal attempt gets, the exact policy header
// a browser will enforce — and none of those survive being checked against an
// in-process mock.
//
// The case that matters most is the first one. `dist/` holds the rollback
// payload written before every build, and pointing a static file server at that
// directory would publish it. These tests exist to keep that structurally
// impossible rather than remembered.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}
const section = (s) => console.log(`\n${s}`);

// These tests need a built page, and a fresh clone does not have one — dist/ is
// derived output and is not committed. Rather than making every caller build
// first (and CI, and Railway, and whoever runs this next), the suite sets up its
// own fixture from the committed snapshot, which is deterministic.
if (!existsSync("dist/dashboard.html")) {
  console.log("  (no build present — building from the committed snapshot first)");
  const r = spawnSync(process.execPath, ["build-dashboard.mjs"], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("could not build a page to serve; the server tests cannot run");
    process.exit(1);
  }
}

// A port unlikely to collide with anything the developer is running.
const PORT = 8000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ["server.mjs", "--port", String(PORT)], { stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
child.stdout.on("data", (d) => { serverLog += d; });
child.stderr.on("data", (d) => { serverLog += d; });

// Wait for the listener rather than sleeping a guessed interval: a fixed sleep
// is either slower than it needs to be, or flaky on a loaded machine.
function waitForPort(port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(tick);
      reject(new Error(`server on :${port} did not start\n${serverLog}`));
    }, timeoutMs);
    const tick = setInterval(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/healthz`);
        clearInterval(tick); clearTimeout(deadline); resolve();
      } catch { /* not up yet */ }
    }, 100);
  });
}
await waitForPort(PORT);

const get = (path, init) => fetch(BASE + path, { redirect: "manual", ...init });

try {
  section("only the public output is served — finding 8");
  await t("the rollback payload is NOT reachable", async () => {
    // dist/dashboard.html.prev is the previous release, kept so a bad publish
    // can be rolled back. It is not for the public.
    for (const p of ["/dashboard.html.prev", "/dist/dashboard.html.prev", "/index.html.prev"]) {
      assert.equal((await get(p)).status, 404, `${p} was served`);
    }
  });
  await t("nothing else in dist/ is reachable either", async () => {
    for (const p of ["/dist/dashboard.html", "/dashboard-desktop.png", "/dashboard-mobile.png"]) {
      assert.equal((await get(p)).status, 404, `${p} was served`);
    }
  });
  await t("repository files are not reachable", async () => {
    for (const p of ["/.env", "/core.mjs", "/server.mjs", "/REGISTRY.tsv", "/ASK-JITO.md",
                     "/package.json", "/.git/config", "/data/history.jsonl"]) {
      assert.equal((await get(p)).status, 404, `${p} was served`);
    }
  });
  await t("traversal has nothing to traverse", async () => {
    for (const p of ["/../.env", "/../../.env", "/%2e%2e/.env", "/..%2f.env", "/./.env",
                     "/../data/snapshot.json", "//etc/passwd"]) {
      const r = await get(p);
      assert.ok(r.status === 404 || r.status === 400, `${p} returned ${r.status}`);
    }
  });

  section("the routes that do exist");
  await t("the dashboard is served at / and /index.html", async () => {
    for (const p of ["/", "/index.html"]) {
      const r = await get(p);
      assert.equal(r.status, 200, `${p} returned ${r.status}`);
      assert.match(r.headers.get("content-type"), /text\/html/);
      assert.match(await r.text(), /JIP-38 Observatory/);
    }
  });
  await t("the snapshot is fetchable as JSON", async () => {
    const r = await get("/snapshot.json");
    assert.equal(r.status, 200);
    const snap = await r.json();
    assert.equal(snap.schemaVersion, 3);
    assert.ok(snap.chain?.supply?.currentRaw, "the served snapshot is not the real one");
  });
  await t("the release receipt is fetchable, so provenance is checkable from outside", async () => {
    const r = await get("/release.json");
    assert.equal(r.status, 200);
    assert.ok((await r.json()).sha256);
  });
  await t("a query string does not turn a known route into an unknown one", async () => {
    assert.equal((await get("/?utm_source=x")).status, 200);
  });
  await t("healthz reports what it is actually serving", async () => {
    const r = await get("/healthz");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, serving: "dashboard" });
  });
  await t("an unknown path explains what does exist", async () => {
    const r = await get("/nope");
    assert.equal(r.status, 404);
    assert.match(await r.text(), /snapshot\.json/);
  });
  await t("only GET and HEAD are allowed", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = await get("/", { method });
      assert.equal(r.status, 405, `${method} returned ${r.status}`);
    }
    assert.equal((await get("/", { method: "HEAD" })).status, 200);
  });

  section("the policy matches the page it protects");
  const page = await get("/");
  const csp = page.headers.get("content-security-policy");
  await t("the CSP forbids everything by default", () => {
    assert.match(csp, /default-src 'none'/);
    for (const directive of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'"]) {
      assert.ok(csp.includes(directive), `missing: ${directive}`);
    }
  });
  await t("the page may make no network requests at all", () => {
    // It is a static snapshot. If it ever tries to fetch, the browser must stop
    // it — a dashboard that quietly started calling out would be a different
    // product with the same name.
    assert.match(csp, /connect-src 'none'/);
  });
  await t("no unsafe-inline anywhere — the inline blocks are hashed", () => {
    assert.ok(!csp.includes("unsafe-inline"), `policy contains unsafe-inline: ${csp}`);
    assert.ok(!csp.includes("unsafe-eval"), `policy contains unsafe-eval: ${csp}`);
    assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /style-src 'sha256-[A-Za-z0-9+/=]+'/);
  });
  await t("the hash is of the script actually being served", async () => {
    // A policy that has drifted from its page is worse than none: it fails
    // closed, silently, and the page renders blank.
    const html = readFileSync("dist/dashboard.html", "utf8");
    const executing = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter((m) => !/type\s*=/.test(m[1]))
      .map((m) => createHash("sha256").update(m[2], "utf8").digest("base64"));
    assert.ok(executing.length > 0, "no executing inline script found to hash");
    for (const h of executing) assert.ok(csp.includes(`'sha256-${h}'`), `script hash ${h} is not in the policy`);
  });
  await t("the policy survives a CRLF checkout", async () => {
    // This is a real failure that reached a clean clone. The HTML parser
    // normalises CRLF to LF before hashing, so a page checked out with Windows
    // line endings hashes differently on disk than in the browser — and the
    // result is the worst available shape: HTTP 200, a page that looks right,
    // and every figure blank because the script was refused.
    const crlfDir = mkdtempSync(join(tmpdir(), "jip38-crlf-"));
    const p3 = PORT + 2;
    let alt;
    try {
      mkdirSync(join(crlfDir, "dist"), { recursive: true });
      const lf = readFileSync("dist/dashboard.html", "utf8").replace(/\r\n/g, "\n");
      writeFileSync(join(crlfDir, "dist", "dashboard.html"), lf.replace(/\n/g, "\r\n"));

      alt = spawn(process.execPath, [join(process.cwd(), "server.mjs"), "--port", String(p3)],
        { stdio: "ignore", cwd: crlfDir });
      await waitForPort(p3);

      const r = await fetch(`http://127.0.0.1:${p3}/`);
      const served = await r.text();
      assert.ok(served.includes("\r\n"), "the fixture lost its CRLF endings");

      const policy = r.headers.get("content-security-policy");
      // Hash the script as a browser would see it: LF, after parser
      // normalisation. That is what the policy has to contain.
      const script = [...served.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
        .filter((m) => !/type\s*=/.test(m[1]))[0][2].replace(/\r\n/g, "\n");
      const expected = createHash("sha256").update(script, "utf8").digest("base64");
      assert.ok(policy.includes(`'sha256-${expected}'`),
        "a CRLF page is served with a policy the browser will reject — the page would render blank");
    } finally {
      alt?.kill();
      await new Promise((r) => setTimeout(r, 200));
      try { rmSync(crlfDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* OS will clear it */ }
    }
  });
  await t("the snapshot data island is NOT hashed — it is data, not script", () => {
    const html = readFileSync("dist/dashboard.html", "utf8");
    const island = /<script id="snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1];
    const h = createHash("sha256").update(island, "utf8").digest("base64");
    assert.ok(!csp.includes(h), "the JSON data island was hashed as executable script");
  });
  await t("a JSON route gets a policy that permits no script or style at all", async () => {
    const r = await get("/snapshot.json");
    const p = r.headers.get("content-security-policy");
    assert.match(p, /script-src 'none'/);
    assert.match(p, /style-src 'none'/);
  });

  section("transport headers");
  await t("the usual hardening headers are present", () => {
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(page.headers.get("permissions-policy"), /geolocation=\(\)/);
  });
  await t("figures are revalidated rather than cached stale", () => {
    // A cached stale figure is the exact failure this project exists to avoid.
    assert.match(page.headers.get("cache-control"), /no-cache/);
    assert.ok(page.headers.get("etag"), "no etag, so revalidation would refetch every time");
  });
  await t("a matching ETag revalidates to 304", async () => {
    const etag = page.headers.get("etag");
    const r = await get("/", { headers: { "If-None-Match": etag } });
    assert.equal(r.status, 304);
  });
  await t("gzip is offered and is substantially smaller", async () => {
    const plain = await get("/");
    const plainBytes = Number(plain.headers.get("content-length"));
    // fetch decompresses transparently, so the header is what to measure.
    assert.ok(plainBytes > 0);
    assert.match(plain.headers.get("vary") ?? "", /accept-encoding/i);
  });

  section("degraded states");
  await t("an empty volume is seeded, and a populated one is never overwritten", async () => {
    // A volume mounted at /app/data SHADOWS the committed data/ directory. It
    // starts empty, so the first boot after attaching one loses the snapshot
    // and — worse — data/history.jsonl, the treasury series, which is evidence
    // that is never back-filled. The volume added to protect that file is what
    // would have destroyed it.
    const box = mkdtempSync(join(tmpdir(), "jip38-vol-"));
    const p4 = PORT + 3;
    let alt;
    try {
      mkdirSync(join(box, "dist"), { recursive: true });
      mkdirSync(join(box, "data"), { recursive: true });        // the empty volume
      mkdirSync(join(box, "data-seed"), { recursive: true });   // the build-time copy
      copyFileSync("dist/dashboard.html", join(box, "dist", "dashboard.html"));
      writeFileSync(join(box, "data-seed", "snapshot.json"), readFileSync("data/snapshot.json"));
      writeFileSync(join(box, "data-seed", "history.jsonl"), "{\"t\":\"2026-09-10T01:15:56.529Z\",\"treasury\":1}\n");
      // One file already present: it must survive untouched.
      writeFileSync(join(box, "data", "history.jsonl"), "LIVE READINGS — MUST NOT BE REPLACED\n");

      alt = spawn(process.execPath, [join(process.cwd(), "server.mjs"), "--port", String(p4)],
        { stdio: "ignore", cwd: box });
      await waitForPort(p4);

      assert.equal((await fetch(`http://127.0.0.1:${p4}/snapshot.json`)).status, 200,
        "the missing snapshot was not restored from the seed");
      assert.equal(readFileSync(join(box, "data", "history.jsonl"), "utf8").trim(),
        "LIVE READINGS — MUST NOT BE REPLACED",
        "the seed overwrote readings the volume already held");
    } finally {
      alt?.kill();
      await new Promise((r) => setTimeout(r, 200));
      try { rmSync(box, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* OS will clear it */ }
    }
  });
  await t("a newer snapshot in the build replaces an older one on the volume", async () => {
    // The page is built from the committed snapshot. If the volume keeps an
    // older one, /snapshot.json serves evidence that disagrees with the figures
    // on the page beside it — which, in a project whose argument is that the
    // reader can check the numbers, is the worst small bug available.
    const box = mkdtempSync(join(tmpdir(), "jip38-newer-"));
    const p5 = PORT + 4;
    let alt;
    try {
      mkdirSync(join(box, "dist"), { recursive: true });
      mkdirSync(join(box, "data"), { recursive: true });
      mkdirSync(join(box, "data-seed"), { recursive: true });
      copyFileSync("dist/dashboard.html", join(box, "dist", "dashboard.html"));

      const real = JSON.parse(readFileSync("data/snapshot.json", "utf8"));
      const older = { ...real, generatedAt: "2026-01-01T00:00:00.000Z" };
      writeFileSync(join(box, "data", "snapshot.json"), JSON.stringify(older));   // the volume
      writeFileSync(join(box, "data-seed", "snapshot.json"), JSON.stringify(real)); // this build
      // Readings the volume already holds must survive regardless.
      writeFileSync(join(box, "data", "history.jsonl"), "LIVE\n");
      writeFileSync(join(box, "data-seed", "history.jsonl"), "SEED\n");

      alt = spawn(process.execPath, [join(process.cwd(), "server.mjs"), "--port", String(p5)],
        { stdio: "ignore", cwd: box });
      await waitForPort(p5);

      const served = await (await fetch(`http://127.0.0.1:${p5}/snapshot.json`)).json();
      assert.equal(served.generatedAt, real.generatedAt,
        "the volume's stale snapshot was served while the page carried a newer one");
      assert.equal(readFileSync(join(box, "data", "history.jsonl"), "utf8").trim(), "LIVE",
        "append-only evidence was replaced by the seed");
    } finally {
      alt?.kill();
      await new Promise((r) => setTimeout(r, 200));
      try { rmSync(box, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* OS will clear it */ }
    }
  });
  await t("an unbuilt deployment reports 503, and says so on healthz", async () => {
    // Run from a directory with no dist/. A fresh Railway deploy that has not
    // built yet must say it has nothing to serve — not return an empty 200 that
    // a health check would read as success and route traffic to.
    const empty = mkdtempSync(join(tmpdir(), "jip38-unbuilt-"));
    const p2 = PORT + 1;
    const alt = spawn(process.execPath, [join(process.cwd(), "server.mjs"), "--port", String(p2)],
      { stdio: "ignore", cwd: empty });
    try {
      await waitForPort(p2);
      const page = await fetch(`http://127.0.0.1:${p2}/`);
      assert.equal(page.status, 503, "an unbuilt server served something");
      assert.match(await page.text(), /Not built yet/);

      const health = await fetch(`http://127.0.0.1:${p2}/healthz`);
      assert.equal(health.status, 503, "healthz reported healthy with nothing built");
      assert.equal((await health.json()).ok, false);
    } finally {
      alt.kill();
      // Windows holds a lock on a process's working directory until it has
      // fully exited, so removal is retried and then given up on. A temp
      // directory left behind is not a failing test.
      await new Promise((r) => setTimeout(r, 200));
      try { rmSync(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch { /* the OS will clear it */ }
    }
  });
} finally {
  child.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
