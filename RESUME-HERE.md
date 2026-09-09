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

**Pre-discovery.** Nothing published, no addresses confirmed, no figures exist.

Recorded so far: the JTO mint,
`jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL`, at confidence **strong** — 43
characters, valid base58, vanity prefix matching the token. Format is not
identity, so `getTokenSupply` on the first run is what promotes it to confirmed,
or fails loudly.

## 8. Next steps

1. Set `SOLANA_RPC_URL` in the new workspace.
2. `node discover.mjs` — walks the mint's history back to JIP-38 activation and
   ranks burn authorities by volume. Writes nothing; concludes nothing.
3. Judge the candidates. Record outcomes in `REGISTRY.tsv` with evidence and an
   honest confidence, including **rejected** candidates so a ruled-out address is
   not rediscovered and adopted later.
4. Only then decide the architecture. Whether the trail is traceable end to end
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
