from decimal import Decimal

import httpx
import pytest
from alerts.market_contracts import (
    CandleBatch,
    DatasetIdentity,
    MarketRequestError,
    MinuteRow,
    QuoteEvent,
    RequestResult,
    RequestStatus,
    SourceHealth,
    SourceSelection,
    failed_request,
)


def identity(**changes):
    return DatasetIdentity(**{
        "source": "dukascopy", "channel": "python", "environment": "historical",
        "account_scope": "public", "provider_symbol": "EUR/USD", "basis": "bid",
        "calendar_version": "candidate-ny17-v1", **changes,
    })


def minute(at=0, **changes):
    return MinuteRow(**{"timestamp": at, "open": "1.10", "high": "1.12", "low": "1.09",
                        "close": "1.11", "volume": "6.30", "complete": True, **changes})


def batch(**changes):
    return CandleBatch(**{
        "identity": identity(), "window_start": 0, "window_end": 120000,
        "observed_at": 125000, "result": RequestResult(status="data"),
        "rows": (minute(), minute(60000)), "volume_kind": "quantity",
        "volume_unit": "source_quantity", **changes,
    })


@pytest.mark.parametrize("field,value", [
    ("source", "oanda"), ("channel", "node"), ("environment", "practice"),
    ("account_scope", "sha256:" + "a" * 64), ("provider_symbol", "XAU/USD"),
    ("basis", "ask"), ("calendar_version", "candidate-ny17-v2"),
])
def test_every_identity_dimension_separates_a_price_sequence(field, value):
    assert identity(**{field: value}).key != identity().key
    assert DatasetIdentity.model_validate(identity().model_dump()).key == identity().key


def test_account_scope_cannot_hold_raw_account_id():
    with pytest.raises(ValueError):
        identity(account_scope="private-account-id")


@pytest.mark.parametrize("changes", [
    {"timestamp": 1}, {"open": "NaN"}, {"high": "Infinity"}, {"low": "1.2"},
    {"close": "invalid"}, {"volume": "-1"}, {"volume": "NaN"}, {"open": 1.1},
    {"complete": "true"}, {"open": "100000000000000"},
])
def test_invalid_minutes_are_rejected(changes):
    with pytest.raises(ValueError):
        minute(**changes)


@pytest.mark.parametrize("changes", [
    {"rows": (minute(60000), minute())}, {"rows": (minute(), minute())},
    {"rows": (minute(120000),)}, {"window_end": 0},
    {"window_end": 32 * 86400000}, {"checkpoint": 180000},
    {"result": RequestResult(status="empty_success")},
    {"result": RequestResult(status="timeout")}, {"rows": ()},
    {"volume_kind": "price_count"}, {"volume_kind": "unavailable"},
])
def test_invalid_batches_do_not_cross_ingestion_interface(changes):
    with pytest.raises(ValueError):
        batch(**changes)


def test_stale_data_is_success_and_empty_does_not_certify_coverage():
    stale = batch(observed_at=86400000)
    assert stale.result.successful
    assert stale.ingestion_payload()["rows"][0]["open"] == "1.10"
    empty = batch(rows=(), result=RequestResult(status="empty_success"))
    assert empty.ingestion_payload()["rows"] == []
    assert "coverage" not in empty.ingestion_payload()
    failed = batch(rows=(), result=RequestResult(status="rate_limited", retry_at=180000))
    with pytest.raises(MarketRequestError, match="429"):
        failed.ingestion_payload()


@pytest.mark.parametrize("code,status", [
    (429, "rate_limited"), (401, "unauthorized"), (403, "unauthorized"),
    (503, "unavailable"),
])
def test_request_failures_remain_distinct_and_safe_to_log(code, status):
    request = httpx.Request("GET", "https://example.invalid/private-account?token=secret")
    response = httpx.Response(code, request=request, headers={"Retry-After": "30"})
    error = httpx.HTTPStatusError("sensitive response body", request=request, response=response)
    result = failed_request(error, observed_at=1000)
    assert result.status == status
    assert result.retry_at == (31000 if code == 429 else None)
    assert "secret" not in str(MarketRequestError(result))
    assert "private-account" not in str(MarketRequestError(result))


@pytest.mark.parametrize("header,expected", [
    ("invalid", None), ("-1", None), ("Infinity", None),
    ("Thu, 01 Jan 1970 00:01:00 GMT", 60000),
])
def test_retry_after_dates_and_invalid_headers(header, expected):
    request = httpx.Request("GET", "https://example.invalid")
    response = httpx.Response(429, request=request, headers={"Retry-After": header})
    error = httpx.HTTPStatusError("failure", request=request, response=response)
    assert failed_request(error, observed_at=1000).retry_at == expected


def test_timeout_and_invalid_payload_are_not_empty_success():
    assert failed_request(httpx.ReadTimeout("secret"), observed_at=0).status == RequestStatus.TIMEOUT
    assert failed_request(ValueError("secret"), observed_at=0).status == RequestStatus.INVALID_PAYLOAD
    assert Decimal(batch().rows[0].volume) == Decimal("6.30")


def test_one_sided_quote_and_heartbeat_do_not_imply_tradeable_fresh_prices():
    quote = QuoteEvent(identity=identity(), bid="1.10", ask=None, source_time=1000,
                       received_at=3000, tradeable=False, connection_epoch=2, sequence=1)
    assert quote.ask is None and not quote.tradeable
    assert quote.source_time != quote.received_at
    health = SourceHealth(identity=identity(), connection="connected", heartbeat_at=3000,
                          last_quote_at=1000, tradeable=False)
    assert health.error is None and health.last_confirmed_m1 is None
    selection = SourceSelection(logical_symbol="EURUSD", current=None, selection_epoch=0,
                                reason="primary unavailable; standby not ready", effective_at=3000)
    assert not selection.fallback_ready


@pytest.mark.parametrize("changes", [
    {"bid": "NaN"}, {"ask": "bad"}, {"bid": -1}, {"connection_epoch": 0},
    {"sequence": 0}, {"tradeable": "true"},
])
def test_invalid_quote_events_are_rejected(changes):
    values = dict(identity=identity(), bid="1.10", ask="1.11", source_time=1000,
                  received_at=3000, tradeable=True, connection_epoch=2, sequence=1)
    with pytest.raises(ValueError):
        QuoteEvent(**(values | changes))
