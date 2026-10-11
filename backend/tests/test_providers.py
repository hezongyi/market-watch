from datetime import UTC, datetime

import httpx
import pytest
from alerts import market
from alerts.providers import fetch_binance
from alerts.storage import Bar, Instrument, Preference, now_ms
from sqlalchemy import select


@pytest.mark.parametrize(
    ("override", "market", "connection_mode", "expected"),
    [
        ("", "http://common-proxy:7890", "configured", "http://common-proxy:7890"),
        ("http://binance-proxy:7890", "http://common-proxy:7890", "configured", "http://binance-proxy:7890"),
        ("", "", "configured", None),
        ("http://binance-proxy:7890", "http://common-proxy:7890", "direct", None),
    ],
)
def test_binance_proxy_applies_to_maintenance_and_native_charts(monkeypatch, override, market, connection_mode, expected):
    from alerts import provider_chart
    from alerts.config import settings

    monkeypatch.setattr(settings, "binance_proxy", override)
    monkeypatch.setattr(settings, "market_proxy", market)
    monkeypatch.setattr(settings, "binance_connection_mode", connection_mode)
    original_client = httpx.Client
    calls = []

    def make_client(**kwargs):
        calls.append(kwargs)
        return original_client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=[])))

    provider_chart.close_clients()
    monkeypatch.setattr(httpx, "Client", make_client)
    try:
        fetch_binance(mode="quote")
        provider_chart.pooled_client("binance")
        assert len(calls) == 1  # Both use the same lane pool.
        assert all(call["trust_env"] is False for call in calls)
        proxy_url = getattr(calls[0]["transport"]._pool, "_proxy_url", None)
        assert (proxy_url is None) == (expected is None)
        if proxy_url is not None:
            assert proxy_url.host.decode() == httpx.URL(expected).host
    finally:
        provider_chart.close_clients()


def test_binance_pagination_preserves_prices_and_bounds():
    calls = []
    start = 1_800_000_000_000

    def handle(request):
        cursor = int(request.url.params["startTime"])
        calls.append(cursor)
        count = 1000 if cursor == start else 2
        return httpx.Response(
            200, json=[[cursor + n * 60000, "10.12345678", "12", "9", "11"] for n in range(count)]
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = fetch_binance(
            start=datetime.fromtimestamp(start / 1000, UTC).isoformat(),
            end=datetime.fromtimestamp((start + 1002 * 60000) / 1000, UTC).isoformat(),
            client=client,
        )
    assert calls == [start, start + 1000 * 60000]
    assert len(result["rows"]) == 1002
    assert result["rows"][0]["open"] == "10.12345678"
    assert result["basis"] == "last"


def test_binance_rate_limit_is_not_empty_success():
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(429))) as client:
        with pytest.raises(httpx.HTTPStatusError):
            fetch_binance(client=client)


def test_explicit_binance_direct_mode_does_not_change_other_sources(monkeypatch):
    from alerts.config import Settings
    monkeypatch.setenv("ALERTS_MARKET_PROXY", "http://common-proxy:7890")
    monkeypatch.setenv("ALERTS_BINANCE_PROXY", "http://dedicated-proxy:7890")
    monkeypatch.setenv("ALERTS_BINANCE_CONNECTION_MODE", "direct")
    settings = Settings(_env_file=None)
    assert settings.effective_binance_proxy == ""
    assert settings.effective_yahoo_proxy == "http://common-proxy:7890"
    assert settings.market_proxy == "http://common-proxy:7890"


def test_binance_transient_eof_retries_once_and_preserves_data(caplog):
    calls = []
    def response(request):
        calls.append(request)
        if len(calls) == 1:
            raise httpx.ConnectError("[SSL: UNEXPECTED_EOF_WHILE_READING] test", request=request)
        return httpx.Response(200, json=[[60000,"10.12345678","12","9","11","4"]])
    with httpx.Client(transport=httpx.MockTransport(response)) as client:
        result = fetch_binance(start="1970-01-01T00:01:00Z", end="1970-01-01T00:02:00Z", client=client)
    assert len(calls) == 2 and len(result["rows"]) == 1
    assert result["rows"][0]["open"] == "10.12345678"
    assert "type=ConnectError" in caplog.text


