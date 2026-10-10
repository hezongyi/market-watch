import importlib.util
from decimal import Decimal, Inexact, Rounded, localcontext
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts import provider_chart
from alerts.chart_series import decode, display_symbol, encode, is_gold
from alerts.market import ingest
from alerts.market_contracts import RequestResult
from alerts.market_datasets import legacy_inventory, process_price_row, register_dataset
from alerts.storage import Bar, Instrument, MarketCoverage, MarketDataset
from fastapi import HTTPException
from sqlalchemy import create_engine, inspect, select, text
from test_market_contracts import batch, identity, minute


def register(db, ident=None, logical_symbol="EURUSD", precision=5):
    oanda = ident and ident.source == "oanda"
    return register_dataset(db, ident or identity(), logical_symbol=logical_symbol,
                            label=logical_symbol, calendar="ny17", precision=precision,
                            volume_kind="price_count" if oanda else "quantity",
                            volume_unit="quotes" if oanda else "source_quantity")


@pytest.mark.parametrize("precision, raw, expected", [
    (2, "123.456", "123.46"), (3, "123.456", "123.456"),
    (5, "1.093887", "1.09389"), (5, "1.093880", "1.093880"),
    (5, "1.0938849", "1.09388"), (6, "1.0000005", "1.000001"),
    (2, "1.005", "1.01"), (3, "1.23456789", "1.235"),
])
def test_process_price_row_rounds_only_excess_scale(precision, raw, expected):
    row = {"timestamp": 0, "open": raw, "high": raw, "low": raw, "close": raw,
           "volume": "2.0", "complete": True}
    result = process_price_row(row, precision)
    assert result["open"] == expected
    assert result["volume"] == row["volume"]


def test_process_price_row_rejects_invalid_or_rounding_to_zero():
    row = {"timestamp": 0, "open": "0.004", "high": "0.004", "low": "0.004",
           "close": "0.004", "volume": None, "complete": True}
    with pytest.raises(ValueError):
        process_price_row(row, 2)
    for value in ("NaN", "Infinity", "-1", "100000000000000"):
        row["open"] = row["high"] = row["low"] = row["close"] = value
        with pytest.raises(ValueError):
            process_price_row(row, 5)


def test_same_display_name_keeps_channel_and_legacy_histories_separate(database):
    with database.begin() as db:
        legacy = db.get(Instrument, "EURUSD")
        original = (legacy.source, legacy.symbol, legacy.basis)
        python = register(db)
        node = register(db, identity(channel="node"))
        assert python.id != node.id != legacy.id
        assert display_symbol(python.id) == display_symbol(node.id) == legacy.id
        assert decode(encode(python.id)) == (python.id, "managed")
        assert register(db).id == python.id
        ingest(db, python, batch().ingestion_payload())
        ingest(db, node, batch(identity=identity(channel="node"),
                              rows=(minute(close="1.10"),)).ingestion_payload())
        assert len(db.scalars(select(Bar).where(Bar.timeframe == "M1")).all()) == 3
        assert not db.scalars(select(Bar).where(Bar.instrument_id == legacy.id)).all()
        assert (legacy.source, legacy.symbol, legacy.basis) == original
        audit = legacy_inventory(db)
        assert next(row for row in audit if row["instrument"] == "EURUSD")["mapping"] == "legacy_unverified"


@pytest.mark.parametrize("change", [
    {"channel": "node"}, {"environment": "practice"},
    {"account_scope": "sha256:" + "a" * 64}, {"calendar_version": "new-v2"},
])
def test_same_source_other_identity_is_rejected_before_bars_or_coverage(database, change):
    with database.begin() as db:
        inst = register(db)
        with pytest.raises(ValueError, match="身份"):
            ingest(db, inst, batch(identity=identity(**change)).ingestion_payload())
        assert db.scalar(select(Bar)) is None
        assert db.scalar(select(MarketCoverage)) is None


def test_new_identity_cannot_silently_rebind_old_instrument(database):
    with database.begin() as db:
        with pytest.raises(ValueError, match="旧品种"):
            ingest(db, db.get(Instrument, "EURUSD"), batch().ingestion_payload())


def test_explicit_writer_cannot_omit_identity_and_empty_has_no_coverage(database):
    with database.begin() as db:
        inst = register(db)
        with pytest.raises(ValueError):
            ingest(db, inst, {"rows": []})
        ingest(db, inst, batch(rows=(), result=RequestResult(status="empty_success")).ingestion_payload())
        assert db.scalar(select(Bar)) is None
        assert db.scalar(select(MarketCoverage)) is None


def test_failed_request_cannot_write_or_certify_data(database):
    with database.begin() as db:
        inst = register(db)
        payload = batch().ingestion_payload()
        payload["request_result"] = {"status": "timeout"}
        with pytest.raises(RuntimeError, match="timeout"):
            ingest(db, inst, payload)
        assert db.scalar(select(Bar)) is None
        assert db.scalar(select(MarketCoverage)) is None


def test_explicit_sparse_oanda_batch_does_not_certify_unobserved_minutes(database):
    ident = identity(source="oanda", channel="rest", environment="practice",
                     account_scope="sha256:" + "b" * 64, provider_symbol="EUR_USD")
    with database.begin() as db:
        inst = register(db, ident)
        payload = batch(identity=ident, rows=(minute(60000, volume="3"),),
                        volume_kind="price_count", volume_unit="quotes").ingestion_payload()
        ingest(db, inst, payload)
        coverage = db.scalars(select(MarketCoverage)).all()
        assert [(row.start, row.end) for row in coverage] == [(60000, 120000)]
        payload["coverage"] = [{"start": 0, "end": 120000}]
        with pytest.raises(ValueError, match="observed minutes"):
            ingest(db, inst, payload)


