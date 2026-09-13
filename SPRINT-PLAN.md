# Production hardening sprint

Target: update the existing Claude Artifact at https://claude.ai/code/artifact/a6f040d8-e252-4f10-825b-f5c640b5e107.

Railway is a subsequent deployment phase after the user is satisfied with the artifact. No new artifact, Railway service, domain change, or Railway deployment belongs to this sprint. Preserve a portable static HTML output and keep credentials and collection work outside the page.

Requested launch: Monday, 14 September 2026, Australia/Perth. This is a target, not a promise to bypass release gates. All 20 audit findings remain in scope. Technical correctness can be fixed in code; fresh source access and historical completeness require evidence and must never be fabricated to meet the date.

## Working agreement

- Implement fixes and meaningful regression tests, rather than stopping at an audit or a cosmetic pass.
- Preserve existing uncommitted user work and archived evidence. Do not rewrite historical observations to appear corrected.
- Keep a dated assessment distinct from new chain observations. Unknown is a valid result; falsely reporting zero is not.
- Update the existing Artifact using its pinned URL. A successful local build or CLI message is not deployment proof.
- Report blocked external dependencies early while continuing independent work.
- Do not call an audit item resolved until its acceptance test passes; record evidence alongside the item.

## Ordered backlog

All items below start as TODO. Each ticket includes implementation, regression tests, and verification evidence.

| Ticket | Audit findings | Work | Acceptance evidence |
| --- | --- | --- | --- |
| S01 — Regression baseline | All | Convert audit reproductions into tests asserting desired behavior; retain fixture provenance; establish one offline check command and a supported Node version. | Failures reproduce before fixes; each corrected behavior subsequently passes; baseline checks remain green. |
| S02 — Input and RPC contract | 2, 4, 6, 17 | Validate RPC configuration and CLI arguments; fix token-bucket batch capacity; distinguish missing accounts from failed calls; preserve commitment/context slots; validate registry rows and required roles; clip density integration. | Batches 8/9/10/11 complete; invalid arguments fail before writes; partial RPC reads cannot publish facts; timestamp/context tests pass. |
| S03 — Snapshot and arithmetic | 1, 5, 16 | Introduce a versioned snapshot contract, raw integer token amounts, one ratio definition and documented USD valuation basis; distinct observed/claimed/assessed timestamps and coverage state. | Schema and arithmetic tests cover nonzero, zero, missing, negative, malformed, and stale inputs. A fresh balance does not renew an old burn assessment. |
| S04 — Verifier and token identity | 10, 11 | Require expected account owners and mint identity; fail closed on unavailable required reads; identify unchecked token operations through transaction context; validate metadata structurally. | Wrong owners, failed mint reads, empty registries, and unrelated-token transactions are rejected or explicitly unresolved. |
| S05 — Scan correctness | 9, 12, 13, 14 | Pin scan boundaries; preserve instruction identity; reject failed execution; persist unresolved signatures; count requested/resolved/failed/excluded work separately. | Boundary fixtures have no gaps, repeated retrievals dedupe correctly, equal distinct burns survive, and unresolved reads prevent completion claims. |
| S06 — Incremental tracking | 7, 15, 16 | Separate historical scans from incremental polling; persist head/tail cursors and retry queues; align supply comparisons with coverage; retain alerts until reviewed. | Resume discovers new activity and retries failures; interrupted and repeated runs do not lose or double-count events; unresolved alerts persist. |
| S07 — Evidence acquisition | 18, 20 | Validate captured metric schema, source timestamps, and completeness; explicitly import approved captures; maintain hashes; centralize URL/error redaction; correct unsupported claims. | Captured bytes round-trip and match manifests; wrong/stale responses cannot become current fee evidence; synthetic credentials are redacted. |
| S08 — Frontend completion | 5, 20 | Render the snapshot contract, freshness and review-required states; handle nested-data errors; expose source links and dates; finish accessibility, mobile, and download behavior. | Browser checks cover current, stale, partial, malformed, and alerted snapshots; no silent partial render; keyboard and responsive checks pass. |
| S09 — Reliable refresh | 7, 8, 19 | Atomic outputs, refresh locking, last-valid release retention, bounded end-to-end timeout, appropriate missed-start recovery, actionable failure reporting, and reproducible build documentation. | Interrupted/overlapping runs preserve valid output; failure is visible; backup restore and clean-checkout build are demonstrated. |
| S10 — Existing Artifact release | 3, 8 | Prove publisher authentication/tool availability; pin the existing URL; require publish evidence; verify served snapshot/release identity; retain a rollback payload. | The intended artifact displays the tested release; simulated publisher failure is detected; rollback is demonstrated or an explicit platform limitation is recorded as an open gate. |
| S11 — Release qualification | All | Run the complete offline suite, browser checks, artifact-host behavior checks, failure simulations, and one scheduled end-to-end refresh. | Evidence matrix has no unresolved P1/P2 audit defects; the published page and exported snapshot agree; no unsupported verification claims. |

## Dependencies and parallel work

S01 establishes the baseline. S02 and S03 establish shared contracts before scanner and frontend implementations depend on them. S04 and S05 feed S06. S07 can progress alongside those fixes, with S03 defining its output contract. S08 follows S03 and can proceed alongside tracking work. S09 can begin independently and integrate once the contracts stabilize.

Investigate S10 publisher availability early: the previous scheduled run failed due to Claude quota, and this Codex session does not expose a Claude Artifact publishing tool directly. Confirm the configured publisher route without mistaking tool absence here for proof that no publisher exists on the machine. End-to-end publishing verification is mandatory, and browser/platform restrictions may affect downloads or readback. Do not substitute a different host without the user's direction.

S11 begins only when its required tickets pass. Any regression sends the affected ticket back to active work.

## Target sequence

1. First implementation block: regression baseline, RPC/input validation, snapshot contract, exact arithmetic, and early publisher capability check.
2. Second block: verification, scanner correctness, incremental state, and validated evidence integration.
3. Third block: frontend states and accessibility, reliable refresh, and artifact publishing rehearsal.
4. Release block: qualification, update the existing Artifact, verify the served result, and observe the next scheduled refresh.

Prioritize by dependencies and findings rather than treating calendar slots as guaranteed estimates. If historical chain access or publisher availability is blocked, state exactly which acceptance gate remains open.

## Release gates

- All 20 audit findings mapped to completed tickets with verification evidence.
- No silent read loss, false zero defaults, unrelated-token attribution, or unsupported completeness claims.
- Validated evidence dates, exact token accounting, documented monetary valuation, and reproducible output.
- Missing or stale external evidence is clearly displayed and never presented as newly verified activity.
- Frontend remains usable under supported viewport, keyboard, error, and artifact-host conditions.
- Successful update of the existing Artifact, confirmed by the rendered release/snapshot identity.
- Demonstrated last-valid preservation, failure reporting, and rollback/recovery.
- First scheduled refresh after release checked explicitly.

## Later Railway phase

After artifact acceptance, choose the Railway service configuration, secrets, scheduler/worker arrangement, public serving directory, headers, and operational monitoring. Re-run host-specific security and deployment checks there; passing Artifact checks does not certify Railway. Do not introduce Railway-only infrastructure during this sprint merely to satisfy the earlier generic hosting audit finding.
