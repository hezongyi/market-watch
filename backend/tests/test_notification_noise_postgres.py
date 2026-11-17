"""The runtime push policy and exact records against an isolated PostgreSQL schema."""
import os
import pytest
from test_runtime_incident_postgres import incident_pg
from test_notification_noise import (
    test_fifteen_second_runtime_blip_never_pushes,
    test_system_push_does_not_inherit_urgent_price_alert_priority,
    test_each_system_notification_links_to_its_own_record,
    test_persistent_fault_waits_three_minutes_then_pushes_once,
    test_recovered_before_delivery_never_replays_old_fault_or_recovery,
    test_new_failure_episode_restarts_the_full_delay,
    test_night_fault_is_deferred_but_recovered_fault_is_not_sent_in_morning,
    test_night_fault_still_active_in_morning_can_push,
    test_send_rechecks_heartbeat_even_before_next_health_inspection,
    test_system_records_exact_source_and_delivery_without_popup_or_ack,
    test_backfill_imports_old_system_records_without_network,
    test_legacy_queued_runtime_summary_is_not_replayed,
    test_recovery_during_send_preserves_resolution_and_receipt,
    test_system_quiet_can_be_disabled_without_changing_price_priority,
    test_recovery_for_an_unpushed_fault_is_always_log_only,
    test_recovery_push_after_accepted_fault_is_low_priority,
    test_system_detail_unknown_id_does_not_return_another_message,
)

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                                reason="Requires isolated Ubuntu PostgreSQL")


@pytest.fixture
def database(incident_pg):
    return incident_pg[0]
