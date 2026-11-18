"""The runtime push policy and exact records against an isolated PostgreSQL schema."""
import os

import pytest
from test_notification_noise import (
    test_backfill_imports_old_system_records_without_network as test_backfill_imports_old_system_records_without_network,
)
from test_notification_noise import (
    test_each_system_notification_links_to_its_own_record as test_each_system_notification_links_to_its_own_record,
)
from test_notification_noise import (
    test_fifteen_second_runtime_blip_never_pushes as test_fifteen_second_runtime_blip_never_pushes,
)
from test_notification_noise import (
    test_legacy_queued_runtime_summary_is_not_replayed as test_legacy_queued_runtime_summary_is_not_replayed,
)
from test_notification_noise import (
    test_new_failure_episode_restarts_the_full_delay as test_new_failure_episode_restarts_the_full_delay,
)
from test_notification_noise import (
    test_night_fault_is_deferred_but_recovered_fault_is_not_sent_in_morning as test_night_fault_is_deferred_but_recovered_fault_is_not_sent_in_morning,
)
from test_notification_noise import (
    test_night_fault_still_active_in_morning_can_push as test_night_fault_still_active_in_morning_can_push,
)
from test_notification_noise import (
    test_persistent_fault_waits_three_minutes_then_pushes_once as test_persistent_fault_waits_three_minutes_then_pushes_once,
)
from test_notification_noise import (
    test_recovered_before_delivery_never_replays_old_fault_or_recovery as test_recovered_before_delivery_never_replays_old_fault_or_recovery,
)
from test_notification_noise import (
    test_recovery_during_send_preserves_resolution_and_receipt as test_recovery_during_send_preserves_resolution_and_receipt,
)
from test_notification_noise import (
    test_recovery_for_an_unpushed_fault_is_always_log_only as test_recovery_for_an_unpushed_fault_is_always_log_only,
)
from test_notification_noise import (
    test_recovery_push_after_accepted_fault_is_low_priority as test_recovery_push_after_accepted_fault_is_low_priority,
)
from test_notification_noise import (
    test_send_rechecks_heartbeat_even_before_next_health_inspection as test_send_rechecks_heartbeat_even_before_next_health_inspection,
)
from test_notification_noise import (
    test_system_detail_unknown_id_does_not_return_another_message as test_system_detail_unknown_id_does_not_return_another_message,
)
from test_notification_noise import (
    test_system_push_does_not_inherit_urgent_price_alert_priority as test_system_push_does_not_inherit_urgent_price_alert_priority,
)
from test_notification_noise import (
    test_system_quiet_can_be_disabled_without_changing_price_priority as test_system_quiet_can_be_disabled_without_changing_price_priority,
)
from test_notification_noise import (
    test_system_records_exact_source_and_delivery_without_popup_or_ack as test_system_records_exact_source_and_delivery_without_popup_or_ack,
)
from test_runtime_incident_postgres import incident_pg as incident_pg

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                                reason="Requires isolated Ubuntu PostgreSQL")


@pytest.fixture
def database(incident_pg):
    return incident_pg[0]
