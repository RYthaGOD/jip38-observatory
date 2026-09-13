# Findings

First contact with the chain, **2026-09-09**. Everything below was produced by
the scripts in this repository against a Solana mainnet RPC, and every figure
names the call that produced it.

Read [`README.md`](README.md) for what the project claims and
[`RESUME-HERE.md`](RESUME-HERE.md) for why it is built this way. This file is
the record of what asking the chain actually returned — including the two
places where it contradicted the plan.

---

## 0. The headline, 2026-09-10: no burns have happened

The Jito team supplied the mechanism directly, in response to
[`ASK-JITO.md`](ASK-JITO.md):

> JTX swap fees are collected on chain by the fee program
> `JTXJTXfr1wVRMEzqiPhXUr69zJtfGuLh5qEiXG772Zj`, swept periodically into JTO, and
> split 80/20. 80% goes to the Jito DAO treasury
> `5eosrve6LktMZgVNszYzebgmmC7BjLK8NoWyRQtcmGTF`.
>
> **No burns so far.**

Both addresses were verified on chain the same day. `JTXJTX…` is a real
executable program under BPFLoaderUpgradeable. `5eosrve6…` is a system account
holding 12,119 SOL, and it owns the JTO token account
`2Ch9AWnbAaummLkWTTtNgTAvrFq8YMATUaaN77TB2Y6C`.

**That token account is the one this project had already identified, on
2026-09-09, as the largest JTO holder on chain — before any address had been
supplied.** The operator's answer and the independent chain-derived inference
land on the same account. That convergence is the strongest corroboration
available here, and it is worth more than either finding alone.

### What this establishes

