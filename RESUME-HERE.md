# RESUME HERE — JIP-38 Observatory

Everything decided on 2026-09-09, when this project was scoped. Read this first
if you are coming back cold. [`README.md`](README.md) states what the project
claims; this states why it is built the way it is, and what we chose not to do.

Sibling project: **BAMservatory** (`d:/BAM BAM PM/`). Separate repo, separate
workspace, no shared code. Keep it that way — see *Why not a fork* below.

---

## 0. Where this came from

The thesis is not "monitor more of Jito". It is narrower and better than that:

> JTX revenue is used to buy back and burn JTO. That is a specific, dated, public
> commitment, and every step of it settles on chain. Nobody is checking it.

That is the same shape as BAMservatory — an operator makes a claim, the operator
is the only source, so build the independent instrument — but with a decisively
better ending. BAM's attestations are marketed as "a publicly available audit
trail anyone can use" and no endpoint serves them, so BAMservatory can only
document that the claim is uncheckable. Here the operator says the Rev Splitter's
on-chain nature means anyone can verify the buybacks in real time, and that is
**true**. A buyback and a burn are settled on chain.

So this project can verify **outright** rather than corroborate. It is
epistemically stronger than BAMservatory, not weaker.

## 1. What JIP-38 actually commits

Activated **2026-07-13**; JTX launched **2026-07-14**.

| Term | Commitment |
|---|---|
| JTX platform fees | 80% to the DAO, 20% reinvested in JTX development |
| DAO's JTX revenue share | 100% to open-market JTO buybacks and permanent burns |
| Duration | At least one year, through **Q4 2027** |
| Mechanism | The **Rev Splitter** — collects JTX fees, executes JTO buybacks |
| Oversight | Jito Dev Council, delegated authority under JIP-35 / JIP-36 |
| Reporting | Per-epoch dashboards of fees collected, JTO acquired and burned, "with on-chain references" |

JitoSOL, BAM and Block Engine revenue flow to the DAO but are **not** committed to
buybacks in this period. Everything published here is scoped to the JTX stream
only. Saying otherwise would be the easiest way to be wrong in public.

