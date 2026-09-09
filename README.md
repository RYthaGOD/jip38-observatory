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

**Pre-discovery.** Nothing is published, no addresses are confirmed, and no
figures exist. The next step is address identification against a Solana RPC.

## Licence

MIT.
