"""History and shared latest must publish the same account candle prices."""

import hashlib
import json
from types import SimpleNamespace

import httpx
import pytest
from alerts import (
    live_pricing,
    market_stream,
    oanda_worker,
    provider_cache,
    provider_chart,
    provider_service,
)
from alerts.config import settings
from alerts.market_contracts import MarketRequestError
from alerts.native_series import DEFAULTS
from alerts.oanda_rest_batch import CandleSpec, OandaRestBatch
from alerts.provider_acceptance import receipts
from alerts.provider_capabilities import versions
from alerts.storage import ProviderBar, ProviderDataset, ProviderInterest
from sqlalchemy import select

META = dict(id="OANDA:GBP_JPY", source="oanda", symbol="GBP_JPY", basis="bid",
            calendar="ny17", precision=3)


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(settings, "oanda_token", "test-secret")
    monkeypatch.setattr(settings, "oanda_account_id", "selected-account")


def candle(start, *, account=True, corrected=False):
    return dict(time=str(start), complete=True, volume=462,
                bid=dict(o="210.551" if account else "210.550",
                         h="210.564" if account else "210.563",
                         l="210.517" if account else "210.516",
                         c="210.531" if corrected else "210.530" if account else "210.529"))


def test_native_history_then_account_latest_does_not_reset_but_real_repair_does(
        database, monkeypatch, configured):
    clock = [1000000]
    for module in (provider_chart, provider_cache, oanda_worker):
        monkeypatch.setattr(module, "now_ms", lambda: clock[0])
    corrected = [False]
    paths = []

    def respond(request):
        paths.append(request.url.path)
        if request.url.path.endswith("/candles/latest"):
            return httpx.Response(200, json={"latestCandles": [dict(instrument="GBP_JPY",
                granularity="M5", candles=[candle(0, corrected=corrected[0]), candle(300)])]})
        account = "/accounts/selected-account/" in request.url.path
        return httpx.Response(200, json={"candles": [candle(0, account=account), candle(300, account=account)]})

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        history = provider_chart.native_page(META, "M5", clock[0], 3, client=client)
        key = provider_cache.ensure(META, "M5")
        lease = provider_cache.claim(key)
        provider_cache.commit_page(key, lease, history, clock[0], clock[0])
        provider_cache.release(key, lease)
        state = dict(history_accepted=True, loaded_after=0, loaded_before=300000,
                     cursor=300000, observed_at=clock[0], provider_acceptance=receipts(history["bars"], False))
        task = SimpleNamespace(query=dict(instrument=META["id"], series_kind="provider", timeframe="M5"),
                               identity=dict(dataset_id=key))
        sub = SimpleNamespace(listener="chart", generation=1, state=state)
        ownership = live_pricing.claim(settings.oanda_account_id, now=clock[0])
        epoch = live_pricing.begin_connection(ownership, {}, now=clock[0])
        spec = CandleSpec.from_provider_metadata(META, "M5")
        adapter = OandaRestBatch(token=settings.oanda_token, account_id=settings.oanda_account_id,
                                 rest_client=client, clock=lambda: clock[0])
        for repair in (False, True):
            corrected[0] = repair
            clock[0] += 1000
            batch = adapter.latest([spec], generation=epoch, sequence=1 + repair, demand_revision="demand")
            oanda_worker.publish_native_rest_batch(ownership, epoch, batch, [(key, "M5", spec)])
            page = provider_cache.snapshot(key, clock[0], 3)
            payload = dict(type="bars", bars=page["bars"], latest_bar=page["bars"][-1:], latest_time=300000)
            with database.begin() as db:
                result = market_stream.delivery(db, task, sub, payload, {})
            assert result["type"] == ("reset" if repair else "bars"), result
            if repair:
                assert result["reason"] == "history_changed"
    assert paths[0] == "/v3/accounts/selected-account/instruments/GBP_JPY/candles"


def test_history_sends_same_units_and_calendar_as_latest(configured):
    spec = CandleSpec.from_provider_metadata(META, "M5")
    def respond(request):
        assert request.url.path == "/v3/accounts/selected-account/instruments/GBP_JPY/candles"
        assert request.url.params["units"] == spec.units == "1"
        for name, value in spec.parameters.model_dump().items():
            assert request.url.params[name] == (str(value).lower() if isinstance(value, bool) else str(value))
        assert request.headers["authorization"] == "Bearer test-secret"
        return httpx.Response(200, json={"candles": []})
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        assert provider_chart.native_page(META, "M5", 1000000, 3, client=client)["bars"] == []


@pytest.mark.parametrize("missing", ["oanda_token", "oanda_account_id"])
def test_history_rejects_missing_credentials_without_http(monkeypatch, configured, missing):
    monkeypatch.setattr(settings, missing, "")
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("must validate before HTTP"))) as client:
        with pytest.raises(ValueError, match="OANDA"):
            provider_chart.native_page(META, "M5", 1000000, 3, client=client)


