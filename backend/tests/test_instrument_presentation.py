from alerts import business
from alerts.market_contracts import DatasetIdentity
from alerts.market_datasets import register_dataset
from alerts.storage import Instrument, MarketDataset


def test_dashboard_identity_survives_without_live_snapshot(database, monkeypatch):
    from alerts import live_pricing

    monkeypatch.setattr(live_pricing, "snapshots", lambda: [])
    identity = DatasetIdentity(
        source="dukascopy",
        channel="python",
        environment="historical",
        account_scope="public",
        provider_symbol="eurusd",
        basis="bid",
        calendar_version="ny17-v1",
    )
    with database.begin() as db:
        inst = register_dataset(
            db,
            identity,
            logical_symbol="EURUSD",
            label="欧元 / 美元",
            calendar="ny17",
            precision=5,
            volume_kind="unavailable",
            volume_unit=None,
        )
        inst.enabled = True
        instrument_id = inst.id
    rows = {row["id"]: row for row in business.instruments()}
    assert rows[instrument_id]["logical_symbol"] == "EURUSD"
    assert rows[instrument_id]["dataset_identity"] == identity.model_dump()
    assert rows[instrument_id]["symbol"] == "eurusd"
    assert rows["EURUSD"]["symbol"] == "eurusd"
    assert rows["EURUSD"].get("dataset_identity") is None
    with database.begin() as db:
        assert db.get(MarketDataset, identity.key).instrument_id == instrument_id
        assert db.get(Instrument, "EURUSD").id == "EURUSD"
