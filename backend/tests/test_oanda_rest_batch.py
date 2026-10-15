"""Candle-only acquisition and observation boundaries, without supplier I/O."""

import copy
import hashlib
import time
from decimal import Decimal, localcontext

import httpx
import pytest
from alerts.market_contracts import MarketRequestError, RequestResult
from alerts.native_series import OandaParameters
from alerts.oanda_rest_batch import (
    CandleSpec,
    CloseObservation,
    OandaRestBatch,
    decimal_text,
    normalize_latest,
    specifications,
)
from test_oanda_stream import oanda_identity


def spec(symbol="EUR_USD", **values):
    return CandleSpec.from_dataset(oanda_identity()).model_copy(update={"provider_symbol": symbol, **values})


def candle(start=60, *, complete=False, close="1.10000", high="1.20000", low="1.00000", volume=7):
    return {"time": str(start), "complete": complete, "bid": {"o": "1.10", "h": high, "l": low, "c": close},
            "volume": volume}


def group(symbol="EUR_USD", *, candles=None, granularity="M1"):
    return {"instrument": symbol, "granularity": granularity,
            "candles": candles if candles is not None else [candle(0, complete=True), candle()]}


def batch(groups=None, *, specs=None, **values):
    return normalize_latest({"latestCandles": groups if groups is not None else [group()]},
        specs or [spec()], **{"generation": 2, "sequence": 1, "demand_revision": "demand-1",
                             "requested_at": 61000, "received_at": 61200, **values})


def test_exact_normalization_and_latest_never_certifies_missing_minutes():
    result = batch()
    assert result.series[0].candles[0].close == "1.1"
    assert result.series[0].candles[1].volume == "7"
    confirmed, = result.confirmed_minutes(oanda_identity())
    assert (confirmed.window_start, confirmed.window_end, confirmed.checkpoint) == (0, 60000, 60000)
    assert confirmed.rows[0].complete
    sample = result.current_observation(spec(), committed_at=61250, recovery="ready")
    assert sample.method == "candle_close_sample" and sample.close == "1.1"
    assert sample.received_at == 61200 and sample.candle.start == 60000
    assert not {"bid", "ask", "tradeable", "source_time"} & sample.model_dump().keys()
    assert not hasattr(result, "checkpoint")


def test_confirmed_conversion_has_no_fixed_five_second_delay():
    result = batch(received_at=61000, requested_at=60900)
    assert result.confirmed_minutes(oanda_identity())[0].rows[0].timestamp == 0


def test_units_and_parameters_are_part_of_identity_and_grouping():
    original = spec()
    units = CandleSpec(**{**original.model_dump(), "units": "2.000"})
    assert units.units == "2" and units.key != original.key and units.group_key != original.group_key
    utc = spec(parameters=OandaParameters(dailyAlignment=0, alignmentTimezone="UTC"))
    with pytest.raises(ValueError, match="Separate"):
        specifications([original, utc])
    assert len(specifications([original, original, spec("XAU_USD")])) == 2
    wrong = original.identity.model_copy(update={"basis": "ask"})
    with pytest.raises(ValueError, match="basis"):
        CandleSpec.from_source(wrong)


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-1", "0", "1e999999", "1e-999999", 1.1])
def test_nonfinite_unbounded_or_float_decimal_is_rejected(value):
    with pytest.raises(ValueError):
        decimal_text(value)


def test_decimal_canonicalization_does_not_round_under_small_context():
    with localcontext() as context:
        context.prec = 4
        assert decimal_text("1234.5678901234567890") == "1234.567890123456789"


@pytest.mark.parametrize("mutate", [
    lambda c: c.update(complete="false"),
    lambda c: c.update(volume=True),
    lambda c: c.update(volume=1.5),
    lambda c: c.update(volume=-1),
    lambda c: c.update(time="60.001"),
    lambda c: c.update(time="120"),
    lambda c: c.update(complete=True),
    lambda c: c["bid"].update(c="NaN"),
    lambda c: c["bid"].update(l="1.15"),
    lambda c: c["bid"].update(c=1.1),
])
def test_invalid_single_series_does_not_poison_other_instruments(mutate):
    bad = candle()
    mutate(bad)
    result = batch([group(candles=[bad]), group("XAU_USD")], specs=[spec(), spec("XAU_USD")])
    by_symbol = {s.spec.provider_symbol: s for s in result.series}
    assert by_symbol["EUR_USD"].result.status == "invalid_payload"
    assert by_symbol["XAU_USD"].result.status == "data"


def test_missing_series_and_valid_empty_are_distinct():
    result = batch([group(candles=[])], specs=[spec(), spec("XAU_USD")])
    by_symbol = {s.spec.provider_symbol: s for s in result.series}
    assert by_symbol["EUR_USD"].result.status == "empty_success"
    assert by_symbol["XAU_USD"].result.status == "invalid_payload"
    assert result.confirmed_minutes(oanda_identity()) == ()
    assert result.current_observation(spec(), committed_at=61300, recovery="ready") is None


@pytest.mark.parametrize("groups", [[group("GBP_USD")], [group(granularity="H1")]])
def test_unrequested_response_identity_rejects_whole_envelope(groups):
    with pytest.raises(ValueError, match="identity"):
        batch(groups)


@pytest.mark.parametrize("rows", [[candle(), candle()], [candle(), candle(0, complete=True)]])
def test_duplicate_and_disordered_candles_are_not_sorted_into_validity(rows):
    assert batch([group(candles=rows)]).series[0].result.status == "invalid_payload"


