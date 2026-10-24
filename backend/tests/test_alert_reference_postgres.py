"""Alert UI compatibility on an explicitly supplied, isolated PostgreSQL."""
import os

import pytest
from test_chart_alert_api import (
    test_create_edit_conflict_and_event_confirmation_via_authenticated_http as http_contract,
)
from test_chart_alert_api import (
    test_reference_identity_and_log_cleanup_preserve_frozen_evidence_and_phone_state as cleanup_contract,
)

pytest_plugins = ["test_provider_postgres"]

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated PostgreSQL"
)


@pytest.mark.parametrize("contract", [http_contract, cleanup_contract], ids=["http", "cleanup"])
def test_alert_reference_postgres_contracts(provider_pg, monkeypatch, contract):
    factory, engine = provider_pg
    from alerts import storage

    monkeypatch.setattr(storage.settings, "fx_source", "dukascopy")
    storage.bootstrap(engine)
    contract(factory, monkeypatch)
    # Discard pooled connections: persisted notice/ack semantics survive reopening.
    engine.dispose()
    from alerts import notification_center as center
    from alerts.storage import NoticeEvent, Notification, Outbox, SignalRow
    from sqlalchemy import select

    with factory() as db:
        assert db.scalar(select(SignalRow)) is not None
        if contract is cleanup_contract:
            notice = db.scalar(select(NoticeEvent))
            assert notice.viewed_at and notice.handled_at
            assert db.scalar(select(Notification)).ack_at is None
            assert db.scalar(select(Outbox)).status == "pending"
            assert center.list_events(db, center.SUBJECT, {})["alert_unread"] == 0
