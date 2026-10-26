"""Mode contracts: old canonical bytes, native temporal and identity isolation."""

import hashlib
import json
from types import SimpleNamespace

import pytest
from alerts.market_contracts import DatasetIdentity, NativeBarRow, NativeCandleBatch, SourceIdentity
from alerts.market_datasets import register_dataset
from alerts.source_registry import link_frame_source
from alerts.storage import (
    DatasetFrameSource,
    DatasetSource,
    HistoryChunk,
    HistoryVersion,
    MarketDataset,
)
from test_market_contracts import identity


def mode_identity(mode="base_d1", **changes):
    return DatasetIdentity(**{
        "source": "fixture", "channel": "native", "environment": "public",
        "account_scope": "public", "provider_symbol": "SSE:000001", "basis": "last",
        "calendar_version": "sse-trading-date-v1", "identity_version": 2,
        "mode": mode, "base_frame": "D1" if mode == "base_d1" else None,
        "source_family": "fixture-official", "adjustment": "none",
        "trading_date_rule": "source-date-v1", **changes,
    })


def native_identity(frame="D1", parent=None, **changes):
    parent = parent or mode_identity()
    return SourceIdentity(**{key: getattr(parent, key) for key in (
        "source", "channel", "environment", "account_scope", "provider_symbol", "basis")},
        parameters={"timeframe": frame, "endpoint": "official_daily", "adjustment": parent.adjustment,
            "source_family": parent.source_family, "trading_date_rule": parent.trading_date_rule,
            "session": "exchange", "timezone": "Asia/Shanghai", "rules": "native-v1", **changes})


def native_bar(**changes):
    return NativeBarRow(**{
        "timeframe": "D1", "start": 1704067200000, "end": 1704153600000,
        "open": "10.00", "high": "12", "low": "9", "close": "11", "volume": "5",
        "source_label": "2024-01-01", "trading_date": "2024-01-01",
        "complete": True, "confirmation": "next_bar", **changes,
    })


def register_mode(db, parent=None):
    parent = parent or mode_identity()
    inst = register_dataset(db, parent, logical_symbol="SSE000001", label="fixture",
        calendar="source_date", precision=2, volume_kind="quantity", volume_unit="shares",
        calendar_profile={"revision": parent.calendar_version, "trading_date": {
            "timezone": "Asia/Shanghai", "market": "SSE", "rule": parent.trading_date_rule,
            "close_minute": 900}},
        asset_class="equity")
    return db.get(MarketDataset, parent.key), inst


def test_legacy_seven_field_json_and_sha_are_byte_identical():
    old = identity()
    canonical = ('{"account_scope":"public","basis":"bid",'
                 '"calendar_version":"candidate-ny17-v1","channel":"python",'
                 '"environment":"historical","provider_symbol":"EUR/USD","source":"dukascopy"}')
    assert json.dumps(old.model_dump(), sort_keys=True, separators=(",", ":")) == canonical
    assert old.key == "99f162c8154844e06f38715e618f64c5138b990fb39f801a5c64fb6a3960dbd0"
    assert old.key == hashlib.sha256(canonical.encode()).hexdigest()
    assert len(json.loads(old.model_dump_json())) == 7
    assert DatasetIdentity.model_validate_json(old.model_dump_json()) == old


@pytest.mark.parametrize("changes", [
    {"mode": "base_d1"}, {"identity_version": 2}, {"base_frame": None},
    {"source_family": "new"}, {"adjustment": "none"},
])
def test_new_defaults_cannot_reinterpret_legacy_identity(changes):
    with pytest.raises(ValueError):
        identity(**changes)


def test_mode_and_adjustment_separate_dataset_but_period_selection_is_not_identity():
    daily = mode_identity()
    assert DatasetIdentity.model_validate(daily.model_dump()).key == daily.key
    assert daily.key != mode_identity("native_periods").key
    assert daily.key != mode_identity(adjustment="qfq").key
    with pytest.raises(ValueError):
        mode_identity("native_periods", adjustment="qfq")
    with pytest.raises(ValueError):
        DatasetIdentity.model_validate(daily.model_dump() | {"timeframes": ["D1"]})


