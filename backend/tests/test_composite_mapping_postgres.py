"""Additive mapping-note migration and identity compatibility on PostgreSQL."""

import copy
from pathlib import Path

from alembic import command
from alembic.config import Config
from alerts import storage
from alerts.composite_center import mapping_report
from alerts.composite_definitions import first_use, save_mapping
from alerts.composite_matching import MappingDraft, check_match
from alerts.config import settings
from alerts.storage import CompositeRevision, RealtimeMapping, RealtimeMappingNote
from sqlalchemy import inspect, select, text
from sqlalchemy.orm import sessionmaker
from test_chart_alert_postgres import postgres_alerts as postgres_alerts
from test_composite_definitions import PROOF, prepare, publish
from test_market_contracts import identity


def test_mapping_notes_upgrade_preserves_existing_mapping_and_composite(postgres_alerts, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    monkeypatch.setattr(settings, "database_url", postgres_alerts.url.render_as_string(hide_password=False))
    # The fixture publisher uses the current history worker, which requires
    # the later period tables. Isolate the mapping-note upgrade on that shape;
    # the real pre-period schema upgrade has its own history-modes PG contract.
    command.upgrade(config, "head")
    # Some fresh-install migrations use current metadata. Model the actual
    # deployed pre-ax51 table set rather than accidentally testing create_all.
    with postgres_alerts.begin() as connection:
        connection.execute(text("DROP TABLE IF EXISTS market_realtime_mapping_notes"))
    command.stamp(config, "aw50_notice_center")
    factory = sessionmaker(postgres_alerts, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    monkeypatch.setattr(settings, "fx_source", "dukascopy")
    catalog_id = prepare(factory, monkeypatch)
    publish(factory)
    with factory.begin() as db:
        mapping = save_mapping(db, identity().key, catalog_id, PROOF)
        composite = first_use(db, identity().key, mapping.id)
        revision = db.get(CompositeRevision, composite.active_revision_id)
        mapping_id, match = mapping.id, copy.deepcopy(mapping.match)
        composite_id, revision_id = composite.id, revision.id
        history, seam = revision.history_version_id, revision.seam
    before = set(inspect(postgres_alerts).get_table_names())
    command.upgrade(config, "head")
    command.upgrade(config, "head")
    assert set(inspect(postgres_alerts).get_table_names()) - before == {"market_realtime_mapping_notes"}
    with factory.begin() as db:
        checked = check_match(db, identity().key, catalog_id)
        draft = MappingDraft.model_validate({**checked["suggestion"], "rationale": "兼容迁移备注"})
        saved = save_mapping(db, identity().key, catalog_id, draft, snapshot=checked["snapshot"])
        assert saved.id == mapping_id and saved.match == match
        assert first_use(db, identity().key, saved.id).id == composite_id
        fixed = db.get(CompositeRevision, revision_id)
        assert (fixed.history_version_id, fixed.seam, fixed.mapping_id) == (history, seam, mapping_id)
        assert mapping_report(db, saved)["note"]["rationale"] == "兼容迁移备注"
        assert db.scalar(select(RealtimeMappingNote)).version == 1
    with postgres_alerts.connect() as connection:
        # Old application columns and foreign-key references remain readable;
        # application rollback retains this additive table and its contents.
        assert connection.execute(text("SELECT id, match FROM market_realtime_mappings WHERE id=:id"),
            {"id": mapping_id}).one() == (mapping_id, match)
        assert connection.execute(text("SELECT count(*) FROM market_realtime_mapping_notes")).scalar_one() == 1
    with factory() as db:
        assert db.get(RealtimeMapping, mapping_id).match == match
