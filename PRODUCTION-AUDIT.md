# Production audit — JIP-38 Observatory

Audit date: 12 September 2026, Australia/Perth. Intended launch: Monday, 14 September 2026.

## Release decision

**NO-GO for an automatically refreshed production monitor in its current state.** The frontend is presentable, but a successful refresh does not establish that its headline assessment is current or that its RPC inputs are valid. Publishing has also failed in recorded scheduled runs.

A deliberately dated research snapshot is a narrower possible release, provided its assessment date and limitations are prominent and the deployed page is verified. That would not constitute an operational burn monitor.

This was an audit: no production code or source data was changed. The report reviews the current working tree, including the recent frontend changes. No live chain crawl, publication, account mutation, or secret inspection was performed.

## Confirmed findings

### 1. P1 — Fresh snapshots republish a fixed zero-burn assessment

Locations: `snapshot.mjs:52`, `snapshot.mjs:109`, `dashboard.template.html:50`.

`burnedJto`, `burnedUsd`, and `ratio` are literals set to zero. The assessment basis is dated 10 September. Platform fees are also fixed to a 9 September capture. A refresh advances the chain timestamp and balances but does not update those inputs. Even a supply-decrease alert does not invalidate the zero assessment. Thus a later real programme burn can coexist with a newly timestamped 0% headline.

Required before launch: represent chain observation time, claim capture time, and burn-assessment time separately. Require explicit coverage/attribution evidence to advance the assessment. On unreviewed changes or expired coverage, show unknown/review required instead of zero. For Monday, a clearly dated manual assessment is acceptable only if the product is described accordingly. Define the burn USD valuation method before displaying nonzero execution ratios; the browser uses burn USD / reported fees, while a snapshot comment describes a different denominator.

Acceptance: simulate a new supply/treasury change after assessment; the headline must not imply a fresh verified zero. Test a nonzero ratio against one documented denominator and valuation period.

### 2. P1 — RPC failures become valid-looking treasury and authority facts

Locations: `snapshot.mjs:41`, `snapshot.mjs:47`, `snapshot.mjs:82`.

A null treasury response becomes an empty account list and a zero balance. A null mint account response becomes `mintAuthority: null`, which the frontend interprets as permanently closed minting. The refresh does not run the registry verifier before building.

Reproduced offline against the real snapshot script using mocked RPC and filesystem calls: successful supply response plus failed mint and treasury responses produced a written snapshot with treasury 0, mint authority null, burns 0, and no alerts on a first run.

Required: validate every required RPC response and account identity/schema before constructing a snapshot. Distinguish unavailable from null authority. Abort publication and preserve the last valid snapshot on incomplete reads; report refresh failure separately.

Acceptance: inject null, JSON-RPC errors, invalid amounts, missing parsed account data, and wrong owners. No invalid snapshot or history entry may replace valid data.

### 3. P1 — Publishing is demonstrably failing and lacks verification of the public result

Locations: `refresh.cmd:33`, `refresh.log` (12 September 2026, 14:00 and 20:00 Perth runs).

Both observed runs built new local HTML, then the Claude publisher returned a weekly-limit message and errorlevel 1. The scripts correctly recorded failure for these runs. However, the workflow relies on an LLM CLI and its tool availability/quota, and has no public content hash or snapshot timestamp readback. A successful CLI exit alone is not proof that the intended artifact was updated. Logs are the only failure reporting visible in this repository.

Required: select and rehearse the actual hosting route; require a deployment receipt and verify the served snapshot timestamp/hash at the intended URL. Route failures to an actionable notification. If Claude Artifacts remains the destination, demonstrate authenticated publishing and recovery after quota/tool failure. A local build is not evidence of a successful deployment.

Acceptance: one successful end-to-end staging release, one simulated failed deployment that is detected, and a tested rollback to the preceding version.

### 4. P1 for batch consumers — Default RPC batches can hang indefinitely

Locations: `rpc.mjs:36`, `rpc.mjs:52`, `rpc.mjs:118`.