@pytest.mark.parametrize("changes", [
    {"open": "0"}, {"close": "-1"}, {"high": "NaN"}, {"low": "12"},
    {"volume": "-1"}, {"end": 1704067200000}, {"trading_date": "2024-02-30"},
    {"confirmation": "unconfirmed"}, {"timeframe": "M3"}, {"trading_date": None},
])
def test_native_invalid_observations_are_rejected_without_price_repair(changes):
    with pytest.raises(ValueError):
        native_bar(**changes)


def test_native_batch_has_own_bounds_and_confirmation_not_minute_semantics():
    row = native_bar()
    values = dict(identity=native_identity(), timeframe="D1", window_start=row.start,
        window_end=row.end, observed_at=row.end, result={"status": "data"},
        rows=(row,), volume_kind="quantity", volume_unit="shares", checkpoint=row.end)
    assert NativeCandleBatch(**values).rows[0].end - row.start == 86400000
    for changes in ({"timeframe": "M5"}, {"rows": (row, row)}, {"observed_at": row.start},
                    {"result": {"status": "timeout"}}, {"window_end": row.start}):
        with pytest.raises(ValueError):
            NativeCandleBatch(**(values | changes))


def test_frame_bindings_are_immutable_and_do_not_create_fake_m1(database):
    parent = mode_identity("native_periods")
    with database.begin() as db:
        dataset, _ = register_mode(db, parent)
        d1 = link_frame_source(db, dataset, "D1", native_identity(parent=parent))
        m5 = link_frame_source(db, dataset, "M5", native_identity("M5", parent, endpoint="official_minute"))
        assert d1.id != m5.id
        assert db.get(DatasetSource, dataset.id) is None
        assert link_frame_source(db, dataset, "D1", native_identity(parent=parent)).id == d1.id
        with pytest.raises(ValueError, match="重新绑定"):
            link_frame_source(db, dataset, "D1", native_identity(parent=parent, endpoint="different"))
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.get(DatasetFrameSource, (parent.key, "D1")).source_id = m5.id


def test_chunk_partition_key_includes_actual_input_frame(database):
    with database.begin() as db:
        dataset, _ = register_mode(db, mode_identity("native_periods"))
        version = HistoryVersion(dataset_id=dataset.id, start=0, end=86400000, cursor=0)
        db.add(version)
        db.flush()
        for frame in ("D1", "M5"):
            db.add(HistoryChunk(version_id=version.id, timeframe=frame, start=0,
                end=86400000, observed_at=86400000, count=1, checksum="a" * 64,
                content=b"fixture", result="data"))
        db.flush()


@pytest.mark.parametrize("family,kind,value,expected", [
    ("sina-a", "sina_qfq_factor", "2", "5"),
    ("sina-hk", "sina_qfq_factor", "0.5", "5.0"),
    ("yfinance", "yahoo_adj_close_ratio", "0.5", "5.0"),
])
def test_qfq_projection_uses_market_specific_factor_direction(family, kind, value, expected):
    from alerts.history_mode_artifacts import _qfq_row

    dataset = SimpleNamespace(identity={"source_family": family, "adjustment": "none"},
                              asset_class="equity")
    row = {"open": "10", "high": "12", "low": "8", "close": "10",
           "adjustment_basis": {"kind": kind, "value": value}}
    adjusted = _qfq_row(row, dataset)
    assert adjusted["close"] == expected
    assert adjusted["adjustment_view"] == "qfq"
    assert row["close"] == "10", "the raw observation stays unchanged"


def test_yahoo_supplier_input_still_projects_qfq_from_saved_basis():
    from alerts.history_mode_artifacts import _qfq_row

    dataset = SimpleNamespace(identity={"source_family": "yfinance", "adjustment": "supplier"},
                              asset_class="equity")
    row = {"open": "10", "high": "12", "low": "8", "close": "10",
           "adjustment_basis": {"kind": "yahoo_adj_close_ratio", "value": "0.5"}}
    adjusted = _qfq_row(row, dataset)
    assert adjusted["close"] == "5.0"
    assert adjusted["adjustment_view"] == "qfq"
    assert row["close"] == "10"


def test_qfq_projection_refuses_a_missing_basis():
    from alerts.history_mode_artifacts import _qfq_row

    dataset = SimpleNamespace(identity={"source_family": "yfinance", "adjustment": "none"},
                              asset_class="equity")
    with pytest.raises(ValueError, match="前复权依据缺失"):
        _qfq_row({"open": "1", "high": "1", "low": "1", "close": "1"}, dataset)