Sources: [JIP-38 on the Jito forum](https://forum.jito.network/t/jip-38-confirm-jito-as-a-token-centric-network/973) ·
[Cryptobriefing](https://cryptobriefing.com/jito-jip-38-jtx-trade-buybacks/) ·
[CryptoRank](https://cryptorank.io/news/feed/42d41-jito-jtx-fees-jto-buyback-burn) ·
[Phemex explainer](https://phemex.com/blogs/what-is-jtx-why-jito-burns-jto) ·
[JTX metrics dashboard (Dune, Jito's own)](https://dune.com/jito/jtx-metrics-ee62)

## 2. The decisive finding

**JIP-38 names no program IDs, no wallet addresses, no contract identifiers.**

The proposal was read directly, not via coverage. It commits to reporting "with
on-chain references" and supplies none of its own.

This is why the first artifact is [`REGISTRY.tsv`](REGISTRY.tsv) rather than a
dashboard. The addresses have to be *identified*, and identification is an
inference. If it is wrong, every figure downstream is wrong — so it leads, with
its evidence and an honest confidence, exactly as BAMservatory treats its
region-from-node-name inference.

## 3. What this will measure

All derived from chain, all against the commitment above:

- JTX platform fees accrued — daily, and cumulative since 2026-07-13
- Amount routed through the Rev Splitter
- **Realized split against the claimed 80/20**
- JTO acquired on the open market: amount, average price, venue
- JTO burned, and whether it is genuine supply reduction rather than a treasury
  transfer — those are different claims and JIP-38 promises the stronger one
- Lag between fee accrual and burn
- Cumulative JTO removed, as a share of supply

**The one number this exists to publish** is the *execution ratio*: value burned
over JTX fee revenue, against the promised 80%. Everything else is supporting
evidence.

### Early-warning conditions

The analogue of BAMservatory's structural-rollover detection — things that should
raise an alarm rather than sit quietly in a table:

- the realized split drifting off 80/20
- burns stopping, or the lag growing
- the burn destination changing
- the Rev Splitter address changing

## 3a. The Dune dashboard, and what it is actually for

Jito publishes JTX metrics on Dune:
[dune.com/jito/jtx-metrics-ee62](https://dune.com/jito/jtx-metrics-ee62). As
fetched 2026-09-09 it showed trading volume $123.45M, platform fees $197,498.13,
263,336 fills, and daily active wallets, each broken down by source (dflow,
limit, titan).

**Do not use it as a data source.** Sourcing figures from the operator's own
dashboard would rebuild inside this project the exact dependency it exists to
remove, and would leave `recompute.mjs` with nothing to recompute from — the
"evidence" would reduce to "Dune said so".

**Use it as the claim.** It is the *claimed* side of claimed-versus-verified, and
that is the whole product:

| | Source | Nature |
|---|---|---|
| Claimed | Jito's Dune dashboard, and the per-epoch reporting JIP-38 commits to | Mutable |
| Verified | Derived from chain by this project | Immutable |

**And this is where BAMservatory's capture model does transfer — correctly.**
Chain data needs no archive: it is immutable and queryable on demand, so the
chain is its own archive. A Dune query is the opposite. It can be edited, its
results can change retroactively, and it can be deleted. So the operator's
published numbers must be **captured and archived on a schedule**, exactly as
BAMservatory captures the BAM API, so that what was claimed on a given date
cannot be revised without record.

That inverts the naive design in a useful way. The thing worth polling is not the
chain. It is the claim.

Secondary uses worth having:

- **Fee provenance.** The source split (dflow / limit / titan) indicates where
  fees originate, which should help locate the fee accounts on chain.
- **Plausibility bounds.** Volume, fills and active wallets give independent
  context for whether a chain-derived fee figure is the right order of magnitude.

Two things to establish before relying on any of it:

- **Coverage gap.** The dashboard showed data from **2026-07-24**, but JIP-38
  activated 2026-07-13 and JTX launched 07-14. That is roughly ten days at the
  start of the commitment with no operator-published figures. Confirm whether
  that is a display window or genuinely absent data — either way, the
  verification record should run from activation, not from where the operator's
  chart begins.
- **Access.** Programmatic Dune access generally needs an API key, and the free
  tier may not permit it. If results cannot be pulled reliably, capture what is
  publicly rendered and archive that instead — the point is an immutable record
  of the claim, not a convenient one.

## 4. Discovery strategy: start at the burn

Burns are the most identifiable event available — an SPL burn against the JTO
mint, verifiable supply reduction. Fees are the least, because platform fees can
accrue across many accounts by many routes, and picking one to follow would be
assuming the answer.

So [`discover.mjs`](discover.mjs) runs backwards:

1. Find JTO supply reductions and the burn instructions behind them.
2. Identify the authority that signed each burn.
3. Trace that authority's inbound JTO — venue, swap, funding.
4. Trace those funds back toward JTX fee collection.

Where the chain goes cold, that is reported as a limit, not bridged with an
assumption.

**Finding zero burns is a result, not a failure.** It would mean the burns are not
SPL burns against this mint, or the mint is wrong, or they have not happened.
Establish which before assuming the third.

> ### Correction, 2026-09-09 — step 2 above is wrong
>
> Written before anything had been run, and falsified by the first hour against
> mainnet. Both halves of the strategy failed, and the section is kept as
> written so the error is legible rather than tidied away.
>
> **The authority that signed a burn is usually nobody.** Most JTO burns are
> wallets sweeping dust to reclaim rent. The first burn found on chain destroyed
> 0.63 JTO alongside two unrelated mints inside a transaction carrying seven
> `closeAccount` instructions; the next two were 0.0006 JTO each. JTO's supply
> falls all day long in fractions of a token for this reason, and none of it is
> a buyback. Ranking burn authorities by volume therefore ranks noise. They have
> to be **classified** first, and only a programme-scale burn is worth tracing.
>
> **And the scan could not have covered its own window.** The mint carries
> ~1,000 signatures every four minutes at the chain head. The 200-page cap in
> the original `discover.mjs` reached back about fourteen hours, against a
> 58-day window — it would have printed "none found in window" having examined
> roughly 1% of it. That is exactly the silent truncation §3a of this document
> warns about, and it was sitting in the code that document shipped with.
> Coverage is now measured from the cursor's own timestamps and printed beside
> every count.
>
> What survives is the *ordering* — burns really are more identifiable than
> fees, so starting at the burn is still right. What does not survive is the
> assumption that any burn will do.

## 5. Decisions, and why

**Why not a fork of BAMservatory.** Its core is a 60-second API poller with a raw
capture archive. None of that applies: the chain *is* the archive, and you query
history rather than accumulate it. Copying it would mean deleting most of it and
inheriting assumptions that do not hold. What transfers is the **method** —
independent derivation, published evidence, recompute-from-source, inference
labelled as inference, limits stated before findings exist. What does not
transfer is the machinery.

**Why a separate repo and workspace.** Beyond the data model: a problem in one
must not cast doubt on the other. Two narrow instruments beat one broad
dashboard.

**Why no GitHub remote yet.** A public repo announcing an audit of Jito's buyback,
before the methodology has produced a single verified number, invites scrutiny
that cannot yet be answered. Push when there is something to stand behind.

**Why the name is a placeholder.** "BAMsey" and "BAMservatory" are BAM-specific.
The sentinel persona can carry across — it usefully signals the same method — but
this needs its own identity, decided before anything is published.

**Why there is no token, and why it matters more here.** A token was considered
for BAMservatory on 2026-09-08 and rejected: it would have destroyed the
independence the whole project trades on. That reasoning is stronger here. This
project publishes price-sensitive findings about a specific token. Holding JTO
while publishing them would make every finding a trade. **Never hold JTO while
this runs.**

## 6. Hazards, honestly

**Price sensitivity.** "Realized buyback is 62%, not 80%" moves a token. This is
materially more sensitive than BAM concentration figures. The methodology must be
published *before* the first finding, so nobody can argue it was built to fit the
result. Errors here have financial consequences for readers.

**Address identification is the weak point.** It is this project's equivalent of
region-from-node-name. Get the Rev Splitter, the fee accounts or the burn
destination wrong and everything downstream is wrong. Hence `REGISTRY.tsv`, and
hence re-testing every stated role on every run rather than trusting the file.

**Attribution may be genuinely hard.** If buybacks route through market makers or
aggregators, linking a specific swap to the programme could be unprovable. Should
that happen, the honest product narrows to "fees in, JTO burned, the middle is not
attributable" — still worth publishing, but a smaller claim. Do not bridge it.

**The relationship with Jito is different.** With BAM, the project documents a gap
the operator can close, and the posture is collaborative. Here it audits whether
they did what they promised — which stays friendly exactly as long as the numbers
match. If the buyback is faithfully executed, this dashboard *proves their claim
for them*, and that is the outcome to hope for.

## 7. Status

**Pre-discovery**, but no longer pre-chain. First contact was 2026-09-09 and is
recorded in [`FINDINGS.md`](FINDINGS.md). In short:

- The JTO mint is **confirmed**, by its derived Metaplex metadata (name `JITO`,
  symbol `JTO`, URI under `metadata.jito.network`) rather than by its format.
- `mintAuthority` is **null**, and genesis supply is **verified on chain** —
  one `mintToChecked` of exactly 1,000,000,000 JTO on 2023-11-27, found by
  binary search. So supply can fall only by burning, and **13,477,142 JTO** has
  been destroyed: a *ceiling* on JIP-38 burns, not a measurement.
- **The burn-filtered index the discovery tooling rests on is unsound.** Those
  13.48M JTO of burns provably exist, and sampling the index across JTO's whole
  history returns a largest-ever burn of 0.96 JTO. It sees rent-reclaim dust and
  nothing else. Read `FINDINGS.md` §2a before writing any more code against it.
- **Three premises in this document were falsified by running them.** See §4 and
  §8 below, which have been rewritten accordingly.
- The Rev Splitter is **still not identified**, by any route tried.
- The claim side is **blocked**: the Dune dashboard is client-rendered, so its
  figures are not in the HTML, and archiving them needs a Dune API key.

## 8. Next steps

The original plan here — run `discover.mjs`, rank burn authorities by volume,
pick the Rev Splitter out of the list — does not work, for the reason in §4. It
is replaced by:

1. `.env` holds `SOLANA_RPC_URL` (a Helius key; the burn-filtered index used for
   discovery needs one). It is gitignored and must stay that way.
2. `node verify.mjs` before anything else — it re-tests every `REGISTRY.tsv`
   role against chain and exits non-zero if one no longer holds.
3. **Look for ~200,000-300,000 JTO of burns in the window — NOT the 13.48M.**
   This changed late on 2026-09-09 and it is the most important correction in
   this document. Jito's own dashboard puts cumulative JTX platform fees at
   **$198,908.37**, so JIP-38's 80% share commits about **$159,127** to buying
   and burning JTO — a few hundred thousand tokens, and roughly **1,700 JTO a
   day** at the current fee rate.

   The 13,477,143 JTO destroyed since genesis is **~55x larger than the entire
   programme could have produced**. It is almost certainly pre-activation, and
   hours were spent chasing it. It is still worth dating eventually, but it is
   not the JIP-38 question.

   The burns that matter are four orders of magnitude above rent-reclaim dust,
   so they remain easy to distinguish — the search is just far smaller than it
   looked. See `FINDINGS.md` §3c.

   Two routes, and the second is the promising one:

   - **Raw enumeration** (`rawscan.mjs`) is sound but was measured at ~220
     tx/min against this key, with 77% of requests throttled: about 150 hours
     for the JIP-38 window. It needs a paid RPC tier, and with one it is the
     definitive answer. It resumes with `--resume`.
   - **Walk the distribution tree**, which is far cheaper and already started —
     see `FINDINGS.md` §2c and the `distribution-hub` entries in
     `REGISTRY.tsv`. Every account on it has few enough transactions to resolve
     in full. Continue breadth-first from `7T6SXnG1…`'s outflows, resolving each
     recipient's history and recording the ones with no burns as `rejected` so
     the frontier shrinks. The burns left from somewhere in this tree.

   Once found, the burns are datable, and dating them splits genesis-era burns
   from JIP-38-era ones without needing historical supply at all.
4. **Then, and only then, ask whether any of them are JIP-38's.** Trace a
   programme-scale burn's inbound JTO to a swap, and the swap's funding to JTX
   fee revenue.
5. **Get historical supply at 2026-07-13** if a source can be found — it would
   convert the 13.48M ceiling into an in-window figure directly. Public RPC
   serves current state only.
6. Get a **Dune API key** so the claim side can be archived at all.
7. Only then decide the architecture. Whether the trail is traceable end to end
   determines whether this is an indexing job or a research project — and that
   answer changes what can honestly be published.

## 9. Open questions

- Is the Rev Splitter a single traceable on-chain program, or a process spread
  across accounts? **This gates everything.**
- Has Jito shipped the per-epoch dashboards JIP-38 commits to? If so, the product
  becomes "check the operator's dashboard against chain" — the exact BAMservatory
  pattern, and a stronger framing than building a rival dashboard.
- Are JTX fees observable on chain at the point of accrual, or only after routing?
- Is "permanent burn" a real supply reduction in every instance, or sometimes a
  transfer to an address that merely looks terminal?