The bucket holds at most 8 tokens, but `maxBatch` defaults to 10. A batch costing 9 or 10 can never satisfy `tokens >= cost`. The HTTP timeout does not help because no fetch begins.

Reproduced with a nine-item batch and bounded mocked timers: five wait iterations, zero fetches. This does not block the current six single-call snapshot path; it affects consumers using the shared client's default batch configuration.

Required: ensure chunk cost never exceeds bucket capacity, or explicitly support larger costs; validate configuration. Add completion tests for batch sizes 8, 9, 10, and 11.

### 5. P2 — Invalid nested snapshot data crashes the UI without its error banner

Locations: `dashboard.template.html:47`, `dashboard.template.html:82`, `build-dashboard.mjs:15`.

The browser catches JSON parse/top-level errors only. The builder does not validate the full snapshot. With `registry: [null]`, real browser execution throws while reading `confidence`; the error banner remains hidden and download stays disabled. Other fields can already have rendered, leaving a partial page.

Required: validate the snapshot schema before writing HTML; put complete frontend initialization behind an error boundary. Provide an explicit unavailable state and reject negative/nonfinite financial inputs.

Acceptance: malformed nested collections, unsupported schemas, and invalid metrics must fail the build or produce a clear complete error state, never a silent partial dashboard.

### 6. P2 — Snapshot timestamps do not identify the slots of all measurements

Locations: `snapshot.mjs:37`–`snapshot.mjs:42`.

Supply, account state, slot, and treasury are fetched separately, while the response context slots are discarded. One unrelated getSlot result is presented as the snapshot slot. Near a transfer or supply event, these measurements can refer to different ledger states.

Required: preserve each RPC response's context slot and use an explicit commitment policy. Where practical, read related accounts using getMultipleAccounts and its response context. Otherwise disclose the collection slot range rather than claiming one exact measurement slot. minContextSlot is a lower bound, not a historical snapshot selector.