def test_binance_persistent_failure_is_bounded_and_certificate_failure_is_not_retried():
    import ssl
    for certificate, expected in [(False, 2), (True, 1)]:
        calls = []
        def failed(request):
            calls.append(request)
            cause = ssl.SSLCertVerificationError("test invalid certificate") if certificate else ssl.SSLEOFError("test eof")
            raise httpx.ConnectError("[URL REDACTED]", request=request) from cause
        with httpx.Client(transport=httpx.MockTransport(failed)) as client:
            with pytest.raises(httpx.ConnectError):
                fetch_binance(client=client)
        assert len(calls) == expected


def test_dukascopy_backoff_does_not_block_binance(database, monkeypatch):
    with database.begin() as db:
        db.add(Preference(key="market_backoff:dukascopy", value={"until": now_ms() + 300000}))
    calls = []

    def fetch(source, symbol, start=None, end=None, mode="live"):
        calls.append((source, symbol))
        return {"rows": []}

    monkeypatch.setattr(market, "fetch_source", fetch)
    market.once()
    assert calls == [("binance", "BTCUSDT")]
    with database.begin() as db:
        assert db.get(Instrument, "BTCUSD").source == "dukascopy"
        assert db.get(Instrument, "BTCUSDT").source == "binance"
        assert not db.scalars(select(Bar)).all()


def test_oanda_only_complete_unsmoothed_bid_minutes(monkeypatch):
    from alerts.config import settings
    from alerts.providers import fetch_oanda

    monkeypatch.setattr(settings, "oanda_token", "test-only")

    def handle(request):
        assert request.method == "GET"
        assert request.url.params["granularity"] == "M1"
        assert request.url.params["smooth"] == "false"
        assert request.url.params["price"] == "B"
        return httpx.Response(
            200,
            json={
                "candles": [
                    {
                        "time": "60.000000000",
                        "complete": True,
                        "bid": {"o": "1.1", "h": "1.2", "l": "1.0", "c": "1.15"},
                    },
                    {
                        "time": "120.000000000",
                        "complete": False,
                        "bid": {"o": "1.1", "h": "1.2", "l": "1.0", "c": "1.15"},
                    },
                ]
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = fetch_oanda(
            "EUR_USD",
            start="1970-01-01T00:01:00+00:00",
            end="1970-01-01T00:03:00+00:00",
            client=client,
        )
    assert len(result["rows"]) == 1
    assert result["rows"][0]["timestamp"] == 60000
    assert result["rows"][0]["close"] == "1.15"
    assert result["coverage"] == [
        {"start": 60000, "end": 120000, "returned": 2, "request_id": None}
    ]


def test_oanda_gateway_retry_and_no_auth_retry(monkeypatch):
    from alerts.config import settings
    from alerts.providers import fetch_oanda

    monkeypatch.setattr(settings, "oanda_token", "test-only")
    monkeypatch.setattr("time.sleep", lambda _: None)
    calls = []

    def gateway(request):
        calls.append(request)
        return httpx.Response(504) if len(calls) == 1 else httpx.Response(200, json={"candles": []})

    with httpx.Client(transport=httpx.MockTransport(gateway)) as client:
        fetch_oanda("XAU_USD", client=client)
    assert len(calls) == 2
    calls.clear()

    def forbidden(request):
        calls.append(request)
        return httpx.Response(403)

    with httpx.Client(transport=httpx.MockTransport(forbidden)) as client:
        with pytest.raises(httpx.HTTPStatusError):
            fetch_oanda("XAU_USD", client=client)
    assert len(calls) == 1
