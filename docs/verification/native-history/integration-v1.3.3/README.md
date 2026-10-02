# Native history and v1.3.3 source integration

The isolated review branch integrates native history`efe0ba4` with current main
`dd9ba43`(Volume PR#1/v1.3.3). One provider-cache conflict was resolved by keeping
bars, revisions and Volume source metadata in the same SQL statement. Two new
source regressions prove both providers' buffered exact quantities/zero/null
and volume-only correction revalidation.

Independent integration review found two correctness blockers beyond the
accepted Binance network limitation: optional prewarm activation could wait
for a row lock or second pool checkout after valid bars were ready, and expired
or cancelled owners could not release leases. Six deterministic regressions
reproduced those failures. Final ready activation now reuses the snapshot's
session/connection inside a SAVEPOINT; request budget and1ms PGlock timeout
isolate contention. Normal administrative activation remains serialized, uses
mandatoryD+H, and retains generation/task_id CAS. Provider HTTP remains outside
all snapshot transactions. Lease cleanup independently uses one atomic
id/token/generation-fenced UPDATE with250ms PGstatement timeout. Pool checkout
retains the configured existing bound; expected contention falls back to normal
lease expiry without retries.

Final integrated source: **395passed,1skipped** in disposable PostgreSQL17.11,
including concurrency, snapshot, lease/rollback, native demand and Volume tests.
The fixture was stopped. Runtime/test inputs are hashed in
`final-source-hashes.json`; `backend-final.txt` is the final full-suite evidence.
**40 non-browser Node scripts and TypeScript/Vite build passed**; frontend and
build inputs did not change during backend lifecycle fixes.

Initial setup failures are retained: worktree-local `.venv/bin/alembic` and
Python paths were missing; linking the existing environment fixed them without
product changes. The initial frontend runner accidentally included the browser
entry`advanced-browser.cjs`; its missing shared-library launch failure is kept,
not described as a product browser run. Earlier388+1 migration passes and the
intermediate141 affected passes remain distinct from final source verification.

All229 original native-history evidence hashes match. The user decision still
accepts delivery while the strict checker remains red for Binance cold4/10 and
PG7/10; 503s and PG misses retain their original denominators and provenance.
No network investigation or new performance cohort was performed.

This is source integration verification, not fresh combined-image/browser
acceptance. Existing native-history and Volume image/browser manifests retain
their original commit sources. No runtime, production, original feature branch
or main checkout was changed; no push, PR, tag or remote merge was performed.
Final two-axis review and scope are in`review-results.md` and`checks.json`.