def test_duplicate_price_groups_are_invalid_and_two_sides_remain_isolated():
    assert batch([group(), group()]).series[0].result.status == "invalid_payload"
    ask = spec(parameters=OandaParameters(price="A"))
    ask_group = copy.deepcopy(group())
    for row in ask_group["candles"]:
        row["ask"] = {key: str(Decimal(value) + Decimal("0.01")) for key, value in row.pop("bid").items()}
    result = batch([group(), ask_group], specs=[spec(), ask])
    assert {s.spec.parameters.price: s.candles[-1].close for s in result.series} == {"B": "1.1", "A": "1.11"}


def test_native_period_retains_native_interval_and_never_becomes_m1_observation():
    native = spec(granularity="H1")
    result = batch([group(granularity="H1", candles=[candle(0)])], specs=[native])
    assert result.series[0].candles[0].end == 3600000
    assert result.current_observation(native, committed_at=61250, recovery="ready") is None


def test_observation_clock_and_minute_age_gate_and_actual_interval():
    first = batch().current_observation(spec(), committed_at=61250, recovery="ready")
    second = batch(sequence=2, requested_at=63000, received_at=63200)
    sample = second.current_observation(spec(), committed_at=63250, recovery="pending", previous=first)
    assert sample.interval_ms == 2000 and sample.snapshot_id != first.snapshot_id
    assert sample.recovery == "pending"
    assert batch().current_observation(spec(), committed_at=80000, recovery="ready") is None
    assert batch().current_observation(spec(), committed_at=120000, recovery="ready") is None
    assert batch(received_at=121200).current_observation(spec(), committed_at=121250, recovery="ready") is None
    changed = second.model_copy(update={"generation": 3})
    assert changed.current_observation(spec(), committed_at=63250, recovery="ready", previous=first).interval_ms is None
    with pytest.raises(ValueError):
        CloseObservation(**{**first.model_dump(), "committed_at": 61000})


def test_one_batch_http_request_with_explicit_parameters_and_no_pricing():
    calls = []

    def handle(request):
        calls.append(request)
        assert request.url.path == "/v3/accounts/test-account/candles/latest"
        assert dict(request.url.params) == {"candleSpecifications": "EUR_USD:M1:B,XAU_USD:M1:B",
            "units": "1", "smooth": "false", "dailyAlignment": "17",
            "alignmentTimezone": "America/New_York", "weeklyAlignment": "Sunday"}
        return httpx.Response(200, json={"latestCandles": [group(), group("XAU_USD")]})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        adapter = OandaRestBatch(token="secret", account_id="test-account", rest_client=client, clock=lambda: 61200)
        result = adapter.latest([spec(), spec("XAU_USD"), spec()], generation=2, sequence=1, demand_revision="d1")
    assert len(calls) == 1 and all(row.result.successful for row in result.series)


@pytest.mark.parametrize("status,expected", [(401, "unauthorized"), (403, "unauthorized"),
    (429, "rate_limited"), (503, "provider_maintenance")])
def test_failures_preserve_status_and_shared_cooldown_without_secrets(monkeypatch, caplog, status, expected):
    from alerts import oanda_rest_batch as module

    cooldowns = []
    monkeypatch.setattr(module, "cooldown", lambda *args, **kw: cooldowns.append(kw))
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(status,
            headers={"Retry-After": "8"}, json={"errorMessage": "maintenance secret test-account"}))) as client:
        adapter = OandaRestBatch(token="secret", account_id="test-account", rest_client=client, clock=lambda: 61200)
        result = adapter.latest([spec()], generation=2, sequence=1, demand_revision="d1")
    assert result.result.status == expected and result.series[0].result == result.result
    assert "secret" not in caplog.text and "test-account" not in caplog.text
    assert cooldowns == ([{"retry_seconds": 8}] if status == 429 else [])


def test_account_mismatch_and_oversized_group_fail_before_io():
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("unexpected HTTP"))) as client:
        adapter = OandaRestBatch(token="secret", account_id="test-account", rest_client=client)
        other = spec(account_scope="sha256:" + hashlib.sha256(b"other").hexdigest())
        with pytest.raises(ValueError, match="scope"):
            adapter.latest([other], generation=2, sequence=1, demand_revision="d1")
        with pytest.raises(ValueError, match="12"):
            specifications([spec(f"TEST_{i}") for i in range(13)])
        result = adapter.latest([spec()], generation=2, sequence=1, demand_revision="d1",
                                deadline=time.monotonic() - 1)
        assert result.result.status == "timeout"


def test_candle_auth_probe_uses_catalog_and_latest_without_quote_calls():
    calls = []

    def handle(request):
        calls.append(request.url.path)
        if request.url.path.endswith("/summary"):
            return httpx.Response(200, json={"account": {"id": "test-account"}})
        if request.url.path.endswith("/instruments"):
            return httpx.Response(200, json={"instruments": [{"name": "EUR_USD"}]})
        assert request.url.path.endswith("/candles/latest")
        return httpx.Response(200, json={"latestCandles": [group()]})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        adapter = OandaRestBatch(token="secret", account_id="test-account", rest_client=client, clock=lambda: 61200)
        assert adapter.validate_candle_access([spec()]) == [{"name": "EUR_USD"}]
    assert len(calls) == 3 and not any("pricing" in url for url in calls)


def test_candle_auth_does_not_clear_hold_for_invalid_partial_payload():
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=(
        {"account": {"id": "test-account"}} if request.url.path.endswith("/summary") else
        {"instruments": [{"name": "EUR_USD"}]} if request.url.path.endswith("/instruments") else
        {"latestCandles": []})))) as client:
        adapter = OandaRestBatch(token="secret", account_id="test-account", rest_client=client, clock=lambda: 61200)
        with pytest.raises(MarketRequestError) as failure:
            adapter.validate_candle_access([spec()])
        assert failure.value.result == RequestResult(status="invalid_payload")
