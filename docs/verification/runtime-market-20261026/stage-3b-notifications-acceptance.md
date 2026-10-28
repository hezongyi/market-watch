# Stage 3B: Notification Runtime Acceptance

Date: 2026-10-28. This record covers the notification runtime slice only. It does not sign off the complete five-service deployment, stage 4/5, production release, or mobile-device acceptance.

## Runtime and behavior

- The default and production Compose templates now use the five application services `web`, `api`, `market-runtime`, `data-worker`, and `notification-worker`. The notification process runs `alerts.runtime --profile notifications`, depends on completed migrations, and does not depend on API health.
- The supervised notification profile owns separate projection, retention, delivery, health-inspection, and ownership loops. Test messages enter the shared durable Outbox and can be claimed while automatic signal delivery is disabled. System fault and recovery notices use the same Outbox, with incident state persisted for deduplication and a 15-minute reminder limit.
- Signal delivery retains current-signal eligibility, quiet hours, attempt-scoped acknowledgement grants, leases, retry behavior, and uncertain provider receipt semantics. Test acknowledgements use durable hashed credentials and stop the related Outbox item.
- Additive migration `az53_notification_outbox_types` keeps existing notifications as `kind=signal` with an empty payload and allows null signal IDs for system/test notifications. The schema downgrade is intentionally refused; application rollback and the verified backup path remain the recovery method.

## Verification

- Local notification, notice, API test-message, runtime-supervisor, migration, and migration-path regression: **90 passed, 1 skipped**. Ruff and `git diff --check` passed.
- Ubuntu local Docker isolated task/project: `mw-runtime-notifications-stage3b-20261028`; internal network and dedicated PostgreSQL 14.24 volume, no host port. The contract container mounted this worktree read-only. PostgreSQL migration, ChartAlert concurrency, notice projection, and test-Outbox delivery contracts: **17 passed**. The Outbox test had automatic delivery disabled and sent only through an HTTP stub.
- Host: Ubuntu local Docker (`/var/run/docker.sock`). Accessible address: not applicable; all task services use the private Compose network and publish no host ports. Compose file: `deploy/ubuntu/runtime-notifications-stage3b.contracts.yaml`, run from `deploy/ubuntu` with project `mw-runtime-notifications-stage3b-20261028`. Start: `MW_RUNTIME_NOTIFICATIONS_STAGE3B_REPO=/home/quant/repos/market-watch-runtime-notifications-stage3b-20261028 docker compose -p mw-runtime-notifications-stage3b-20261028 -f runtime-notifications-stage3b.contracts.yaml up -d postgres notification-runtime`. Stop: `docker compose -p mw-runtime-notifications-stage3b-20261028 -f runtime-notifications-stage3b.contracts.yaml stop notification-runtime postgres`.
- The standalone notification profile started against that task database with API and data-worker absent; all five notification role heartbeats reached `idle`. A controlled PostgreSQL restart interrupted the held owner connection and the profile exited nonzero, then restarted cleanly after PostgreSQL was healthy. A separate SIGTERM stop exited with code 0 and no OOM.
- Default and production Compose templates render one `notification-worker`, no `notify-worker` or `notification-projector`; production template still sets Yahoo enabled for all backend services.

## Limits

- No real ntfy topic or handset was used. A17a production-channel credentials and A17b device receipt/click/acknowledgement remain for their authorized acceptance step; stub delivery and persistence are covered here.
- The Outbox contract demonstrates processing without API/data owners, while the profile smoke demonstrates those services are not runtime dependencies. This slice does not claim the full A10/A16/A17a cross-service failure matrix or stage 5 completion.
- PR #109 is the stacked base and its backend CI was still running when this record was prepared; the user had authorized continuing the next stage without waiting for that result.
- No merge to main, formal tag, production access, or production deployment was performed.
