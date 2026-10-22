# Integration fix verification

Status: fixes committed; final PostgreSQL, browser, independent review and CI verification in progress. This file will record final results before merge readiness is reported.

Reviewed delivery: `c4086d1f4c01c28afb519cc45e58f5c87b7e9d62`.

- P1: both derived daily-close readers now require a complete confirmed closing M1 in the same immutable version/input revision. Interior coverage gaps do not alone invalidate a proven closing price. A missing terminal observation omits change fields while retaining the latest price.
- P2: selection validity and save use the same complete OANDA dataset identity. The check snapshot includes the target identity key, so a calendar-version change also invalidates an in-flight saved binding without mutating old identities.
- Changed-file Ruff imports corrected; browser title regression added to CI.
- New regressions were run before the fix: 7 failed, 2 passed. After the fix: the relevant 8 backend modules passed 87 tests; web build and mapping/title/tab regressions passed.
- Added PostgreSQL migration coverage for populated pre-ax51 mappings/composites, additive repeated upgrade, independent notes, and unchanged immutable references.

All implementation changes are in `integration/mwa-20261022`, worktree `/home/quant/repos/market-watch-integration-20261022`. Development delivery branch remains unchanged locally. No main merge, formal tag or production release is authorized by this work.
