"""Compare the graph adapters and persistent alert adapter on identical history."""

from decimal import Decimal

import pytest
from alerts import managed_dataset, provider_cache, provider_chart
from alerts.chart_alert_service import create, current_version
from alerts.chart_alert_service import lifecycle as apply_lifecycle
from alerts.chart_alert_values import operand_values
from alerts.chart_alert_worker import evaluate, stored_rows
from alerts.chart_query import DataQuery
from alerts.storage import (
    ChartAlert,
    ChartPublication,
    ChartPublishedBar,
    ProviderBar,
    ProviderDataset,
)
from sqlalchemy import select
from test_chart_alert_values import indicator, rows
from test_chart_alert_worker import config, seed

SPECS = [("SMA", {"period": 3}), ("EMA", {"period": 3}),
         ("RSI", {"period": 3}), ("MACD", {"fast": 3, "slow": 5, "signal": 2})]


@pytest.mark.parametrize("name,params", SPECS)
def test_published_chart_and_alert_share_fixed_origin_and_live_value(database, name, params):
    prices = [10, 12, 11, 15, 14, 13, 12, 17, 13, 18, 30]
    history = rows(prices, incomplete=10)
    spec = indicator(name, **params)
    with database.begin() as db:
        # Staging disagrees deliberately: alerts created on a published chart
        # must consume the graph's snapshot, not another history representation.
        seed(db, [1] * 11)
        db.add(ChartPublication(instrument_id="BTCUSDT", timeframe="M1", start=0,
                                end=660_000, complete_count=10, initialized=True))
        for row in history:
            db.add(ChartPublishedBar(instrument_id="BTCUSDT", timeframe="M1", start=row["start"],
                                    end=row["end"], complete=row["complete"], payload=row))
        rule = config(calculation_origin=0, published=True, mode="intrabar", condition={
            "relation": "cross_up", "left": spec.model_dump(), "right": {"kind": "constant", "value": 100},
        })
        alert = create(db, "contract-"+name, rule, at=600_000)
        db.flush()
        inputs, _ = stored_rows(db, current_version(db, alert), rule, 660_000)
        values = operand_values(inputs, spec, provisional=True)
        assert inputs[-1]["close"] == "30"
    graph = managed_dataset.data(DataQuery(instrument="BTCUSDT", timeframe="M1", published=True,
                                           dataset_start=0, before=660_000, limit=7,
                                           indicators=[spec.indicator.model_dump()]))
    output = next(s for s in graph["indicators"][0]["series"] if s["key"] == spec.indicator.output)
    assert [Decimal(str(v["value"])) if v["value"] is not None else None for v in output["values"]] == values[-7:]
    assert history[-1]["complete"] is False


@pytest.mark.parametrize("name,params", SPECS)
def test_provider_graph_uses_source_prefix_independent_of_page_size(database, monkeypatch, name, params):
    meta = {"id": "BTCUSDT", "symbol": "BTCUSDT", "source": "binance", "basis": "last", "calendar": "utc0", "precision": 2}
    key = provider_cache.ensure(meta, "M1")
    history = rows([10+i % 11 for i in range(150)], incomplete=149)
    spec = indicator(name, **params)
    with database.begin() as db:
        for row in history:
            db.add(ProviderBar(dataset_id=key, start=row["start"], chart_time=row["start"], complete=row["complete"],
                               observed_at=9_000_000, payload={**row, "chart_time": row["start"]}))
    monkeypatch.setattr(provider_chart, "metadata", lambda *_args, **_kw: meta)
    monkeypatch.setattr(provider_cache, "now_ms", lambda: 9_000_000)

    def read(_meta, _frame, _before, count, **_options):
        return {"bars": [{**row, "chart_time": row["start"]} for row in history[-count:]],
                "dataset_id": key, "has_more": True, "history_boundary": False}

    monkeypatch.setattr(provider_cache, "read", read)
    expected = operand_values(history, spec, provisional=True)
    for count in (5, 15):
        graph = provider_cache.data(DataQuery(instrument="BTCUSDT", series_kind="provider", timeframe="M1",
                                             limit=count, indicators=[spec.indicator.model_dump()]))
        output = next(s for s in graph["indicators"][0]["series"] if s["key"] == spec.indicator.output)
        assert graph["calculation_origin"] == 0
        assert [Decimal(str(v["value"])) if v["value"] is not None else None for v in output["values"]] == expected[-count:]


def test_revision_rebaseline_keeps_events_and_count_without_historical_replay(database):
    from alerts.storage import Bar, SignalRow

    with database.begin() as db:
        seed(db, [9, 11, 9])
        ident = create(db, "repair", config(), at=60_000).id
        assert len(evaluate(db, ident, now=180_000)) == 1
    with database.begin() as db:
        bar = db.scalar(select(Bar).where(Bar.start == 60_000))
        bar.open = bar.high = bar.low = bar.close = Decimal(9)
        evaluate(db, ident, now=180_001)
        assert db.get(ChartAlert, ident).health == "blocked"
        saved = lifecycle(db, ident, 1, "rebaseline", at=180_001)
        assert saved.count == 1 and saved.run == 1
        assert evaluate(db, ident, now=180_002) == []
        assert len(list(db.scalars(select(SignalRow)))) == 1


