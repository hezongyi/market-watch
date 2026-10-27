# Stage 1: Managed Realtime Switch

Branch: `refactor/managed-realtime-switch-20261027`, based on stage 1 boundary commit `210083f632e1c24f2f6c30c77332c0e627da6d5b`.

This F1 slice implements per-instrument managed real-time configuration and executable composite eligibility. It does not start the five/six-service topology, migrate workers, or complete stage 1 as a whole.

## Behavior

- Persist explicit enable/disable in the existing `Preference` table, keyed by managed instrument. The setting is separate from fixed-history authorization and immutable source revision identity.
- On startup, snapshot an initial value once for registered datasets that have no explicit choice. Preserve a previously enabled instrument; otherwise require a valid composite mapping plus an unexpired chart lease or active composite alert. Pure history and new registered datasets default off. Expiring a lease does not rewrite the stored choice. Explicit user choice wins.
- A history-maintenance join preserves the saved choice or the existing legacy instrument state. It never turns on real-time merely because the user requested history. Turning real-time off does not stop history maintenance, invalidate published history, or create new live work.
- OANDA resident datasets are acquired only while their own persisted live choice is enabled, or while an enabled composite consumer references the exact target. Turning the associated managed instrument off removes those live targets. A direct provider-chart demand remains independent of managed switches and expires with its existing lease.
- Charts retain fixed/confirmed historical data while off and stop provisional-tail capture. Existing current prices are not presented as fresh live quotes while disabled.
- Composite alert creation, edit/copy through the shared binding, resume/restart/rebaseline, and capability discovery require the switch enabled, a fresh live observation, completed fixed-history seam preparation, a published rule-period artifact, and aggregation caught up to the preparation input revision.
- An evaluator pauses an active rule once when its switch is off or its source is stale during a known open session. Re-enabling does not resume it; an explicit lifecycle action revalidates source and seam readiness. Known closed sessions do not trigger a stale pause. REST candle sampling uses its own fresh receive clock and does not require a quote.
- Import scheduling excludes disabled priority-0 real-time repairs without letting those jobs starve history-only work.

## Verification

- Local Ubuntu Docker, tests mounted read-only; Python dependency image: `sha256:995534fb1c8238b5a71f2155017bafe439000c6f0cb78708f17471d2c6542743`.
- Final SQLite-focused contracts and compatibility regressions: **234 passed** across `test_realtime_switch.py`, `test_composite_alerts.py`, `test_chart_alert_capabilities.py`, `test_market_data.py`, `test_market_collection_routing.py`, `test_managed_dataset.py`, `test_market_usage.py`, `test_series_access.py`, `test_composite_quotes.py`, `test_live_pricing.py`, and `test_oanda_recovery.py`.
- Isolated PostgreSQL tests use task-owned internal network `mw-runtime-switch-20261027_default`, container `mw-runtime-switch-20261027-postgres-1`, PostgreSQL `14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872`, one CPU/768 MiB. Synthetic database is tmpfs, with unique per-test schemas, no host port and no external network. Test client limit is one CPU/1024 MiB. Other task/acceptance containers were left running.
- Final PostgreSQL switch + composite alert + OANDA recovery run: **48 passed**. The fixtures explicitly set persisted resident enablement, matching production's user-controlled acquisition contract. The two earlier failures were caused by fixtures that assumed resident configuration itself enabled collection; they were updated to establish the legacy enabled state explicitly.
- A broad backend run without `TEST_POSTGRES_URL` ended with **2436 passed, 9 failed, 661 skipped, 38 setup errors**. Setup errors are PostgreSQL fixtures requiring `TEST_POSTGRES_URL`; this run is not stage evidence. Targeted suites with the isolated PG are authoritative for this F1 change.
- Ruff on all changed Python files and `git diff --check` pass. The final suite preserves unbound direct provider-browser leases while applying managed switches to resident and composite demand.
- No production or persistent application database was accessed. No real OANDA calls, notification delivery, schema migration, deployment, merge, tag, or permanent data deletion occurred.

## Open Gates

- Obtain final independent Standards and Spec review against the submitted commit and resolve findings.
- Push the branch, open/update its Draft PR against `refactor/runtime-alert-boundaries-20261027`, and verify CI on the final SHA.
- Stage 1 also includes existing boundary PR #102 and remaining stage 1 acceptance evidence; only after both slices pass their gates may stage 2 start.