Reference: [Solana getMultipleAccounts documentation](https://solana.com/docs/rpc/http/getmultipleaccounts).

### 7. P2 — Writes and releases are not transactional; alerts are transient

Locations: `snapshot.mjs:169`, `snapshot.mjs:184`, `build-dashboard.mjs:27`, `snapshot.mjs:144`.

History is appended before the snapshot is written, and snapshot/HTML files are written directly. Interruption or concurrent refreshes can leave partial or inconsistent files. Alerts compare only with the preceding snapshot and are replaced each run, so an unresolved anomaly can disappear on the next stable reading.

Required: lock refresh execution, validate first, write temporary files and atomically replace completed outputs, retain the previous valid release, and persist unresolved alerts until reviewed. Keep durable history backups outside the working machine.

Acceptance: interrupt writes and run overlapping refreshes; readers must receive either the old valid release or the new valid release. An unreviewed alert must survive a subsequent unchanged reading.

### 8. P2 — Release reproducibility and host security remain unproven

Locations: `.gitignore`, `refresh.cmd`, repository root.

Both data and dist are ignored; a clean checkout does not contain the snapshot needed to build the dashboard. There is no checked-in CI/release definition, host configuration, or durable release manifest. The dashboard regression test was untracked at audit time. No production host response was inspected, so TLS, MIME type, caching, CSP, compression, access restrictions, and rollback cannot be certified.

Required: document the supported Node version, archived snapshot acquisition, exact build/test commands, and deterministic deployment artifact. Deploy only the public output, never the repository root or claim archives indiscriminately. Configure the chosen host and check actual responses. A restrictive CSP must account for the inline script/style; avoid breaking rendering by applying a generic policy blindly.

Acceptance: build from a clean checkout plus the declared snapshot artifact, deploy to staging, compare served content, and prove that private files are inaccessible.

## Verified strengths and frontend results

- All 40 existing offline logic tests passed.
- Dashboard builder checks passed: exact JSON round-trip, script-delimiter escaping, literal replacement sequences, missing-placeholder rejection, and JavaScript syntax.
- Current built HTML: 35,615 bytes; no baseline JavaScript exceptions in installed Edge/Chromium.
- No document-level horizontal overflow at 320, 375, 768, and 1440 CSS pixels. Wide tables and chart remain local scroll regions.
- Normal-page navigation targets measured 34px high on mobile and 46px on desktop. Do not incorrectly label the mobile size a WCAG failure solely for being below 44px: WCAG 2.2 AA target-size minimum is 24px, with documented exceptions/spacing rules. [W3C guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
- Explicit input labels, table headers, chart data table, reduced-motion handling, and a keyboard skip link are present.
- The page has no external styling/font/runtime dependency. Text values are rendered through textContent and explorer addresses are encoded.
- The current build identifies the 12 September 11:59:53 UTC chain snapshot; this does not advance the older burn assessment.
- Earlier browser interaction checks covered registry filtering and exact JSON downloads. This audit additionally exercised a malformed nested-data case and identified the failure above.

## Checks still required on staging

These are coverage limits, not claimed defects:

- Safari/iOS and Firefox rendering, downloads, keyboard navigation, and assistive technology behavior.
- Automated accessibility scan plus manual contrast, focus, zoom/reflow, and screen-reader review. Small 9–12px labels merit usability review even where contrast/target criteria pass.
- Hosting response headers, CSP compatibility, caching/freshness, canonical URL and social previews as appropriate.
- Lighthouse/Core Web Vitals on the hosted page; no score is claimed from a local file test.
- Scheduler configuration, failure notification delivery, retained backups, and restoration on another machine.
- Current proposal/claim validation and programme-burn attribution. This audit did not refresh or independently re-establish those external financial facts.

## Monday release sequence

1. Resolve findings 1–3 before presenting this as an active monitor. Fix finding 4 before enabling any batch-based verification/discovery in the production workflow.
2. Add schema validation and safe writes; persist anomaly state; commit the complete release and its tests.
3. On Sunday, rehearse clean build, successful staging publication, failed publication, stale assessment, partial RPC failure, and rollback. Store the evidence and release hash.
4. On Monday, deploy that tested version; verify the actual URL, its embedded snapshot/assessment dates, mobile view, and snapshot download. Assign a named person to check the next scheduled refresh and respond to failure.

The current passing frontend and logic tests do not cover the data-pipeline failure modes reproduced by this audit. Do not use the test count alone as a production sign-off.

# Expanded repository audit

This extension covers all root application modules (`build-dashboard`, `snapshot`, `rpc`, `track`, `verify`, `rawscan`, `ledger`, `discover`, `capture`, and `lib`), both existing test files, both refresh wrappers, the registry and claim manifest, all seven manifest-referenced archives, the scheduled task, and project documentation. It extends rather than replaces findings 1–8. Source inspection is not a proof of absence of further defects.

Reproduction evidence was saved in `audit-reproductions.mjs`, which executed the actual source logic against synthetic RPC responses and in-memory writes, and intentionally CONFIRMED the defects below.

**Superseded, 13 September 2026.** Those characterizations have been replaced by `test-pipeline.mjs`, which asserts the corrected behaviour instead, and by `test-core.mjs`. Each case names the finding it holds shut. `audit-reproductions.mjs` has been removed rather than left in the tree, because several of its assertions now fail by design — the defects they described are fixed. Its content remains in git history at commit 914f9d8 and earlier. Run `node check.mjs` for the full offline gate.

## Additional confirmed defects

### 9. P1 — Tracker permanently marks incomplete RPC reads as fully enumerated

Locations: `track.mjs:170`, `track.mjs:188`, `track.mjs:255`.

Failed signature pagination is indistinguishable from end-of-history. Failed transaction resolutions are skipped, then the account receives `done: true`. The report calls it enumerated in full. Resume skips that account, so omitted transactions may never be retried.

Reproduced both paths separately: a null signature response and a null getTransaction result each produced done=true, zero events, and “1 enumerated in full.”

Fix: persist pagination completeness and unresolved signature queues separately; only mark complete after all expected responses have been validated. Fail or label the report incomplete on any unresolved read. Preserve retryable work in checkpoints.

### 10. P1 — Non-JTO token operations can contaminate the JTO event ledger

Locations: `track.mjs:215`–`track.mjs:235`.

Unchecked SPL transfers have no explicit mint in their parsed info. The code accepts operations lacking a mint and divides their amount by 1e9. In a multi-token transaction this can record an unrelated token as JTO and promote the wrong counterparties. Close/authority operations lacking mint identity are also recorded without establishing JTO scope.

Reproduced with a transaction whose token balance metadata names another mint: the unchecked transfer was recorded as 1,000 JTO.

Fix: resolve token-account mint identity using transaction pre/post token balances and appropriate historical context. Require positive JTO identification before recording or expanding a branch. Unknown identity must remain unresolved, not default to JTO. See [Solana transaction structures](https://solana.com/docs/rpc/json-structures) for account-index and token-balance metadata.

### 11. P1 — Verifier can pass failed authority reads and wrong treasury ownership

Locations: `verify.mjs:95`, `verify.mjs:131`, `verify.mjs:183`; `lib.mjs:121`.

The historical-authority role converts a missing mint response into null authority and returns success. The treasury-token-account role prints the owner but never compares it with the expected DAO. The main mint check does not fail solely because getTokenSupply is unavailable. Registry parsing accepts a header-only file, allowing verify to finish successfully with no entries checked.

Reproduced: failed authority response passes; a JTO token account belonging to a different owner passes; header-only registry parses as an empty list. These are separate unsafe validation paths, not a claim that an all-RPC-failed run against today's full registry would pass.

Fix: require all load-bearing roles and successful responses, validate owners and exact mint identity, and reject empty/malformed registries. Parse structured Metaplex metadata and validate its mint and URI hostname; matching an arbitrary text substring `jito.network` is not a domain-identity check. Genesis/history assertions in registry prose are not all revalidated by this verifier.

### 12. P1 — Raw scans can leave boundary gaps and advance past unresolved transactions

Locations: `rawscan.mjs:99`–`rawscan.mjs:109`, `rawscan.mjs:147`, `rawscan.mjs:227`–`rawscan.mjs:239`.

anchorAt stops when its search interval is within 3,000 slots and returns the lower bound, which can precede the requested upper time boundary. Adjacent scans stop at nominal lower boundaries; starting the next one earlier leaves unexamined space. Failed anchor/signature reads are marked done; failed resolution batches are skipped while scan counts and cursors advance.

Boundary reproduced with a monotonic synthetic ledger: requesting time 9,000 returns an anchor at 7,501. Failure-handling findings are directly visible in the cursor/resolve code.

Fix: pin one scan end slot, enforce continuous slot/signature coverage including boundary transactions, and retain unresolved signatures. Explicitly record inspected, resolved, failed, and excluded counts. “Exhaustive” must be gated on complete coverage, not selected mode. [Solana signature pagination](https://solana.com/docs/rpc/http/getsignaturesforaddress) defines the before/until cursor contract.

### 13. P1 — Burn deduplication collapses distinct equal-valued instructions

Location: `rawscan.mjs:267`.

The dedupe key is signature + token account + amount. Two separate burn instructions in the same transaction can share all three values. The current key deletes one, understating total destruction.

Reproduced with two distinct identical-valued burn records in one transaction: only one survives. Fix: preserve outer instruction index and inner instruction position in the event identity. Deduplicate repeat retrievals of the same instruction, not matching amounts.

### 14. P1 — Discovery counts burns in failed transactions as verified

Location: `discover.mjs:388`–`discover.mjs:401`.

Unlike track, ledger, and rawscan, the discovery candidate-verification loop does not reject `tx.meta.err`. It reads burn instructions from the failed transaction and increments the verified total.

Reproduced: a synthetic transaction with an instruction failure and a parsed burn increments the verified count to one.

Fix: require successful execution and complete metadata before counting. Retain failed attempts separately if useful, but never include them in executed burn totals. See [Solana transaction metadata](https://solana.com/docs/rpc/json-structures).

### 15. P2 — Resume is continuation of old work, not ongoing monitoring

Location: `track.mjs:153`; checkpoint initialization in `track.mjs`, `rawscan.mjs`, and `ledger.mjs`.

Finished tracker accounts are never polled again on resume. A resumed report reads current supply while retaining old completed account history. Raw/indexed scan segments likewise retain old top boundaries on resume while presenting newly read current supply/times. New transactions after the original cutoff are not necessarily covered.

Reproduced for tracker: a resumed done account makes zero signature requests but remains reported as fully enumerated.

Fix: distinguish a bounded historical scan from incremental monitoring. Persist head/tail cursors and coverage cutoff. Poll newer signatures for ongoing monitoring, or label reports with their original fixed end point and reconcile supply at that point. Do not equate resume with refresh.

### 16. P2 — Exact reconciliation uses floating-point amounts and heuristic completeness

Locations: `track.mjs:216`, `track.mjs:359`; `snapshot.mjs:44`–`snapshot.mjs:47`; ledger completeness checksum.

JTO base-unit totals can exceed Number.MAX_SAFE_INTEGER. Converting raw integers to Number and subtracting large displayed supplies loses base-unit precision. A float tolerance or a balanced aggregate is not an instruction-level proof when duplicates, missing reads, and mismatched time boundaries remain possible. The indexed ledger already documents unsound discovery, yet still contains an unconditional “COMPLETE” branch on an approximate numerical balance.

Fix: retain raw integer amounts as BigInt/decimal strings throughout arithmetic, convert only for display, align the comparison window, and require zero unresolved reads plus unique instruction identities. Do not present an indexed scan as proof of completeness merely because its aggregate matches.

### 17. P2 — Invalid configuration and registry data are accepted; feasibility integration is not clipped

Locations: numeric argument parsing in track/rawscan/ledger/discover; `lib.mjs:82`–`lib.mjs:89`, `lib.mjs:121`.

Zero/negative/nonfinite batch, concurrency, segment, and date parameters lack validation. In particular, a zero batch prevents the `i += BATCH` loop from progressing when there is work. Registry parsing silently drops missing-role/address rows and does not validate confidence/address encoding itself. The density integral includes samples outside its requested interval.

Reproduced integration: a constant rate of 1 over samples at 0 and 100 returns 100 for the requested interval [40,60], instead of 20. Current callers can receive drifting probe anchors, so correct clipping matters to feasibility estimates.

Fix: validate CLI arguments before network or output activity; reject invalid registry rows with line numbers; clamp and interpolate at integration boundaries. Use tested canonical PDA derivation for generalized mint support; the current helper hashes candidates without a full off-curve validity check and searches only a limited bump range. This is a generalization limitation, not a demonstrated mismatch for the known JTO PDA.

### 18. P2 — Archive success does not establish a valid or fresh fee claim

Locations: `capture.mjs:103`, `capture.mjs:134`, `capture.mjs:166`.

Any comma-formatted number in dashboard HTML can mark it as containing figures. A Dune HTTP 200 response is marked ok without validating the expected metric, execution time, schema, or completeness. A run with failed/blocked required captures has no nonzero failure exit. The regular refresh does not invoke capture or consume newly captured values; claims remain literals in snapshot.mjs.

Fix: archive raw bodies, but distinguish transport success from validated claim acquisition. Check metric schema and source execution timestamps, fail required capture gates, and explicitly import an approved capture into the snapshot. Hashes verify bytes, not their factual correctness.

Security subfinding: RPC URL redaction handles only one `api-key` query pattern. Generic endpoint credentials in URL userinfo, other query names, path segments, or error messages can reach logs/manifests. Use sanitized endpoint labels and centralized redaction. No actual exposed credential was found by the limited tracked-file scan; this is a code-path risk.

### 19. P2 — Scheduler recovery settings can prolong stale publication

Read-only inspection of `JIP38 Observatory Refresh`:

- Last run: 12 September 2026 at 20:00:01 Perth; last result: 1 (failed).
- Next scheduled run at inspection: 13 September at 02:00 Perth.
- MultipleInstances = 2 (IgnoreNew).
- ExecutionTimeLimit = PT72H.
- StartWhenAvailable = false.

IgnoreNew prevents overlapping runs of this scheduled task, which is a useful existing safeguard and narrows finding 7. It does not protect against a manual refresh. Combined with the 72-hour limit, a stuck run can suppress multiple scheduled updates. Missed starts are not configured for catch-up.

Fix: set a bounded end-to-end refresh timeout suited to the expected minutes-long snapshot/build/publish operation; add catch-up policy where appropriate, external freshness monitoring, and a documented failure response. Do not change discovery budgets and scheduled refresh budgets as if they were the same task. Enum reference: [Microsoft Task Scheduler policy](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_instances_policy).

### 20. P2 — Published conclusions and documentation exceed the implemented evidence

Locations: `FINDINGS.md` headline and absence claims, `README.md` completeness claims, `REGISTRY.tsv` verification descriptions, `ledger.mjs` runtime output.

The repository acknowledges that the indexed search misses substantial burn volume, but elsewhere calls it independent corroboration of absent programme burns. The tracker/raw scanner defects above further weaken absence and completeness claims. Heuristic size classifications are investigative priorities, not proof of programme attribution or exclusion. Historical treasury changes also do not establish that the changes were JTX fee revenue.

The official proposal supports the 80% JTX share and commitment of that share to buybacks/burns, including per-epoch reporting. It does not, by itself, establish a verified current burn total or prove a particular activation date from its publication timestamp. Link the primary proposal from the dashboard and label the dated operator assessment distinctly. Source: [official JIP-38 proposal](https://forum.jito.network/t/jip-38-confirm-jito-as-a-token-centric-network/973).

Fix: publish the actual evidence level, archive/link the dated basis for operator statements, and replace proof language until the corrected pipeline supports it. Keep the explicitly private `ASK-JITO.md` and research notes outside public deployment bundles. Its own text describes it as a private ask, so a repository-wide publication needs a separate content review.

## Evidence and coverage summary

| Area | Audit result |
| --- | --- |
| Root application modules | All reviewed; concrete data-integrity and coverage defects above |
| Existing offline tests | Passed in preceding audit; most tracker/RPC/failure paths were not covered |
| Source syntax | Every root .mjs module passed Node syntax checks |
| Claim archive integrity | All 7 manifest-referenced files exist; all hashes and byte counts match |
| Secret scan | 21 tracked working-tree files checked for selected API/private-key patterns; no matches; no values printed |
| Scheduler | Inspected successfully; last failure and recovery settings recorded above |
| Frontend | Preceding browser audit covers current rendering and malformed registry behavior; no new source changes |
| Proposal | Official text read; core share/commitment wording corroborated, current execution not independently established |
| Live hosting | Still not inspected or deployed; HTTP headers, public freshness, and rollback remain unverified |
| Historical chain completeness | Not rerun; no claim of exhaustive live reconstruction from these offline tests |
| Credentials/Git history | No secret store inspection or full historical secret scan; current-pattern scan is not a security guarantee |

## Revised Monday decision

**Still NO-GO for an independently verified, automatically maintained production burn monitor.** The expanded audit finds that the deeper evidence pipeline cannot yet support that description.

The shortest credible route is a deliberately dated research snapshot: prominently separate operator assessment from chain measurements, make unknown states honest, fix fail-open reads and rendering validation, and prove publishing/freshness/recovery. Keep tracker/raw/indexed outputs out of release decisions until their correctness defects are repaired. A full monitoring launch additionally needs coverage-aware scanning, exact arithmetic, validated attribution, persistent incremental checkpoints, and regression tests for the reproductions saved here.

No fixes, production publication, live chain refresh, or scheduler changes were performed during this expanded audit. Only audit artifacts were added/updated.