| | |
|---|---|
| JTX platform fees to date (operator's own figure) | **$198,908.37** |
| Committed to JTO buyback and burn (80%) | **$159,126.70** |
| JTO burned under JIP-38 | **zero** |
| **Execution ratio** | **0%**, against a promised 80% |

The independent search corroborates it rather than merely accepting it. Sampling
the burn population across the whole of JTO's history, checking every one of the
twenty largest holders, the genesis account, both historical mint authorities and
the main distribution hubs, this project found **no programme-scale burn
anywhere** — the largest burn seen in any sample was 0.96 JTO, and every one of
those was rent-reclaim dust. Two independent methods agree.

### What it does *not* establish

This matters more than the headline, because the headline is easy to misread.

- **It is not evidence of a breach.** JIP-38 commits to buybacks and burns "for
  at least one year, through Q4 2027". Two months in, a programme that batches
  its burns rather than executing them continuously has broken no promise. Burns
  may be pending, batched, or awaiting a threshold.
- **The buyback and the burn are separate steps, and only the burn is confirmed
  absent.** Jito describes fees as being *swept into JTO* — that is the
  open-market purchase, and it may well be happening. What has not happened is
  the destruction. This project has not yet verified the sweep path on chain, so
  "fees are being converted to JTO" remains an operator claim.
- **The 80/20 split is unverified.** So is the fee total.

What can be said plainly is narrower and still worth publishing: **two months
after activation, with roughly $159,000 of fee revenue committed to buying and
burning JTO, no JTO has been burned.** Against the public framing — that the Rev
Splitter's on-chain nature lets holders track "fee collection, purchases, and
burns in real time", with per-epoch dashboards of JTO "acquired and burned" —
there is nothing to track on the burn side yet.

### The number to watch

The treasury's JTO balance is **rising**:

```
2026-09-09  209,742,484.267
2026-09-09  209,746,141.366
2026-09-10  209,747,525.765
```

Consistent with fees being swept in as JTO and nothing being burned out. If the
mechanism works as described, this balance should keep climbing until the first
burn, and then fall. **That fall is the event this project now exists to
catch** — and, because burns are irreversible and supply is monotonically
non-increasing (§2), it will be unambiguous when it happens.

## 1. The mint is confirmed

`jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL` was held at confidence **strong**
because only its format had been checked, and format is not identity. It is now
**confirmed**, on chain:

- `getAccountInfo` returns an initialised SPL mint, 9 decimals.
- The Metaplex metadata PDA — *derived*, not looked up in any list —
  `C39qDAVQiL5scYez3Udj79GQ4vrY1aFXpLKPTaYWZE9q` (bump 255) carries name
  `JITO`, symbol `JTO`, and URI `https://metadata.jito.network/token/jto`.

That last point is what settles it. The identity is asserted **on chain**, under
a domain Jito controls. A vanity prefix could be produced by anyone; this could
not.

## 2. Supply cannot increase — and this is load-bearing

```
mintAuthority   : null
freezeAuthority : null
```

No JTO can ever be created again. Supply is monotonically non-increasing, so
**every unit of decline is a permanent, irreversible removal.**

Three consequences, and they matter more than they first appear:

1. **JIP-38's "permanent burn" is structurally guaranteed** for any genuine SPL
   burn against this mint. Open question 4 in `RESUME-HERE.md` asked whether a
   "permanent burn" is a real supply reduction or sometimes a transfer to an
   address that merely looks terminal. For real burn instructions the question
   is now closed: it cannot be otherwise. What remains open is whether the
   programme uses burn instructions at all, which is a different question and
   still unanswered.

2. **Cumulative burn is computable without enumerating anything**, as genesis
   supply minus current supply.

3. **That identity is a checksum on any burn ledger.** A complete enumeration of
   burns since genesis must sum to exactly the supply decline. This is what
   [`ledger.mjs`](ledger.mjs) checks itself against, and it is the difference
   between a ledger that asks to be trusted and one that can prove itself.

### Genesis supply, verified on chain

The 1,000,000,000 figure started as an unverified input carried from
documentation. It is now read off the chain. Binary-searching for the mint's
first transaction (paging cannot reach it — JTO ran ~50k transactions a day in
January 2024, so 200 pages covered four days) finds the creation:

```
2023-11-27T20:41:24Z  initializeMint   decimals=9, mintAuthority=Pay5KQqvaPxEey8xdibLiB3WfGfdKo3SfPreuSXeGWm
2023-11-27T20:46:54Z  mintToChecked    1,000,000,000 JTO -> FrXfXNmsw1XCC6AeYEaYd31PjfmjqfLNn42k3CfGjtbA
2023-11-27T21:36:49Z  setAuthority     mintTokens -> AtNgME7ribDTqtZQcCL2xSBFL9NgHQsDFCj1TmxMpPtV
```

The mint transaction is
`2M1gWKQvjCav6JLkf2j5EfUmpp31RRM27YPnG1fGiyvgqu3s4C7Z1tWYXgYKoxwgMC84WG5v7tMHwMMQ74xUekVG`.
Mint authority was later set to `null`, which is where it stands now.

| | JTO |
|---|---|
| Minted at genesis — **verified on chain** | 1,000,000,000 |
| Current supply — from `getTokenSupply` | 986,522,857.157 |
| **Destroyed** | **13,477,142.843** |

At roughly $0.65/JTO, on the order of **$8.7M** of JTO destroyed since the token
existed.

Two qualifications:

- **This is burn since genesis, not since JIP-38.** Splitting it at 2026-07-13
  needs the supply as it stood that day. Solana RPC serves current state only,
  so that split is not yet recoverable, and 13.48M remains a **ceiling** on
  JIP-38 burns rather than a measurement.
- ~~Whether more was minted between creation and the authority being nulled is
  not yet ruled out.~~ **Now ruled out.** The second mint authority
  `AtNgME7ribDTqtZQcCL2xSBFL9NgHQsDFCj1TmxMpPtV` was checked across all 239 of
  its successful transactions (2023-11-27 to 2026-06-14). It contains exactly
  one supply-changing event: `setAuthority mintTokens -> null` at
  **2023-12-04T18:27:47Z**. It never minted. Minting was permanently disabled
  seven days after the token was created.

So the figure carries no assumption at all: **exactly 1,000,000,000 JTO was ever
minted, 986,522,857 remains, and 13,477,143 JTO has been destroyed by burn
instructions.**

## 2a. The burn index is unsound, proven by contradiction

This is the most consequential result of the day, and it invalidates the method
the tooling was built on.

Supply can fall by **no mechanism other than a burn instruction** — that is what
`mintAuthority: null` means. So the 13,477,142 JTO above was destroyed by burn
instructions. Those burns exist, they are on chain, and they are enormous.

Now set that beside what the burn-filtered index actually returns. Sampled at 26
points spanning 2024-01-08 to 2026-08-24, plus every one of the twenty largest
JTO holders, plus the genesis token account and both original mint authorities:

| | |
|---|---|
| Burn transactions found | 281 |
| Their total | **12.94 JTO** |
| Largest single burn | **0.96 JTO** |
| Burns ≥ 100 JTO | **0** |

Every one carried `closeAccount` instructions. All of it is rent-reclaim dust.

**The index returns dust and misses essentially all of the volume** — a gap of
roughly six orders of magnitude. `type=BURN` is therefore not a sound basis for
enumerating JTO burns, and every burn figure this project has produced through
it is a floor of unknown distance from the truth.

Two things are worth saying about how this was caught.

First, it was caught by the supply checksum described in §2 — an invariant that
holds regardless of whether any index is honest. That is the checksum doing
precisely the job it was built for, just far earlier and more brutally than
expected. A project that had trusted the index and published an execution ratio
from it would have published a number near zero and been badly wrong.

Second, it retrospectively explains §3b. The conclusion drawn there — "most JTO
burns are dust" — was measuring the *index*, not the chain. The dust is real,
but it is not representative, and the large burns were invisible the whole time.

**The remedy is raw enumeration**: `getSignaturesForAddress` over the mint plus
`getTransaction` on each result, which cannot miss a burn because it never asks
anything to classify one. [`rawscan.mjs`](rawscan.mjs) implements it.

### 2b. Raw enumeration is sound but not affordable here

It was run, and the throughput measured rather than guessed: **774 of the first
1,011 requests were rate-limited**, giving roughly 220 transactions a minute.
Against an estimated 2.04M transactions in the JIP-38 window that is about
**150 hours**. The method is right; this API key cannot pay for it.

Two fixes came out of the attempt and are worth keeping regardless:

- The anchor binary search could fail to terminate. `hi = r.slot` can *increase*
  the upper bound when a long run of slots is skipped, so the interval stops
  shrinking. Now clamped, and verified in isolation: 18 iterations, 38 calls,
  landing within a minute of the target across four test dates.
- Segment seams could double-count a burn where an anchor lands above where the
  segment above it stopped. Deduped on burn-instruction identity — inflating a
  burn total is as wrong as understating one, merely in the direction that
  flatters this project instead of Jito.

### 2c. Following the money instead

Cheaper than scanning everything: the supply was distributed from a known point,
so the tree can be walked from the root. What it shows so far:

```
FrXfXNms… (genesis)     1,000,000,000  ->  7T6SXnG1… in a single transfer, 2023-11-27
7T6SXnG1… (hub)         owner AtNgME7…, 130 transactions, holds 1,057,671 JTO, NO burns
  ├─ 242,857,143 -> 2Ch9AWnb…   holds 209,742,484  (the largest holder today)
  ├─ 224,999,279 -> 8XEMySUG…   holds 0, 72 transactions, NO burns — redistributed onward
  ├─  99,999,990 -> 8Xm3tkQH…   holds 0
  ├─  36,999,995 -> FwoXdry5…   holds 0
  └─  ~20M x 8   -> vesting-shaped accounts, 2023-12-06
```

No burns anywhere on this path. The tree is broad rather than deep, and walking
all of it is a graph traversal this session did not finish. **The 13.48M JTO is
still unlocated** — but it is now bounded: it left from somewhere in this tree,
between 2023-11-27 and today.

### Supply falls continuously

Across 27 minutes of this session, four readings:

```
03:02Z  986,522,876.558434909
03:16Z  986,522,876.061540777
03:22Z  986,522,870.213524321
03:29Z  986,522,868.826778955
```

About 7.7 JTO in 27 minutes, in many small decrements. That is *not* a buyback
signature — see below.

## 3. Two things the plan got wrong

Both were written down as method before anything had been run. Both were
falsified by the first contact with chain, and both are recorded rather than
quietly fixed.

### 3a. The burn scan could not have worked

`discover.mjs` originally paged `getSignaturesForAddress` over the mint, capped
at 200 pages, and treated the result as the burn population since activation.

The mint carries roughly **1,000 signatures every four minutes** at the chain
head. 200 pages is 200,000 signatures — about **fourteen hours**, against a
window of **58 days**. It would have printed *"none found in window"* having
examined around 1% of it.

That is precisely the failure `RESUME-HERE.md` warned against: *"a silent
truncation here would understate burns, which is the one direction of error that
would flatter Jito."* The plan named the hazard and then contained it.

`discover.mjs` now measures coverage from the cursor's own timestamps and prints
it beside every count. It will not report an absence without reporting how much
of the window it actually looked at.

**A second-order version of the same error**, found while fixing the first: the
initial repair estimated the window at ~14 million signatures by extrapolating
one density reading taken at the chain head. Density is not uniform — the head
runs 20-50× busier than late August — so that estimate was inflated several
fold. Density is now measured at six points across the window and integrated,
and the script prints both figures so the difference is visible.

### 3b. "Start at the burn" does not identify the Rev Splitter

The discovery strategy assumed that whoever signs a JTO burn is downstream of
the Rev Splitter. **Most JTO burns are noise.**

The first burn located on chain
(`2vTgC55rUYHi3asSn5yHF317AfDcxgaB2U8jixLpBAXM28YNJn8QJSJkKK8MTgqw2R8ys3Yp5EMPu9NAWoxmgPpR`,
2026-09-09T02:55:39Z) destroyed **0.632603956 JTO** — alongside two unrelated
mints, inside a transaction carrying **seven `closeAccount` instructions**. That
is a wallet sweeping dust to reclaim rent. Two further burns sampled from August
and September were the same shape, at 0.0006 JTO each.

This explains the continuous supply decline in §2: JTO's supply is falling all
day long, in fractions of a token, because people close token accounts. None of
it is a buyback.

Burn authorities are therefore **classified**, not ranked by volume, and a burn
now has to look like a programme burn before it is worth tracing. The three
sweepers are recorded in [`REGISTRY.tsv`](REGISTRY.tsv) at confidence
`rejected`, which is what that value is for — so a ruled-out address is not
rediscovered and adopted later.

## 3c. The operator's own figures resize the whole problem

Captured 2026-09-09 from `dune.com/jito/jtx-metrics-ee62`:

| | Claimed |
|---|---|
| Trading volume | $124,236,023.65 |
| **JTX platform fees** | **$198,908.37** |
| Fills | 266,827 |
| Data begins | **2026-07-24** |

Run that through JIP-38's own arithmetic. 80% of platform fees go to the DAO, and
100% of the DAO's share is committed to open-market JTO buybacks and burns:

```
$198,908.37 x 80%  =  $159,126.70  of JTO to be bought and burned, to date
```

Which at plausible execution prices is **roughly 200,000-300,000 JTO**.

**That is about 55x smaller than the 13,477,143 JTO this project has spent the
day hunting.** The two numbers are not the same quantity and never were.

The consequence is large and it cuts against the search as conducted: **the
13.48M JTO destroyed almost certainly has nothing to do with JIP-38.** The entire
programme, running since activation, could not have burned more than a few
hundred thousand JTO, because that is all the fee revenue there has been. The
13.48M is far more likely to predate 2026-07-13 — unclaimed airdrop or a similar
one-off — and the crawl has been chasing a quantity JIP-38 could not have
produced.

So the target changes. What this project should be looking for in the JIP-38
window is a burn stream on the order of **hundreds of thousands of JTO, not
millions** — and, from the daily rate below, roughly **1,700 JTO a day**. That is
still four orders of magnitude above the rent-reclaim dust that dominates the
burn population, so it remains easy to distinguish once found.

It also means the execution ratio finally has a denominator. The figure this
project exists to publish is value burned over JTX fee revenue against the
promised 80%, and the revenue side is now a captured, dated claim.

### The dashboard moves, which is the point

`RESUME-HERE.md` recorded these same figures earlier on 2026-09-09, when the
project was scoped:

| | At scoping | 23:40Z | Change |
|---|---|---|---|
| Volume | $123.45M | $124,236,023.65 | +$0.79M |
| Platform fees | $197,498.13 | $198,908.37 | +$1,410.24 |
| Fills | 263,336 | 266,827 | +3,491 |

About $1,410 of fees in roughly twenty hours — implying ~$1,128/day committed to
buyback, or **~1,700 JTO/day** at current prices.

This is exactly the mutability the capture design exists for. A figure that
changes through the day cannot be checked later against what was claimed at the
time unless somebody wrote it down, with a date, when it was claimed.

### Two corrections to earlier entries

- **The coverage gap is confirmed, and it is real.** `RESUME-HERE.md` §3a asked
  whether the dashboard starting at 2026-07-24 was a display window or genuinely
  absent data. Data begins **2026-07-24**; JTX launched **2026-07-14** and JIP-38
  activated **2026-07-13**. So roughly **ten days at the very start of the
  commitment period carry no operator-published figures at all**, and the
  $198,908.37 excludes whatever was earned in them.
- **§5's "not archivable" was too strong.** Raw HTTP returns a client-rendered
  shell, which is what `capture.mjs` sees, but a *rendering* fetch does retrieve
  the figures — that is how the table above was obtained. The archive gap is
  narrower than stated: it needs a renderer or a Dune API key, not the
  impossible. The figures above are recorded in [`CLAIMS.tsv`](CLAIMS.tsv) with a
  hash.

## 4. The Rev Splitter is still not identified

Everything tried, and why each failed:

| Route | Result |
|---|---|
| JIP-38 itself | Names no program IDs, wallets or contracts. The original finding, confirmed by reading it. |
| Press coverage | No address published anywhere. Coverage repeats "verifiable on chain in real time" without saying where. |
| Largest JTO holders | **None of the top 20 burns at all.** |
| Jito's governance program | `jtogvBNH3WBSWDYD5FJfQP2ZxNTuf82zL8GkEhPeaJx` is executable and real, reached via holder `jjCAwuuNpJCNMLAanpwgJZ6cdXzLPXe2GfD6TaDQBXt` (21.17M JTO, program-owned, data contains "Jito"). Neither burns. Ruled out. |
| Burn sampling | Found only dust-sweeps. |

The top-holder result is informative rather than merely negative: a Rev Splitter
that acquires JTO and burns it promptly would never accumulate a balance large
enough to rank. **It is a reason the route cannot work, not evidence the
mechanism does not exist.**

One detail from coverage is worth carrying forward: the Rev Splitter is
described as operating under Dev Council delegated authority and *"automating
progressively"*. If early execution is a council multisig rather than a program,
there may be no single program ID to find, and Open Question 1 — *is it one
traceable program or a process spread across accounts?* — resolves toward the
second. That would change what can honestly be published.

## 5. The claim side is blocked, and that is itself a finding

`RESUME-HERE.md` argues the counter-intuitive design: the chain is its own
archive, so the thing worth polling is the **claim**, not the chain.
[`capture.mjs`](capture.mjs) implements that. It currently cannot do its job.

`https://dune.com/jito/jtx-metrics-ee62` returns HTTP 200 and 79,280 bytes of
**client-rendered shell**. The dashboard's title is in the HTML; none of its
figures are. Archiving it would produce a convincing-looking record of nothing.
The Dune API returns HTTP 401 without a key.

So `capture.mjs` stores the shell, marks it `shell`, and records the gap in
[`CLAIMS.tsv`](CLAIMS.tsv) with a date. **The operator's published figures are
not currently archivable by this project** — that is a dated, load-bearing
limitation, and closing it needs a Dune API key.

The chain anchor and Jito's token metadata endpoint do capture cleanly, so every
archived claim is paired with the slot and supply it was made against.

## 6. What this run did not establish

- **Any execution ratio.** The number this project exists to publish does not
  exist yet, and nothing here is a step toward publishing it prematurely.
- **That any JIP-38 buyback has occurred.** Not disproven either — not looked at
  with any instrument capable of settling it.
- **How much of the 13.48M JTO burned since genesis falls inside the JIP-38
  window.** Needs historical supply, which no public RPC serves.
- **Where the 13.48M JTO of burns actually are.** They provably exist (§2a) and
  nothing found today accounts for more than a millionth of them. This is now
  the central open question, and it is a *tooling* question before it is a Jito
  question — the burns have to be found before anyone can ask whether they were
  JIP-38's.

  An early recall check took 774 consecutive JTO transactions straight from
  `getSignaturesForAddress`, parsed each from chain, and asked the index how it
  had typed the ones containing burns. It agreed on **2 of 2** — 100% recall on
  a sample of two, worth almost nothing, and now known to be misleading: the
  index handles small simple burns correctly, which is exactly why the failure
  on large ones went unnoticed.

## 7. Where the tooling stands

| Script | Does | State |
|---|---|---|
| [`discover.mjs`](discover.mjs) | Identify the mint, measure the window honestly, sample burns, classify authorities | Rewritten; runs |
| [`verify.mjs`](verify.mjs) | Re-test every `REGISTRY.tsv` role against chain on every run; non-zero exit on failure or on an untested role a figure relies on | New; passes, and fails correctly when fed a substituted mint |
| [`ledger.mjs`](ledger.mjs) | Exhaustive burn enumeration, verified against chain, checksummed against supply | New; resumable |
| [`capture.mjs`](capture.mjs) | Archive the operator's claim with a chain anchor and a hash manifest | New; runs, and reports the Dune gap |
| [`lib.mjs`](lib.mjs) | The arithmetic that decides what gets published — base58, PDA derivation, coverage union, density integration, classification, registry parsing | New |
| [`check.mjs`](check.mjs) | The offline gate: runs every suite below, needing no RPC key | New; all passing |
| [`test.mjs`](test.mjs) | Pure logic in `lib.mjs` — arithmetic, coverage, registry parsing | Extended |
| [`test-core.mjs`](test-core.mjs) | `core.mjs` and `rpc.mjs` — exact amounts, fail-closed reads, atomic writes | New |
| [`test-pipeline.mjs`](test-pipeline.mjs) | verify/track/rawscan/discover/snapshot — the audit findings, asserted as fixed | New |
| [`test-dashboard.mjs`](test-dashboard.mjs) | The builder — schema validation, escaping, last-valid retention | New |

Two of those tests exist because of specific errors made building this:
`unionSpans` is tested against overlapping segments because summing them would
report more than 100% of a window as examined, and `integrateDensity` is tested
against a quiet window with a hot head because projecting one head reading
across the window overstated it sevenfold.

Status at the time this section was written: **pre-discovery**. Nothing was
published, no execution ratio existed, and the Rev Splitter had not been
identified. See section 8 for where that stands now.

---

## 8. Production audit and remediation, 2026-09-12 / 13

The sections above are the record as it stood when each was written, and they
are left as written. This section is what a full audit of the tooling found
afterwards, and what was done about it.

**The audit's own headline: the pipeline did not support the confidence the
prose carried.** Twenty defects were confirmed by reproduction, four of them
capable of putting a wrong number on a public page. Three matter most:

1. **The execution ratio was a literal `0` in `snapshot.mjs`.** Every scheduled
   refresh republished a dated zero-burn finding it had not made. A real
   programme burn could have occurred and the page would have carried a freshly
   timestamped 0% straight through it. Fixed: the assessment now lives in
   [`ASSESSMENT.json`](ASSESSMENT.json), a refresh can never advance it, and the
   page shows **review required** when supply or the treasury moves away from
   the anchor the assessment was made against, or when it expires.

2. **RPC failures became facts.** A failed mint read produced
   `mintAuthority: null`, which the page rendered as "supply can never
   increase" — a network timeout promoted to a verified property of the token.
   Fixed: the client throws rather than returning null, and account identity and
   ownership are asserted before anything is believed.

3. **A build was being mistaken for a deployment.** On 13 September the
   scheduled refresh invoked its publisher, the publisher correctly reported it
   had no Artifact tool and could not publish, and exited 0 — so the wrapper
   logged "done" and the task recorded success while the public page stayed
   three days stale. Fixed: [`RELEASE.json`](RELEASE.json) records what was last
   *verified* to be served, and `release.mjs status` exits non-zero when the
   built page is not the published one.

**Corrections to what this file and `README.md` previously claimed:**

- The indexed burn scan was described as *independent corroboration* that no
  programme burn exists. It is not. That index returns a largest-ever burn of
  0.96 JTO across JTO's whole history against 13.48M provably destroyed — it
  misses essentially everything, as section 2a records. An unsound search
  finding nothing is not a finding. What does corroborate the absence is the
  supply invariant alone: total destruction since genesis is ~55x larger than
  the reported fee revenue could have bought, so it predates activation.

- `ledger.mjs` printed "the enumeration is COMPLETE — proven" when its aggregate
  balanced. It no longer does. The comparison was a float tolerance over
  base-unit totals beyond `Number.MAX_SAFE_INTEGER`, over a read set from an
  index known to miss burns; omissions and duplicates can cancel. The checksum
  can falsify completeness, which is genuinely useful and is how this project
  caught its own unsoundness. It cannot establish it.

- The tracker reported accounts as "enumerated in full" when a signature page
  had failed or a transaction could not be resolved. It now retains unresolved
  signatures for retry and reports the account as INCOMPLETE, and the supply
  reconciliation requires zero unresolved reads before it will say COMPLETE.

- `--resume` was being treated as though it were monitoring. It is not: it
  finishes unfinished work and never revisits a completed account, so a resumed
  run read current supply against week-old account history. `--poll` is now the
  separate operation, and reports state their coverage cutoff.

**The remaining gap, stated plainly.** The execution ratio of 0% rests on the
supply invariant and on Jito's own statement, not on an exhaustive chain
reconstruction — `data/track-state.json` predates the exact-arithmetic rewrite
and the crawl has yet to be run again from scratch. Until it is, "no JIP-38
burn has occurred" is well-supported but not proven by enumeration here, and
the dashboard says so.

Status: the dashboard **is** published, with an execution ratio of 0% and its
assessment dated. The Rev Splitter itself has still not been identified, and
the sweep path, the 80/20 split and the fee total remain operator claims.

---

## 9. The treasury account, enumerated in full, 2026-09-13

The 2026-09-10 headline rested on two things: the supply invariant, and Jito's
own statement that no burns had occurred. Neither is enumeration. This is.

**What was done.** `track.mjs`, rebuilt under exact base-unit arithmetic, was
run from scratch against the registry seeds and allowed to expand its frontier
to 80 accounts. 77 were enumerated in full. Every expected read was resolved —
**zero accounts left incomplete, zero unresolved signatures** — which is the
condition the reconciliation now requires before it will use the word complete.

**The finding.** The DAO treasury's JTO token account
`2Ch9AWnbAaummLkWTTtNgTAvrFq8YMATUaaN77TB2Y6C` — the account JIP-38 revenue
accumulates in, and the one a burn would have to debit — had **all 16,821 of its
transactions resolved, and contains no burn instruction**. Across the whole
ledger, 63,063 events, there are **zero burns of any size**.

Alongside it: the treasury's balance has risen monotonically across every exact
reading taken, +7,686 JTO over the recorded window. Nothing is leaving the
account, and nothing in its history is a burn.

So the claim is now narrower in its assumptions and stronger in its support: **no
JIP-38 burn has been executed from the DAO's JTO holdings.** That is an
independent verification of Jito's statement rather than a restatement of it —
which is what this project exists to produce.

**What it still does not establish**, and this matters as much:

- Three accounts exceed 60,000 transactions and were not enumerated: the JTX fee
  program, the DAO treasury *wallet*, and `8Xm3tkQH581s3MoRHWUNYA5jKbgPATW4tJAAxgwDC6T6`.
- 13,477,314.11 JTO has left supply without appearing in this ledger. The
  fee-revenue argument places all of it before activation, but its individual
  burn transactions have not been located. That residual is printed on every run
  and is the crawl's own error bar.
- The sweep path and the 80/20 split remain operator claims.

**Two things the rewrite changed, visible in this run.**

*97,468 token instructions were excluded because the transaction did not identify
their mint.* The previous code took that silence for JTO and divided by 1e9 — so
every one of those would have entered this ledger as JTO and pulled its
counterparties into the crawl. That is finding 10, measured on real data.

*The only apparent fall in the treasury series is float noise.* Between
`2026-09-12T16:56` and `17:08` the recorded balance drops by 30 base units. Those
are the last reading written by the old float code and the first written by the
exact one; in base units the balance rose. The error class the rewrite removed,
caught leaving the building.

**The ledger itself is not committed.** `EVENTS.tsv` is 18MB and regenerable by
anyone who runs `track.mjs` — the chain is its own archive, as the README argues.
What is durable is this reconciliation and the assessment it supports.

`ASSESSMENT.json` was advanced on this evidence: `assessedAt`, `basis`,
`coverage` and the anchor together, in one reviewed commit, exactly as that file
requires. The number did not change. What changed is what stands behind it.
