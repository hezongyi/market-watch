"""Run accepted historical-window HTTP contracts against isolated PostgreSQL."""

import inspect
import os

import pytest
import test_market_stream_history_windows as contracts
from alerts import storage
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires isolated Ubuntu PostgreSQL")

CASES = [
    (contracts.test_composite_historical_last_bucket_correction_resets_from_http_observation,
     {"frame": frame}) for frame in ("M1", "M5")
] + [
    (contracts.test_provider_historical_last_bar_correction_resets_from_http_observation,
     {"frame": frame}) for frame in ("M1", "D1")
] + [
    (contracts.test_composite_historical_window_ignores_later_buckets, {}),
    (contracts.test_composite_realtime_last_bar_update_and_append_still_deliver, {}),
] + [
    (contract, {"published": published})
    for contract in (
        contracts.test_managed_historical_last_bar_correction_resets_from_http_observation,
        contracts.test_managed_historical_window_ignores_tail_append,
        contracts.test_managed_historical_indicator_keeps_recursive_prefix_dependency,
        contracts.test_managed_last_bar_correction_between_native_history_and_first_delivery_resets,
    ) for published in (False, True)
] + [
    (contracts.test_provider_historical_indicator_keeps_recursive_prefix_dependency,
     {"changed_index": index, "expected_type": expected}) for index, expected in ((19, "reset"), (4, "status"))
]


@pytest.mark.parametrize("contract, parameters", CASES)
def test_historical_http_contract(provider_pg, monkeypatch, contract, parameters):
    factory, engine = provider_pg
    storage.bootstrap(engine)
    client = contracts.history_client.__wrapped__(factory)
    try:
        arguments = {"database": factory, "history_client": next(client), **parameters}
        if "monkeypatch" in inspect.signature(contract).parameters:
            arguments["monkeypatch"] = monkeypatch
        contract(**arguments)
    finally:
        client.close()
