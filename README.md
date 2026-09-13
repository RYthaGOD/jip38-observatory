# JIP-38 Observatory

*Working name.* An independent record of whether Jito does what JIP-38 says it
will do.

Sibling to [BAMservatory](https://rythagod.github.io/bamservatory/), and built on
the same method: derive every figure from public data, archive the evidence,
publish a script that rebuilds each figure from that evidence, and state plainly
what the result does not establish.

---

## The claim being verified

JIP-38 was activated **2026-07-13**; JTX launched **2026-07-14**. What it commits:

| Term | Commitment |
|---|---|
| JTX platform fees | 80% to the DAO, 20% reinvested in JTX development |
| DAO's JTX revenue share | **100%** to open-market JTO buybacks and permanent burns |
| Duration | At least one year, through **Q4 2027** |
| Mechanism | The **Rev Splitter** — collects JTX platform fees, executes JTO buybacks |
| Oversight | Jito Dev Council, under delegated authority from JIP-35 / JIP-36 |
| Reporting | **Per-epoch dashboards** of fees collected, JTO acquired and burned, "with on-chain references" |

Other revenue streams — JitoSOL, BAM, Block Engine — flow to the DAO but are
**not** committed to buybacks in this period. Anything this project publishes is
scoped to the JTX stream only.

Roughly: 80 cents of every dollar of JTX platform fees should end up buying and
burning JTO.

## Why this project exists

Jito's public position is that the Rev Splitter's on-chain nature means anyone
can verify the buybacks in real time. That is a stronger claim than BAM's, and
unlike BAM's it appears to be **true** — a buyback and a burn are settled on
chain, so this can be verified outright rather than merely corroborated.

Nobody is doing the verifying.

That gap is the whole product. The single number this exists to publish is the
**execution ratio**: value burned against JTX fee revenue, measured against the
promised 80%. Everything else is supporting evidence.

## Two sources, playing different roles

Jito publishes JTX figures on its own
[Dune dashboard](https://dune.com/jito/jtx-metrics-ee62) — volume, platform fees,
fills, active wallets. This project derives its figures from chain.

The operator's numbers are the **claim**, not the evidence. Using them as a data
source would rebuild the very dependency this exists to remove, and would leave
the recompute step with nothing to recompute from: "Dune said so" is not
evidence. They are captured and archived on a schedule instead — because a Dune
query is mutable, can be edited retroactively and can be deleted, while chain
data cannot. What was claimed on a given date should not be revisable without
record.

Which inverts the obvious design. The thing worth polling is not the chain, which
is its own archive. It is the claim.

## The immediate obstacle, stated up front

**JIP-38 names no program IDs, no wallet addresses and no contract identifiers.**
The reporting commitment says "with on-chain references"; the proposal itself
supplies none.

So this cannot begin by indexing known accounts. It has to begin by *identifying*
them from chain activity — and that identification is an **inference**, not a
documented fact. It is treated here exactly as BAMservatory treats region
inference: the addresses are published in [`REGISTRY.tsv`](REGISTRY.tsv) with the
evidence for each, the inference is labelled as such, and a change in the
observed pattern raises an alarm rather than silently moving a number.

If the identification is wrong, every figure downstream is wrong. That is why it
is the first artifact rather than an implementation detail.

## Discovery strategy: start at the burn, not the fee

Burns are the most identifiable event in the chain — an SPL burn instruction
against the JTO mint reduces supply verifiably. Fees are the least identifiable,
because platform fees can accrue across many accounts and routes.

So the search runs backwards:

1. Find JTO supply reductions and the burn instructions that caused them.
2. Identify the authority that signed each burn.
3. Trace that authority's inbound JTO — which venue, which swap, funded by what.
4. Trace those funds back toward JTX fee collection.

Each step either holds or it does not, and where the chain goes cold, that is
reported as a limit rather than bridged with an assumption.

## What this will not establish

Written before any findings exist, so that it cannot be tuned to them.

- **That the 20% development share is spent as described.** Out of scope and
  probably unverifiable from outside.
- **That fees observed on chain are all the fees.** If revenue is recognised off
  chain or routed before it lands somewhere observable, this measures what
  reached the chain, not what was earned.
- **That an open-market buy did not move the price it paid.** Execution quality
  is a separate question from execution occurring.
- **Attribution, if buybacks route through market makers or aggregators.** Should
  the trail break there, the honest product narrows to "fees in, JTO burned, the
  middle is not attributable" — still worth publishing, but a smaller claim.

## Status

**First finding, 2026-09-10: no JTO has been burned under JIP-38 — and as of
2026-09-13 that is enumerated rather than inferred.** The DAO treasury JTO
account has had all 16,821 of its transactions resolved and contains no burn
instruction; see [`FINDINGS.md`](FINDINGS.md) section 9.

The Jito team supplied the mechanism on request — JTX swap fees are collected by
the program `JTXJTXfr1wVRMEzqiPhXUr69zJtfGuLh5qEiXG772Zj`, swept periodically
into JTO, split 80/20, with 80% going to the DAO treasury
`5eosrve6LktMZgVNszYzebgmmC7BjLK8NoWyRQtcmGTF` — and stated that there have been
no burns so far. Both addresses verify on chain, and the treasury's JTO account
turns out to be the one this project had **already identified independently** as
the largest JTO holder, before any address was supplied.

What corroborates that absence, and what does not, has to be stated carefully —
because the two are easy to conflate and this project got it wrong once already.

**The supply invariant corroborates it.** Total JTO destroyed since genesis is
~13.48M, which is roughly 55x more than the reported fee revenue could have
bought. So the destruction on record predates activation, and is not JIP-38
execution. That argument rests only on arithmetic over two chain reads.

**The burn-filtered index does not corroborate it.** A sweep of that index
returned a largest-ever burn of 0.96 JTO across JTO's entire history, all
rent-reclaim dust — against 13.48M provably destroyed. That is not evidence of
absence; it is evidence that the index misses essentially everything. It was
described here as independent corroboration, and that was wrong: an unsound
search finding nothing is not a finding. See [`FINDINGS.md`](FINDINGS.md) 2a.

So against $198,908.37 of claimed JTX platform fees, of which 80% — about
$159,127 — is committed to buying and burning JTO, the **execution ratio is 0%**.

That is **not** evidence of a breach: JIP-38 runs through Q4 2027 and a
programme that batches its burns has broken no promise two months in. What can be
said is narrower and still worth publishing — there is, as yet, nothing to track
on the burn side, against a public framing that holders can follow "fee
collection, purchases, and burns in real time".

[`FINDINGS.md`](FINDINGS.md) has the full record, including what remains
unverified: the sweep path, the 80/20 split, and the fee total are all still
operator claims.

What is settled: the JTO mint is **confirmed** on chain by its derived Metaplex
metadata; its `mintAuthority` is `null`; and its genesis supply of exactly
1,000,000,000 JTO is **verified on chain**, not taken from documentation — a
single `mintToChecked` on 2023-11-27, located by binary search. Supply can
therefore fall by no mechanism other than a burn, and **13,477,142 JTO** has
been destroyed since the token existed (~$8.7M). That is a *ceiling* on JIP-38
burns rather than a measurement: the split at activation needs historical
supply, which no public RPC serves.

Three premises were falsified by running them, and all three are recorded rather
than quietly fixed. The burn scan could not have covered its own window. "Start
at the burn" does not identify the Rev Splitter. And most seriously, **the
burn-filtered index this project's discovery was built on is unsound**: 13.48M
JTO provably burned, yet sampling the index across JTO's entire history returns
a largest-ever burn of 0.96 JTO. It surfaces rent-reclaim dust and misses
essentially all of the volume. That was caught by the supply checksum — an
invariant that holds no matter what any index says — which is the one part of
the design that worked exactly as intended.

The claim side is blocked: Jito's Dune dashboard is client-rendered, so the
public URL yields none of its figures, and archiving it needs a Dune API key.
That gap is dated in [`CLAIMS.tsv`](CLAIMS.tsv).

## What is tracked, and what is deliberately not

The goal is a complete record of what happens to JTO — supply changes, treasury
and vesting movements, authority changes, governance, and the flows between them
— with **one deliberate exclusion: retail DEX trading.**

That exclusion is not a gap. It is what makes the rest affordable, and the
reasoning is worth stating because it inverts the obvious design:

Enumerating every transaction that touches the mint was built
([`rawscan.mjs`](rawscan.mjs)) and measured. The JIP-38 window alone holds an
estimated **2.04M transactions**, and against a free RPC key — 77% of requests
throttled — that is roughly **150 hours**. Sound, and unaffordable.

The reason it costs so much is that JTO's mint history is overwhelmingly Jupiter
routes and AMM swaps. That traffic is the one thing this project does not need
to reconstruct: it is already served, in aggregate, by any on-chain DEX source.

Drop it and the problem changes shape entirely. What remains lives in a few
hundred accounts with hundreds of transactions each, which **can** be enumerated
exhaustively — and exhaustiveness is the property everything here depends on.

So [`track.mjs`](track.mjs) crawls accounts rather than the mint. It seeds from
[`REGISTRY.tsv`](REGISTRY.tsv), resolves every transaction of each account in
full, classifies each instruction into an event, and lets any counterparty
receiving a material amount of JTO pull itself into scope. The crawl expands
itself; reaching a DEX venue ends that branch, though the movement is still
recorded, so "this treasury sold into Jupiter" stays visible.

### How it knows when it is complete

Exactly 1,000,000,000 JTO was minted and minting was closed on 2023-12-04, both
verified on chain. So every JTO missing from supply was burned, and:

```
burns in the ledger  ==  1,000,000,000 - current supply
```

Every run prints the residual. It is the amount of JTO that has left supply
without appearing in the ledger — the crawl's own error bar, stated in the unit
that matters, and requiring nobody to take the tooling's word for anything. When
it reaches zero, the record of supply-affecting events is provably complete.

## Running it

Needs Node 22+ (for `process.loadEnvFile`; tested on 24.13) and, for anything that
reads the chain, a Solana RPC endpoint in `.env`:

```
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
```

`.env` is gitignored and must stay that way. Burn discovery needs a Helius key
specifically, because it walks a burn-filtered index; everything else works
against any RPC.

```
node check.mjs       # THE GATE — every offline suite, no key needed
node verify.mjs      # re-test every REGISTRY.tsv role against chain; exit 1 on any failure
node track.mjs       # THE MAIN TOOL — crawl accounts, build EVENTS.tsv, reconcile against supply
node capture.mjs     # archive the operator's claim alongside the chain state it describes
node discover.mjs    # identify the mint, measure the window, sample and classify burns
node rawscan.mjs     # exhaustive raw enumeration — sound, but needs a paid RPC tier
node release.mjs status  # is what is published the same as what was built?
node ledger.mjs      # burn enumeration via a burn-filtered index — KNOWN UNSOUND, see FINDINGS.md 2a
```

Run `verify.mjs` before trusting anything else. It exits non-zero both when an
address stops behaving as `REGISTRY.tsv` records, and when an entry a figure
depends on has no test at all — an unchecked dependency is a hole in the
verification, not a detail.

### Rebuilding the published page

A clean checkout can rebuild the exact published page without a key, because the
snapshot it was built from is committed:

```
git clone <this repo> && cd jip38-observatory
node check.mjs                 # every offline suite; needs Node 22+
node build-dashboard.mjs       # data/snapshot.json -> dist/dashboard.html
node release.mjs status        # is the built page the one that is published?
```

`build-dashboard.mjs` validates the whole snapshot before it writes anything. A
malformed one fails the build and leaves the previous release standing, rather
than producing a page that throws halfway through rendering in the browser.

To take a fresh reading instead, `node snapshot.mjs` — that needs the RPC key.

### The three inputs that are not code

Three files are deliberately data rather than logic, because each records a
judgement a script must not make for itself:

| File | What it records | Who may change it |
|---|---|---|
| [`REGISTRY.tsv`](REGISTRY.tsv) | the addresses, and the evidence for each | a person, with evidence |
| [`CLAIM.json`](CLAIM.json) | the operator's figures, explicitly approved from an archived capture | a person, against the hash |
| [`ASSESSMENT.json`](ASSESSMENT.json) | the burn finding, and the chain state it was made against | a person, after re-doing the attribution |

A refresh reads the chain and can say what supply and the treasury are right
now. It cannot say whether a burn was a JIP-38 burn — that needs attribution,
and attribution needs a person. So a refresh never advances `ASSESSMENT.json`.
It compares the chain against that file's anchor and, if supply or the treasury
has moved materially or the assessment has expired, the page publishes **review
required** instead of restamping a stale zero with today's date.

That guard exists because the opposite behaviour was shipped: the execution
ratio was a literal `0` in the snapshot script, so every refresh republished a
dated zero-burn finding it had not made. A real programme burn could have
happened and the page would have carried a freshly timestamped 0% straight
through it.

### Publishing

`dist/dashboard.html` is a self-contained static file — no external scripts,
styles or fonts — so it can be hosted anywhere. It is currently published as a
Claude Artifact.

**A build is not a deployment.** `release.mjs` tracks them separately:
[`RELEASE.json`](RELEASE.json) records what was last *verified* to be served,
written only after the published page was read back and its snapshot identity
confirmed. `node release.mjs status` exits non-zero when the built page is not
the published one.

That exists because on 13 September 2026 the scheduled refresh invoked its
publisher, the publisher correctly reported that it had no Artifact tool and
could not publish, and then exited 0 — so the wrapper logged "done" and the
scheduled task recorded success while the public page stayed three days stale.
An exit code from a publisher is not evidence of publication.

### Hosting it yourself

```
npm start           # serves on :8080, or $PORT
node refresh.mjs    # check, verify, read chain, rebuild — cross-platform
```

[`server.mjs`](server.mjs) has no dependencies and serves an **allowlist**, not
a directory. Four URLs exist:

| | |
|---|---|
| `/` | the dashboard |
| `/snapshot.json` | the snapshot it was built from — the evidence, fetchable directly |
| `/release.json` | what was last verified as published |
| `/healthz` | whether there is actually a page to serve |

Anything else is a 404 before any disk access happens. That is deliberate:
`dist/` also holds `dashboard.html.prev`, the rollback payload written before
every build, and pointing a static file server at that directory would publish
it. With no filesystem routing there is no path to traverse.

The page is served under a content policy that denies everything by default and
then names only what the page needs — including `connect-src 'none'`, because a
static snapshot must never make a network request. Its inline script and style
are allowed by **sha256 hash**, computed from the bytes being served at the
moment they are served, so there is no `unsafe-inline` and no policy that can
drift from the page it protects. [`test-server.mjs`](test-server.mjs) checks all
of it, including that the hash in the header matches the script on the page.

### On Railway

Live at **https://web-production-372cc.up.railway.app**.
[`deploy-railway.sh`](deploy-railway.sh) provisions the whole thing, and runs
the offline gate first so nothing is provisioned from a tree whose tests fail:

```
railway login          # the CLI refuses to authenticate non-interactively
bash deploy-railway.sh
```

There is no publish step, which is the point: the page that was built is the
page that is served, off the same disk, and the server re-reads it when its
mtime changes. Nothing has to be pushed anywhere, so nothing can silently fail
to be.

Three things that are only obvious after getting them wrong:

**One service, not two.** The natural split is a web service that serves and a
cron service that reads the chain. It silently does not work. Each Railway
service is its own container with its own disk, so the cron rebuilds
`dist/dashboard.html` inside *itself* while the web service goes on serving a
copy nothing updates — both deployments green, the cron reporting success every
six hours, and the page never changing. A volume cannot bridge it: a volume
instance binds to exactly one service. So the refresh runs inside the serving
process on a timer. It is off unless `REFRESH_INTERVAL_MINUTES` is set, so a
local `npm start` serves what is already built and never touches the chain.

**The volume needs seeding.** Mounting at `/app/data` *shadows* the committed
`data/` directory, and the volume starts empty — so the first boot after
attaching one loses `data/history.jsonl`, the treasury series, which is evidence
that is never back-filled. The volume added to protect it is what destroys it.
[`prepare-seed.mjs`](prepare-seed.mjs) copies those files aside during the build
phase, the only moment they are reachable; the server restores anything missing
at boot, and never touches a file the volume already holds.

**Set `PORT` explicitly.** Railway's edge returns "Application not found" if it
cannot work out the target port, while the container sits there serving happily
— which reads as a broken deploy rather than a routing gap.

## Licence

MIT.
