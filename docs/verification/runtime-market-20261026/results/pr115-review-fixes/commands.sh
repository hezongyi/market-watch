#!/usr/bin/env bash
set -euo pipefail
cd /home/quant/repos/market-watch-runtime-track-c-20261028
compose=(docker compose -p mw-track-c-20261028 -f deploy/ubuntu/runtime-track-c.acceptance.yaml)
pg_test=(-e TEST_POSTGRES_URL=postgresql+psycopg://track_c:track_c_acceptance_only@postgres/track_c_acceptance)
"${compose[@]}" run --rm --no-deps -T "${pg_test[@]}" data-worker python -m pytest -q -p no:cacheprovider \
  backend/tests/test_track_c_review_fixes.py backend/tests/test_track_c_review_fixes_postgres.py \
  backend/tests/test_retention_window.py backend/tests/test_retention_window_postgres.py \
  backend/tests/test_switch_activation.py backend/tests/test_switch_activation_postgres.py \
  backend/tests/test_baseline_shadow.py backend/tests/test_baseline_shadow_postgres.py \
  backend/tests/test_switch_schedule.py backend/tests/test_switch_runs.py \
  backend/tests/test_composite_preparation.py backend/tests/test_composite_revisions.py \
  backend/tests/test_composite_chart.py backend/tests/test_composite_alerts.py \
  backend/tests/test_composite_realtime.py backend/tests/test_live_pricing.py \
  backend/tests/test_confirmed_minutes.py backend/tests/test_composite_recheck.py \
  backend/tests/test_fixed_indicators.py backend/tests/test_source_history_store.py \
  backend/tests/test_source_history_store_postgres.py backend/tests/test_chart_revision_demand_migration.py \
  backend/tests/test_publication_migration_postgres.py
"${compose[@]}" run --rm --no-deps -T "${pg_test[@]}" data-worker python -m pytest -q -p no:cacheprovider \
  backend/tests/test_composite_series.py backend/tests/test_fixed_series_revisions.py \
  backend/tests/test_observed_indicators.py backend/tests/test_chart_alert_offsets.py \
  backend/tests/test_confirmed_minutes_postgres.py backend/tests/test_composite_aggregates.py \
  backend/tests/test_fixed_indicator_display.py backend/tests/test_chart_reload_diagnosis.py \
  backend/tests/test_live_pricing_migration.py
"${compose[@]}" --profile maintenance run --rm --no-deps -T "${pg_test[@]}" \
  -e TEST_POSTGRES_BIN_DIR=/opt/pgbin/bin backup python -m pytest -q -p no:cacheprovider backend/tests/test_backup.py