@pytest.mark.parametrize("field,value", [
    ("id", "CHANGED"),
    ("source", "oanda"), ("symbol", "EUR_USD"), ("basis", "mid"),
    ("calendar", "utc0"), ("precision", 2), ("calendar_profile", {"version": "changed"}),
])
def test_registered_history_cannot_be_reinterpreted(database, field, value):
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            inst = register(db)
            setattr(inst, field, value)
            db.flush()


def test_dataset_binding_cannot_be_replaced_or_deleted(database):
    with database.begin() as db:
        inst = register(db)
        ident = inst.id
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            row = db.get(MarketDataset, identity().key)
            row.identity = identity(channel="node").model_dump()
    with pytest.raises(ValueError, match="removed"):
        with database.begin() as db:
            db.delete(db.get(MarketDataset, identity().key))
    with pytest.raises(ValueError, match="removed"):
        with database.begin() as db:
            db.delete(db.get(Instrument, ident))
    with database.begin() as db:
        assert db.get(Instrument, ident).source == "dukascopy"


def test_precision_and_forming_minutes_are_guarded(database):
    with database.begin() as db:
        inst = register(db)
        ingest(db, inst, batch(rows=(minute(close="1.111111"),)).ingestion_payload())
        ingest(db, inst, batch(rows=(minute(complete=False),)).ingestion_payload())
        assert db.scalar(select(Bar)).close == Decimal("1.11111")
        assert db.scalar(select(MarketCoverage)) is not None


def test_same_prices_cannot_silently_change_volume_semantics(database):
    with database.begin() as db:
        inst = register(db)
        with pytest.raises(ValueError, match="Volume semantics"):
            ingest(db, inst, batch(rows=(minute(volume="3"),), volume_kind="tick_count",
                                  volume_unit="ticks").ingestion_payload())
        assert db.scalar(select(Bar)) is None


def test_qualified_gold_keeps_gold_calendar_and_cannot_be_native_alias(database):
    with database.begin() as db:
        gold = register(db, identity(provider_symbol="XAU/USD"), logical_symbol="XAUUSD", precision=2)
        ident = gold.id
    assert is_gold(ident) and is_gold("OANDA:XAU_USD")
    assert not is_gold("EURUSD")
    with pytest.raises(HTTPException) as error:
        provider_chart.metadata(ident)
    assert error.value.status_code == 422


def test_additive_migration_roundtrip_and_populated_rollback_guard():
    path = Path(__file__).resolve().parents[2] / "migrations/versions/s20_market_datasets.py"
    spec = importlib.util.spec_from_file_location("dataset_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE instruments (id varchar(40) PRIMARY KEY, source varchar(32))"))
        connection.execute(text("INSERT INTO instruments VALUES ('EURUSD', 'dukascopy')"))
        connection.execute(text("CREATE TABLE candles (instrument_id varchar(40), close varchar(40))"))
        connection.execute(text("INSERT INTO candles VALUES ('EURUSD', '1.12345')"))
        migration.op = Operations(MigrationContext.configure(connection))
        for _ in range(2):
            migration.upgrade()
            assert inspect(connection).has_table("market_datasets")
            assert connection.execute(text("SELECT * FROM instruments")).one() == ("EURUSD", "dukascopy")
            assert connection.execute(text("SELECT * FROM candles")).one() == ("EURUSD", "1.12345")
            connection.execute(text("INSERT INTO market_datasets VALUES "
                                    "('key', 'EURUSD', 'EURUSD', '{}', 'quantity', 'source')"))
            with pytest.raises(RuntimeError, match="backup"):
                migration.downgrade()
            assert inspect(connection).has_table("market_datasets")
            # Test fixture only: no runtime writer is permitted to discard a binding.
            connection.execute(text("DELETE FROM market_datasets WHERE id='key'"))
            migration.downgrade()
            assert not inspect(connection).has_table("market_datasets")
            assert connection.execute(text("SELECT * FROM candles")).one() == ("EURUSD", "1.12345")
    engine.dispose()


@pytest.mark.parametrize("ambient_precision", [2, 5, 28])
def test_price_processing_is_independent_of_ambient_context(ambient_precision):
    raw = {field: "1.093887" for field in ("open", "high", "low", "close")}
    with localcontext() as context:
        context.prec = ambient_precision
        context.traps[Inexact] = context.traps[Rounded] = True
        assert process_price_row(raw, 5)["close"] == "1.09389"
        zeros = {field: "1.093880" for field in raw}
        assert process_price_row(zeros, 5) == zeros
    assert raw["close"] == "1.093887"


def test_price_processing_rejects_invalid_ohlc_even_if_rounding_would_hide_it():
    with pytest.raises(ValueError, match="OHLC"):
        process_price_row({"open": "1.000004", "high": "1.000003",
                           "low": "1.000002", "close": "1.000004"}, 5)


@pytest.mark.parametrize("manifest", [
    {"price_precision": 5}, {"price_rule_version": "unknown", "price_precision": 5},
    {"price_rule_version": "dataset-precision-half-up-v1"},
    {"price_rule_version": "dataset-precision-half-up-v1", "price_precision": True},
])
def test_unknown_or_incomplete_version_price_rule_is_rejected(manifest):
    from alerts.market_datasets import version_price_rows

    with pytest.raises(ValueError):
        version_price_rows([], manifest)
