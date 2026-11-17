# Runtime notification noise and exact records

## Scope and evidence

F1: changes background notification delivery policy and source projection. No schema
or persisted-format migration; existing rule conditions, user acknowledgements,
transport credentials and price-alert delivery preferences remain intact.

The development instance had FXCM heartbeat fault/recovery pairs only 15–45 seconds
apart. Runtime notifications inherited priority 5, with quiet hours disabled by
default. All system messages linked to the same category; system Notification rows
were not projected into the event history at all.

Before fixing, `test_notification_noise.py` reproduced all three symptoms:
two transport requests for a 15-second blip, priority 5, and identical click URLs.

## Resulting behavior

- Persist each observed failure/recovery for diagnosis. Delay runtime-fault pushes
  by 180 seconds and send at most once per continuous failure episode. Reset the
  episode start when a new failure follows recovery.
- Before sending/retrying, verify the same episode is active and the underlying
  heartbeat is still faulty. Suppress obsolete legacy runtime summaries, honor
  maintenance windows, and omit recovered roles from the outgoing summary.
- System notifications use priority at most 3; recovery uses at most 2. Price
  signals retain their existing priority and quiet-hours choice.
- Runtime/system quiet hours default on, using the existing timezone and time
  range (defaults Asia/Shanghai, 23:00–07:00). Recheck a deferred fault in the
  morning. Recoveries for unpushed faults are log-only; nighttime recoveries and
  recovery information older than five minutes are never replayed later.
- Exact system notification records include the original time, message, delivery
  attempts, resolution and explicit acknowledgement separately. Reliable source
  hooks and bounded historical backfill feed the existing event history without
  creating web popups or sounds.
- Use a typed `n_` + 32-hex notification reference inside the existing APK v1
  opaque-ID route. No new APK is needed. Opening only reads; explicit confirmation
  records acknowledgement. Old messages already sent without an ID cannot be
  retroactively assigned an exact destination.
- Mobile notification settings expose the runtime quiet switch; saved price-alert
  policy is preserved. System details show one acknowledgement action rather than
  an additional, ambiguous "handled" operation.

## Verification

109 passed, 1 optional test skipped:

```sh
PYTHONPATH=backend .venv/bin/python -m pytest -q \
  backend/tests/test_notification_noise.py \
  backend/tests/test_notification_runtime.py \
  backend/tests/test_runtime_incidents.py backend/tests/test_notify.py \
  backend/tests/test_notification_center.py \
  backend/tests/test_chart_alert_notifications.py \
  backend/tests/test_notification_test.py backend/tests/test_notification_transport.py \
  backend/tests/test_price_alert_reliability.py
```

29 passed on a task-owned disposable PostgreSQL database in Ubuntu Docker:

```sh
# Both environment variables point to the same isolated test database.
PYTHONPATH=backend .venv/bin/python -m pytest -q \
  backend/tests/test_notification_noise_postgres.py \
  backend/tests/test_runtime_incident_postgres.py \
  backend/tests/test_notification_center_postgres.py \
  backend/tests/test_notification_outbox_postgres.py
```

The test database was removed after the run. Mock transports only; no real phone
notifications, acknowledgements, rules or watchlists were created for testing.

`npm run build` and `node tests/mobile-notification-link.browser.cjs` pass. Browser
coverage includes login, repeated entry, dirty-form protection, exact system and
signal records, failed-detail retry, quiet switch, explicit acknowledgement,
375px light/150% type and 412px dark screenshots. Browser verification is not an
Android handset receipt test.

## Deployment boundary

Ubuntu persistent `mw-dev`, public entry `https://quant.kookvv.com:8443/m/`.
Operate with `mw-dev up`, `mw-dev stop`, `mw-dev status`.
Replace only API, notification-worker and Web; preserve other services and the
APK download mount. Pre-task API source was compared with baseline `dd7adf46`
and matched exactly. Private deployment evidence retains the immutable image IDs,
config snapshot and rollback instructions. Rollback changes only those three
service image references, then uses Compose `up -d --no-build --no-deps`.
