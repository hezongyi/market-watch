"""Composite consumers share scoped OANDA demand and survive browser expiry."""

from alerts import live_pricing as live
from alerts.composite_definitions import first_use, save_mapping
from alerts.config import settings
from alerts.market_data import renew_demand
from alerts.storage import (
    ChartAlert,
    ChartAlertVersion,
    Instrument,
    MarketComposite,
    MarketDemand,
    Watch,
)
from sqlalchemy import func, select
from test_composite_definitions import PROOF, prepare, publish
from test_market_contracts import identity


def ready(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    monkeypatch.setattr(settings, "oanda_resident_symbols", "")
    publish(database)
    with database.begin() as db:
        mapping = save_mapping(db, identity().key, catalog, PROOF)
        composite = first_use(db, identity().key, mapping.id)
        from alerts.realtime_switch import set_enabled
        from alerts.storage import MarketDataset
        set_enabled(db, db.get(MarketDataset, identity().key).instrument_id, True, now=0)
        return composite.id, composite.instrument_id


def test_first_use_and_management_create_no_demand_but_actual_chart_renews_shared_target(database, monkeypatch):
    ident, ticker = ready(database, monkeypatch)
    assert live.desired_datasets(settings.oanda_account_id) == {}
    with database.begin() as db:
        renew_demand(db, "chart-one", db.get(Instrument, ticker))
        renew_demand(db, "chart-one", db.get(Instrument, ticker))
        renew_demand(db, "chart-two", db.get(Instrument, ticker))
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == 2
        assert db.get(MarketComposite, ident)
    desired = live.desired_datasets(settings.oanda_account_id)
    assert set(desired) == {"EUR_USD"}
    assert not live.desired_datasets("wrong-account")
    with database.begin() as db:
        for row in db.scalars(select(MarketDemand)):
            row.expires = 0
    assert not live.desired_datasets(settings.oanda_account_id)


def test_retired_watch_never_creates_persistent_demand(database, monkeypatch):
    _, ticker = ready(database, monkeypatch)
    with database.begin() as db:
        watch = Watch(instrument_id=ticker, name="persistent", status="active", rule={"timeframe": "M1"},
            state={}, armed_at=0)
        db.add(watch)
        db.flush()
        ident = watch.id
    assert not live.desired_datasets(settings.oanda_account_id)
    with database.begin() as db:
        db.get(Watch, ident).status = "paused"
    assert not live.desired_datasets(settings.oanda_account_id)


def test_current_chart_alert_version_and_expiry_own_persistent_demand(database, monkeypatch):
    _, ticker = ready(database, monkeypatch)
    with database.begin() as db:
        alert = ChartAlert(request_id="usage-test", request_hash="hash", name="persistent",
            effective_at=0, status="active", version=2)
        db.add(alert)
        db.flush()
        ident = alert.id
        db.add_all([ChartAlertVersion(alert_id=ident, version=1, config={"instrument": "unused"},
            market_identity={}, effective_at=0),
            ChartAlertVersion(alert_id=ident, version=2, config={"instrument": ticker},
            market_identity={}, effective_at=0)])
    assert set(live.desired_datasets(settings.oanda_account_id)) == {"EUR_USD"}
    with database.begin() as db:
        db.get(ChartAlert, ident).expires_at = 1
    assert not live.desired_datasets(settings.oanda_account_id)


def test_empty_residents_and_account_catalog_other_assets_idle_cleanly(database, monkeypatch):
    monkeypatch.setattr(settings, "oanda_resident_symbols", "")
    assert live.ensure_catalog([
        {"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5},
        {"name": "US30_USD", "type": "CFD", "displayPrecision": 1},
    ], "catalog-test") == ()
    assert not live.desired_datasets("catalog-test")
    with database.begin() as db:
        instrument = db.scalar(select(Instrument).where(Instrument.symbol == "US30_USD"))
        assert instrument and not instrument.enabled
        renew_demand(db, "index-chart", instrument)
        assert not db.scalar(select(MarketDemand).where(MarketDemand.instrument_id == instrument.id))
        from alerts.realtime_switch import set_enabled
        set_enabled(db, instrument.id, True, now=125000)
        renew_demand(db, "index-chart", instrument)
    assert set(live.desired_datasets("catalog-test")) == {"US30_USD"}


def switched_targets(database, monkeypatch):
    """Test revision-pinned demand independently from the production product allowlist."""
    from alerts import composite_matching
    from alerts.aggregation_policy import register_history_dataset
    from alerts.composite_revisions import activate, create
    from alerts.history_artifacts import artifact_tick
    from alerts.history_catalog import account_scope
    from alerts.history_versions import create_version, import_page
    from alerts.storage import MarketCatalog
    from test_composite_revisions import prepared
    from test_history_versions import Adapter
    from test_market_contracts import batch, minute

    monkeypatch.setattr(settings, "oanda_account_id", "synthetic-index-account")
    monkeypatch.setattr(settings, "oanda_token", "test-token")
    monkeypatch.setattr(settings, "oanda_resident_symbols", "")
    # These synthetic NASDAQ rows intentionally model an unlisted source pair.
    # Keep this lease/migration test focused on demand ownership; product-pair
    # admission has its own tests and must remain blocked in production.
    product_rule = composite_matching.product_rule

    def fixture_product_rule(historical, entry):
        if (historical.source == "dukascopy" and historical.provider_symbol == "USATECH.IDX/USD"
                and entry.symbol in ("NAS100_USD", "NAS100F_USD") and entry.asset_type == "INDEX"):
            return (
                {"underlying": "NASDAQ100", "quote_currency": "USD", "historical_product": "index",
                 "live_product": "cfd" if entry.symbol == "NAS100_USD" else "future",
                 "relationship": "same_underlying_different_product"},
                [{"url": "https://example.com/synthetic-index", "scope": "isolated test fixture only"}],
                None,
            )
        return product_rule(historical, entry)

    monkeypatch.setattr(composite_matching, "product_rule", fixture_product_rule)
    monkeypatch.setattr("alerts.composite_definitions.now_ms", lambda: 200010000)
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: 200010000)
    with database.begin() as db:
        dataset, _ = register_history_dataset(db, source="dukascopy", logical_symbol="NASDAQ100",
            provider_symbol="USATECH.IDX/USD", asset_class="index", precision=5, aggregation_calendar="ny17")
        dataset_id, source = dataset.id, dataset.identity
        for i, symbol in enumerate(("NAS100_USD", "NAS100F_USD")):
            db.add(MarketCatalog(id="HC:" + str(i) * 36, source="oanda", symbol=symbol,
                label="Synthetic NASDAQ index product", asset_type="INDEX", precision=5, calendar="ny17",
                metadata_json={"history_account_scope": account_scope()}))
        version = create_version(db, dataset_id, 0, 172920000)
    import_page(Adapter([batch(identity=source, window_end=172920000, checkpoint=172920000,
        rows=(minute(), minute(60000), minute(172800000), minute(172860000)))]), version_id=version)
    while artifact_tick(version):
        pass
    proof = {"underlying": "NASDAQ100", "quote_currency": "USD", "historical_product": "index",
        "live_product": "cfd", "relationship": "same_underlying_different_product",
        "historical_evidence": "https://example.com/synthetic-index",
        "live_evidence": "https://example.com/synthetic-cfd",
        "rationale": "Controlled contract fixture with explicit same underlying product relationship", "reviewed": True}
    with database.begin() as db:
        old_mapping = save_mapping(db, dataset_id, "HC:" + "0" * 36, proof)
        new_mapping = save_mapping(db, dataset_id, "HC:" + "1" * 36, {**proof, "live_product": "future"})
        composite = first_use(db, dataset_id, old_mapping.id)
        ident, instrument, old = composite.id, composite.instrument_id, composite.active_revision_id
        old_target, new_target = old_mapping.target_dataset_id, new_mapping.target_dataset_id
        new = create(db, ident, {"request_id": "replace-target", "expected_revision_id": old,
            "history_version_id": version, "mapping_id": new_mapping.id, "seam": 165600000,
            "reason": "显式更换同标的产品映射"}).id
    prepared(database, new)
    with database.begin() as db:
        activate(db, ident, new, {"request_id": "activate-target", "expected_revision_id": old})
    return ident, instrument, old, new, old_target, new_target


def test_pinned_chart_revision_leases_coexist_renew_and_expire_independently(database, monkeypatch):
    from alerts.chart_query import DataQuery
    from alerts.market_usage import composite_targets, wanted_instruments
    from alerts.series_access import chart_data

    ident, instrument, old, new, old_target, new_target = switched_targets(database, monkeypatch)
    from alerts.realtime_switch import set_enabled
    from alerts.storage import MarketDataset
    with database.begin() as db:
        set_enabled(db, db.get(MarketDataset, db.get(MarketComposite, ident).dataset_id).instrument_id,
            True, now=200010000)
    clock = [200010000]
    monkeypatch.setattr("alerts.market_data.now_ms", lambda: clock[0])
    monkeypatch.setattr("alerts.market_usage.now_ms", lambda: clock[0])

    def read(revision):
        with database.begin() as db:
            page = chart_data(db, DataQuery(instrument=ident, series_kind="composite", timeframe="M1",
                composite_revision_id=revision, client="two-panes", limit=3, provisional=False))
            assert page["revision_id"] == (revision or new)

    def targets():
        with database() as db:
            return composite_targets(db, wanted_instruments(db, now=clock[0]))

    read(old)
    assert targets() == {old_target}
    read(old)
    read(None)  # Bind the actual selected head for the second pane.
    assert targets() == {old_target, new_target}
    with database() as db:
        leases = list(db.scalars(select(MarketDemand)))
        assert len(leases) == 2
        assert {lease.composite_revision_id for lease in leases} == {old, new}
    clock[0] += 119999
    read(old)
    clock[0] += 1  # Head lease expires at its boundary; old pane renewed independently.
    assert targets() == {old_target}
    with database.begin() as db:
        renew_demand(db, "legacy-chart", db.get(Instrument, instrument))
    assert targets() == {old_target, new_target}  # Unbound leases still follow head.
    clock[0] += 120000
    assert targets() == set()


def test_chart_demand_rejects_revision_from_another_composite(database, monkeypatch):
    import pytest
    from alerts.storage import CompositeRevision

    ident, instrument, old, _, _, _ = switched_targets(database, monkeypatch)
    with database.begin() as db:
        original = db.get(MarketComposite, ident)
        other = MarketComposite(id="other-composite", dataset_id=original.dataset_id, mapping_id=original.mapping_id,
            instrument_id="other-composite-instrument", permission_scope=original.permission_scope,
            rules=original.rules)
        db.add(Instrument(id=other.instrument_id, symbol="OTHER", label="other", calendar="ny17", precision=5))
        db.flush()
        db.add(other)
        db.flush()
        rev = db.get(CompositeRevision, old)
        foreign = CompositeRevision(composite_id=other.id, history_version_id=rev.history_version_id,
            mapping_id=rev.mapping_id, seam=rev.seam, rules=rev.rules, request_id="foreign")
        db.add(foreign)
        db.flush()
        with pytest.raises(ValueError, match="修订"):
            renew_demand(db, "invalid-chart", db.get(Instrument, instrument), composite_revision_id=foreign.id)
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == 0