def test_oanda_account_change_blocks_old_dataset_and_durable_collection(database, monkeypatch):
    from alerts import provider_service
    from alerts.config import settings

    meta = {"id": "OANDA:TEST", "symbol": "TEST", "source": "oanda", "basis": "bid", "calendar": "ny17", "precision": 5}
    monkeypatch.setattr(settings, "oanda_account_id", "fixture-one")
    key = provider_cache.ensure(meta, "M1")
    with database.begin() as db:
        ident = create(db, "account-fence", config(instrument=meta["id"], source="oanda", series_kind="provider"), dataset_id=key, at=0).id
    monkeypatch.setattr(settings, "oanda_account_id", "fixture-two")
    monkeypatch.setattr(provider_cache, "read", lambda *_a, **_kw: pytest.fail("old account identity cannot be recollected"))
    provider_service.realtime_step("oanda")
    with database.begin() as db:
        assert evaluate(db, ident, now=60_000) == []
        alert = db.get(ChartAlert, ident)
        assert alert.health == "blocked" and "账户" in alert.health_reason
        assert db.get(ProviderDataset, key).latest_at == 0


def test_provider_pinned_origin_does_not_shift_when_older_cache_is_added(database, monkeypatch):
    meta = {"id": "BTCUSDT", "symbol": "BTCUSDT", "source": "binance", "basis": "last", "calendar": "utc0", "precision": 2}
    key = provider_cache.ensure(meta, "M1")
    history = rows([10+i % 11 for i in range(70)])
    spec = indicator("EMA", period=3)
    with database.begin() as db:
        for row in history:
            db.add(ProviderBar(dataset_id=key, start=row["start"], chart_time=row["start"], complete=True, observed_at=4_200_000,
                               payload={**row, "chart_time": row["start"]}))
    monkeypatch.setattr(provider_chart, "metadata", lambda *_a, **_kw: meta)
    monkeypatch.setattr(provider_cache, "now_ms", lambda: 4_200_000)
    monkeypatch.setattr(provider_cache, "read", lambda *_a, **_kw: {
        "bars": [{**row, "chart_time": row["start"]} for row in history[-10:]],
        "dataset_id": key, "has_more": True, "history_boundary": False,
    })
    graph = provider_cache.data(DataQuery(instrument="BTCUSDT", series_kind="provider", timeframe="M1", limit=5,
                                         calculation_origin=600_000, indicators=[spec.indicator.model_dump()]))
    output = graph["indicators"][0]["series"][0]["values"]
    assert graph["calculation_origin"] == 600_000
    assert [Decimal(str(v["value"])) for v in output] == operand_values(history[10:], spec)[-5:]


def test_published_price_alert_never_compares_invisible_staging_prices(database):
    history = rows([9, 9, 9])
    with database.begin() as db:
        seed(db, [9, 11, 9])
        db.add(ChartPublication(instrument_id="BTCUSDT", timeframe="M1", start=0,
                                end=180_000, complete_count=3, initialized=True))
        for row in history:
            db.add(ChartPublishedBar(instrument_id="BTCUSDT", timeframe="M1", start=row["start"],
                                    end=row["end"], complete=True, payload=row))
        ident = create(db, "published-price", config(published=True), at=60_000).id
        assert evaluate(db, ident, now=180_001) == []
        assert db.get(ChartAlert, ident).count == 0


def test_published_chart_and_alert_restart_indicator_after_same_missing_interval(database):
    spec = indicator("EMA", period=3)
    history = rows([10+i for i in range(30)])
    history = [row for i, row in enumerate(history) if i != 10]
    with database.begin() as db:
        db.add(ChartPublication(instrument_id="BTCUSDT", timeframe="M1", start=0,
                                end=1_800_000, complete_count=29, initialized=True))
        for row in history:
            db.add(ChartPublishedBar(instrument_id="BTCUSDT", timeframe="M1", start=row["start"],
                                    end=row["end"], complete=True, payload=row))
        rule = config(published=True, calculation_origin=0, condition={"relation":"cross_up", "left":spec.model_dump(), "right":{"kind":"constant","value":100}})
        alert = create(db, "published-gap", rule, at=1_800_000)
        db.flush()
        from alerts.chart_calculation_history import calculation_rows
        inputs, meta = stored_rows(db, current_version(db, alert), rule, 1_800_000)
        expected = operand_values(calculation_rows(inputs, meta, rule.instrument), spec)
    graph = managed_dataset.data(DataQuery(instrument="BTCUSDT", timeframe="M1", published=True,
                                           dataset_start=0, before=1_800_000, limit=20, indicators=[spec.indicator.model_dump()]))
    output = graph["indicators"][0]["series"][0]["values"]
    assert [Decimal(str(v["value"])) if v["value"] is not None else None for v in output] == expected[-20:]


def lifecycle(db, alert_id, version, action, *, at=None):
    import uuid
    return apply_lifecycle(db, alert_id, version, action,
                           expected_revision=db.get(ChartAlert, alert_id).control_revision,
                           request_id=uuid.uuid4().hex, at=at)
