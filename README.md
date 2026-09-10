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

**First finding, 2026-09-10: no JTO has been burned under JIP-38.**

The Jito team supplied the mechanism on request — JTX swap fees are collected by
the program `JTXJTXfr1wVRMEzqiPhXUr69zJtfGuLh5qEiXG772Zj`, swept periodically
into JTO, split 80/20, with 80% going to the DAO treasury
`5eosrve6LktMZgVNszYzebgmmC7BjLK8NoWyRQtcmGTF` — and stated that there have been
no burns so far. Both addresses verify on chain, and the treasury's JTO account
turns out to be the one this project had **already identified independently** as
the largest JTO holder, before any address was supplied.

An independent search corroborates the absence: across the whole of JTO's
history, no programme-scale burn exists anywhere — the largest burn found in any
sample was 0.96 JTO, and all of it was rent-reclaim dust.

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

Needs Node 22+ (for `process.loadEnvFile`) and a Solana RPC endpoint in `.env`:

```
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
```

`.env` is gitignored and must stay that way. Burn discovery needs a Helius key
specifically, because it walks a burn-filtered index; everything else works
against any RPC.

```
node test.mjs        # 40 offline tests, no key needed
node verify.mjs      # re-test every REGISTRY.tsv role against chain; exit 1 on any failure
node track.mjs       # THE MAIN TOOL — crawl accounts, build EVENTS.tsv, reconcile against supply
node capture.mjs     # archive the operator's claim alongside the chain state it describes
node discover.mjs    # identify the mint, measure the window, sample and classify burns
node rawscan.mjs     # exhaustive raw enumeration — sound, but needs a paid RPC tier
node ledger.mjs      # burn enumeration via a burn-filtered index — KNOWN UNSOUND, see FINDINGS.md 2a
```

Run `verify.mjs` before trusting anything else. It exits non-zero both when an
address stops behaving as `REGISTRY.tsv` records, and when an entry a figure
depends on has no test at all — an unchecked dependency is a hole in the
verification, not a detail.

## Licence

MIT.