@pytest.mark.parametrize("parameters", [DEFAULTS, {**DEFAULTS, "price": "A"},
    {**DEFAULTS, "dailyAlignment": 0, "alignmentTimezone": "UTC"}])
def test_new_cache_isolates_legacy_rows_and_preserves_account_scope(
        database, monkeypatch, configured, parameters):
    meta = {**META, "native_parameters": parameters}
    legacy_version = "native-bid-ny17-sunday-v1" if parameters == DEFAULTS else (
        "oanda-native-parameters-v1:" + hashlib.sha256(json.dumps(parameters,
            sort_keys=True, separators=(",", ":")).encode()).hexdigest())
    def old_versions(_):
        return (legacy_version, "volume-v1")
    with monkeypatch.context() as old:
        old.setattr(provider_cache, "versions", old_versions)
        old_key = provider_cache.ensure(meta, "M5")
        lease = provider_cache.claim(old_key)
        provider_cache.commit_page(old_key, lease, {"bars": [dict(start=0, end=300000,
            chart_time=0, open="1", high="2", low="1", close="1", complete=True)],
            "history_boundary": True}, 300000, 1000000)
        provider_cache.release(old_key, lease)
    new_key = provider_cache.ensure(meta, "M5")
    assert new_key != old_key
    assert provider_cache.snapshot(new_key, 300000, 1)["bars"] == []
    with database.begin() as db:
        assert db.get(ProviderDataset, old_key)
        assert db.scalar(select(ProviderBar).where(ProviderBar.dataset_id == old_key)).payload["close"] == "1"
        for key in (old_key, new_key):
            db.add(ProviderInterest(id=key, client="test", listener=key, dataset_id=key,
                subscribed=True, accessed_at=live_pricing.now_ms(), expires=live_pricing.now_ms() + 60000))
    assert [row.id for row in live_pricing.desired_native_provider_datasets(settings.oanda_account_id)] == [new_key]
    with database.begin() as db:
        old_interest = db.get(ProviderInterest, old_key)
        old_interest.subscribed = False
        old_interest.targets = [dict(frame="M5", before=300000, count=3, done=False, next_at=0)]
    with monkeypatch.context() as guard:
        guard.setattr(provider_cache, "ensure", lambda *a, **kw: pytest.fail("obsolete interest must not warm"))
        assert provider_service.warm_step("oanda") == (None, False)
    monkeypatch.setattr(settings, "oanda_token", "rotated-secret")
    assert provider_cache.identity(meta, "M5") == new_key
    monkeypatch.setattr(settings, "oanda_account_id", "another-account")
    assert provider_cache.identity(meta, "M5") != new_key
    assert versions({**meta, "source": "dukascopy"}) == (
        "dukascopy-json3-bid-utc-splits-stocks-v1", "dukascopy-native-quantity-v1")


def test_catalog_validates_explicit_account_even_when_not_first(configured):
    paths = []
    def respond(request):
        paths.append(request.url.path)
        if request.url.path == "/v3/accounts":
            return httpx.Response(200, json={"accounts": [{"id": "other-account"}, {"id": "selected-account"}]})
        assert request.url.path == "/v3/accounts/selected-account/instruments"
        return httpx.Response(200, json={"instruments": [{"name": "GBP_JPY"}]})
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        adapter = OandaRestBatch(token="test-secret", account_id="selected-account", rest_client=client)
        assert adapter.catalog() == [{"name": "GBP_JPY"}]
    assert paths == ["/v3/accounts", "/v3/accounts/selected-account/instruments"]


@pytest.mark.parametrize("payload,status,error", [
    ({"accounts": [{"id": "other-account"}]}, 200, MarketRequestError),
    ({"accounts": []}, 200, MarketRequestError),
    ({"accounts": "invalid"}, 200, ValueError),
    ({"accounts": [{}]}, 200, ValueError),
    ({"errorMessage": "private upstream content"}, 401, httpx.HTTPStatusError),
])
def test_invalid_account_fails_before_catalog_and_logs_no_credentials(payload, status, error, caplog):
    paths = []
    def respond(request):
        paths.append(request.url.path)
        return httpx.Response(status, json=payload)
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        adapter = OandaRestBatch(token="test-secret", account_id="selected-account", rest_client=client)
        with pytest.raises(error) as failure:
            adapter.catalog()
        if isinstance(failure.value, MarketRequestError):
            assert failure.value.result.status == "unauthorized"
    assert paths == ["/v3/accounts"]
    assert not any(secret in caplog.text for secret in ("test-secret", "selected-account", "private upstream content"))
