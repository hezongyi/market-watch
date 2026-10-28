# Stage 5: Joint Runtime Acceptance

Date: 2026-10-28. Candidate branch: `refactor/runtime-deployment-stage4-20261028`. Candidate commit during this run: `0e669c4e`; follow-up test correction is included in the next branch commit.

## Results

- Five-service market runtime with API offline, synthetic crossing input, restart recovery, role fencing, and unique signal/notification/outbox results: passed in [`stage-2-network-acceptance.md`](stage-2-network-acceptance.md) and its `five-service-network-*` evidence. The test used the five-service topology with the alert loop embedded in market-runtime.
- Stage 3A data runtime PostgreSQL contracts: **153 passed**, 20 Alembic deprecation warnings, 268.28 seconds. Run on 2026-10-28 in the fresh internal-only Compose project `mw-runtime-stage5-data-20261028`, PostgreSQL 14.24, against this worktree. The suite exercised API/managed queries, provider/data workers, history recovery and artifacts, market stream lifecycle, aggregate ownership, and chart-alert contracts.
- Stage 3B notification PostgreSQL contracts: **17 passed**, 23 Alembic deprecation warnings, 23.86 seconds. Run on 2026-10-28 in fresh internal-only Compose project `mw-runtime-stage5-notifications-20261028`, PostgreSQL 14.24, against this worktree. Delivery used an HTTP stub; no external topic was used.
- Stage 3A browser acceptance: actual Chromium, authorized chart widget, supplier/composite callbacks, reset and HTTP history reload, reconnect, switch, generation fencing, and cancellation passed per [`stage-3a-sse-acceptance.md`](stage-3a-sse-acceptance.md). Its market/history data came from deterministic local fixtures.
- Stage 4 candidate startup, migration, API-offline progress/recovery, web/API health, preflight conflict policy, and isolated legacy rollback simulation passed per [`stage-4-preflight-acceptance.md`](stage-4-preflight-acceptance.md). The old ORM inserted, read, and updated one temporary notification row on `az53`; the row was deleted afterward. Old Alembic cannot resolve `az53`, so rollback must bypass the old migration command.
- Current five-service candidate was restored after rollback testing: API `/readyz` 200, web HTTP 200, PostgreSQL healthy, all three ownership roles idle on fresh boot IDs, and preflight returned 0 for the stopped legacy simulation. No production or unrelated acceptance project was touched.

## Test correction

The full stage 3A rerun first exposed a wall-clock-boundary assumption in `test_managed_quotes_with_history_plan_deliver_confirmed_updates`: it created the previous minute's confirmed bar, then asserted no changed input after a four-minute suite elapsed. `Calculator._signal` includes the current minute in the input signature, so crossing the minute boundary correctly produced a new result. The test now freezes the worker clock inside the same minute. Its PostgreSQL wrapper passes pytest's `monkeypatch` only to contracts that declare it. The focused PostgreSQL wrapper group passed **6/6**, and the complete data suite then passed **153/153**. No production code changed.

## Limits and remaining acceptance

- Existing evidence is a joined review of phase-specific contracts, not one end-to-end run with real external market credentials, an actual browser connected to the deployed five-service candidate, and a phone receiving a notification. Historical documented performance measurements include the fixed approximately 1-second ATR visible-to-decision threshold deviation; that remains a separate follow-up per user decision and is not converted to a pass here.
- No real ntfy topic or handset was used. Stage 3B covers durable Outbox behavior and HTTP-stub acceptance. A17a production-channel acceptance and A17b device receipt/click/acknowledgement remain separate authorized acceptance items.
- The provider-disabled stage-4 fixture reports chart-history degraded by design. It does not establish live provider health or provider SLA.
- The old image cannot execute Alembic against `az53`. Application rollback requires a reviewed command path that omits old migration; it must not downgrade schema or overwrite the task database. Basic old notification-table writes passed, but every legacy business write path was not exercised.
- This record does not sign off A08/A09 long-run capacity, real supplier behavior, phone delivery, production inventory, or production deployment. It is not a production release approval.
