# Native history and v1.3.3 source integration

The isolated review branch merges native history `efe0ba4` with current main
`dd9ba43` (Volume PR #1 / v1.3.3). One provider-cache snapshot conflict was
resolved by keeping bars, revisions and Volume source metadata in one SQL
statement. The other three jointly changed files were automatically merged;
source review must inspect their combined behavior.

Two new source regressions cover OANDA/Binance buffered quantities, exact
Decimal strings, zero/null, and volume-only correction revalidation. In a fresh
PG17 fixture the first full run passed388 and skipped1; one migration test
failed because the new worktree lacked its `.venv/bin/alembic` path. Linking the
existing virtual environment fixed that setup; the same failed test then passed.
The final unique result is389 passed,1 skipped, with both logs retained.

All40 non-browser Node scripts and TypeScript/Vite build passed. The initial
runner accidentally included `advanced-browser.cjs`, which failed to launch
without its shared-library setup; that attempt is retained separately and does
not represent a product browser run. The managed-revision script also passed
once the worktree-local Python path was available. No product change fixed
these setup failures.

The229 original native-history evidence hashes match. The bound user decision
still accepts delivery while the strict checker remains red for Binance
cold4/10 and PG7/10. This integration does not reclassify those results and does
not investigate the accepted network blocker.

These are source integration checks, not fresh combined-image acceptance.
Existing browser/image manifests retain their original commit provenance. No
runtime or production service was changed. Machine-readable scope and results
are in `checks.json`; source review is recorded separately.
