# Questions for the Jito team

**Sent 2026-09-09, and answered.** Jito supplied the fee program, the sweep
mechanism and the DAO treasury address in response to this, and confirmed that
no buybacks or burns had yet occurred — which is the basis of the first finding.
See [`FINDINGS.md`](FINDINGS.md) section 0 for the reply and what was done with
it, and [`REGISTRY.tsv`](REGISTRY.tsv) for how each supplied address was then
re-tested against chain before it was allowed to support a figure.

It is kept here, unedited below this note, because it is the provenance of those
addresses. A reader checking where `JTXJTXfr1wVRMEzqiPhXUr69zJtfGuLh5qEiXG772Zj`
came from should be able to see that it was asked for, who answered, and what
was asked alongside it.

It was written as a private ask at a time when nothing in this repository was
public, and the sentence that opened it said so. That is no longer the case, so
the sentence has been replaced rather than left to contradict itself — the
questions themselves are untouched.

The problem it was written to solve: JIP-38 commits to reporting "with on-chain
references" and names no addresses, so every address here had to be inferred
from chain. The methodology was deliberately written before any finding existed
— see [`README.md`](README.md).

**How an answer will be used.** Anything Jito says is treated as a *claim*, not
as evidence — the same standing as the Dune dashboard. Each address supplied
gets re-tested against chain by [`verify.mjs`](verify.mjs) on every run before it
is allowed to support a published figure. That is not scepticism about Jito; it
is what makes the eventual verification worth anything to a third party. If the
buyback is being executed as committed, this project ends up **proving Jito's
claim for them**, independently, which is the outcome to hope for.

---

## What has already been established from chain

Included so the questions are read as informed rather than lazy. All of this is
reproducible from the scripts in this repository against any Solana RPC.

- The JTO mint `jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL` is confirmed by its
  derived Metaplex metadata PDA, not by its vanity prefix.
- The mint was created **2023-11-27T20:41:24Z**, and a single `mintToChecked` of
  **exactly 1,000,000,000 JTO** landed at 20:46:54Z
  (`2M1gWKQvjCav6JLkf2j5EfUmpp31RRM27YPnG1fGiyvgqu3s4C7Z1tWYXgYKoxwgMC84WG5v7tMHwMMQ74xUekVG`).
- `mintAuthority` was set to **null on 2023-12-04T18:27:47Z**. Across all 239
  transactions of the authority `AtNgME7ribDTqtZQcCL2xSBFL9NgHQsDFCj1TmxMpPtV`,
  that is the only supply-changing event. Minting is closed permanently.
- Therefore supply can fall by burning and by nothing else, and
  **13,477,143 JTO has been destroyed** (≈$8.7M at ~$0.65).

That figure is solid. What is missing is *which transactions* and *when*.

## The questions

**1. What are the Rev Splitter's on-chain addresses?**
The program ID if it is a program; otherwise the account(s) that receive JTX
fees, execute the buybacks, and sign the burns. This is the single most useful
answer — it collapses the whole search.

**2. Where do JTX platform fees accrue on chain, before the 80/20 split?**
Fee accrual is the least identifiable end of the trail: platform fees can
collect across many accounts by many routes, and picking one to follow would be
assuming the answer.

**3. Are the burns SPL `burn` / `burnChecked` instructions against the JTO mint?**
If they are something else — a transfer to a terminal address, a program-internal
mechanism — that matters a great deal, because "permanent burn" and "moved
somewhere unspendable" are different claims and JIP-38 promises the stronger one.

**4. Could you point at one example transaction of each — one buyback, one burn?**
Two signatures would let the entire path be verified end to end in minutes, and
would anchor every figure that follows.

**5. Is any of the 13,477,143 JTO already destroyed attributable to JIP-38?**
The total is provable; the *dates* are not, because Solana RPC serves only
current state and no public archive of historical supply exists. If those burns
predate 2026-07-13 — unclaimed airdrop, for instance — then JIP-38 burns to date
are a separate and much smaller number, and it would be easy to publish that
wrongly. A date or a signature settles it.

**6. Have the per-epoch dashboards JIP-38 commits to shipped?**
If there is an endpoint or API behind them, this project would check the
operator's published figures against chain rather than build a rival dashboard —
a better and more useful shape.

**7. Could Dune query 8611988 ("JTX Public Metrics") be readable programmatically?**
The dashboard at `dune.com/jito/jtx-metrics-ee62` is client-rendered, so the
public URL returns the page title and none of the figures. That means the
reporting JIP-38 commits to currently **cannot be archived** by anyone without a
Dune API key — see [`CLAIMS.tsv`](CLAIMS.tsv), where the gap is dated rather than
left implicit. A published number that cannot be captured cannot later be checked
against what was claimed at the time, which seems contrary to the intent.

## Worth saying plainly

The reason to build this is that Jito's public position is that the Rev
Splitter's on-chain nature lets anyone verify the buybacks in real time. Unlike
most such claims, that one appears to be **true** — a buyback and a burn settle
on chain. Nobody is doing the verifying, and the reporting commitment supplies no
addresses to start from.

If the numbers match, this is a third-party proof of a promise kept.
