import json

import pytest
from alerts import api as api_module
from alerts import live_pricing as live
from alerts.storage import MarketDataset, MarketDemand, Preference
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_live_pricing import running as _running

running = _running


def test_live_reads_require_authentication(database):
    with TestClient(api_module.app) as client:
        assert client.get("/api/market-data/live").status_code == 401
        assert client.get('/api/market-data/live/provider-status').status_code == 401
        assert client.get('/api/market-data/live/status').status_code == 401
        assert client.get("/api/market-data/live/metrics/unknown").status_code == 401
        assert client.post("/api/market-data/live/demand", json={}).status_code == 401


def test_api_lifespan_does_not_start_chart_alert_monitor(database, monkeypatch):
    from alerts import alert_monitor, provider_service, provider_transport

    monkeypatch.setattr(provider_service, "start", lambda: None)
    monkeypatch.setattr(provider_service, "stop", lambda: None)
    monkeypatch.setattr(provider_transport, "start", lambda *_args: pytest.fail(
        "API lifespan must not own provider transport maintenance"))
    monkeypatch.setattr(alert_monitor, "run", lambda *_args, **_kwargs: pytest.fail(
        "API lifespan must not own ChartAlert evaluation"))

    with TestClient(api_module.app):
        pass


def test_snapshot_hides_uncollected_catalog_and_browser_demands_extend_shared_union(running):
    factory, _, _, _ = running
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            assert {row["logical_symbol"] for row in client.get("/api/market-data/live").json()} == {"EURUSD", "XAUUSD"}
            with factory.begin() as db:
                dataset = db.scalar(select(MarketDataset).where(MarketDataset.logical_symbol == "GBPUSD"))
                key = dataset.id
            body = {"client": "browser-one", "dataset_id": key}
            assert client.post("/api/market-data/live/demand", json=body).status_code == 200
            assert client.post("/api/market-data/live/demand", json=body).status_code == 200
            assert client.post("/api/market-data/live/demand", json=body | {"dataset_id": "a" * 64}).status_code == 422
            assert client.get(f"/api/market-data/live/metrics/{key}?since=-1").status_code == 422
        with factory.begin() as db:
            assert len(list(db.scalars(select(MarketDemand)))) == 1
        assert set(live.desired_datasets("test-account")) == {"EUR_USD", "XAU_USD", "GBP_USD"}
    finally:
        api_module.app.dependency_overrides.clear()


def test_registered_source_identity_is_available_and_saved_in_chart_workspace(running):
    _, _, _, identities = running
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            catalog = client.get("/api/charts/catalog").json()
            instrument = next(row["id"] for row in catalog["managed_sources"] if row["symbol"] == "EURUSD")
            workspace = client.post("/api/advanced-charts/workspaces", json={"name": "source chart"}).json()
            workspace["document"]["state"] = {"charts": [{"symbol": instrument}]}
            saved = client.post(f'/api/advanced-charts/workspaces/{workspace["id"]}/save', json={
                "name": workspace["name"], "revision": workspace["revision"], "document": workspace["document"]})
            assert saved.status_code == 200
            assert saved.json()["document"]["state"]["charts"][0]["symbol"] == instrument
            instruments = client.get("/api/instruments").json()
            live_row = next(row for row in instruments if row["id"] == instrument)
            assert live_row["dataset_identity"]["environment"] == "practice"
            assert live_row["logical_symbol"] == "EURUSD"
            metrics = client.get(f'/api/market-data/live/metrics/{identities["EUR_USD"].key}')
            assert metrics.status_code == 200
    finally:
        api_module.app.dependency_overrides.clear()


def test_live_snapshot_reports_shared_rest_cooldown_without_changing_quote_readiness(running):
    factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    from test_live_pricing import candles, quote

    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    live.publish_event(ownership, epoch, quote(identity, epoch), identities, now=125000)
    with factory.begin() as db:
        db.add(Preference(key="upstream_slots:oanda", value={"cooldown_until": 155000.5}))
        db.add(Preference(key="upstream_slots:dukascopy", value={"cooldown_until": 999999}))
    rows = live.snapshots(now=125000)
    assert {row["cooldown_until"] for row in rows} == {155001}
    eur = next(row for row in rows if row["dataset_id"] == identity.key)
    assert eur["quote_ready"] and eur["candle_ready"]
    assert eur["quality"] == "healthy"
    assert all(row["cooldown_until"] is None for row in live.snapshots(now=155001))


def test_snapshot_signature_detects_cooldown_change_without_new_quote_or_epoch():
    from alerts.live_api import snapshot_signature

    row = {"dataset_id": "dataset", "revision": 2, "quality": "healthy", "cooldown_until": None}
    assert snapshot_signature([row]) != snapshot_signature([row | {"cooldown_until": 200000}])
    assert snapshot_signature([row]) == snapshot_signature([dict(row)])
    assert snapshot_signature([row | {'authentication_hold': True}]) != snapshot_signature([row])
    assert snapshot_signature([row | {'market_session': 'closed'}]) != snapshot_signature([row])


def test_retry_never_clears_auth_fault_or_accelerates_probes(running, monkeypatch):
    from alerts.config import settings
    from alerts.market_contracts import RequestResult
    from alerts.storage import PricingOwner

    factory, ownership, epoch, identities = running
    monkeypatch.setattr(settings, 'oanda_account_id', 'test-account')
    live.disconnected(ownership, epoch, identities, RequestResult(status='unauthorized'), now=125000)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: 'test'
    try:
        with TestClient(api_module.app) as client:
            status = client.get('/api/market-data/live/provider-status').json()
            assert status['authentication_hold']
            assert client.get('/api/market-data/live/status').json()['provider']['authentication_hold']
            for _ in range(3):
                assert client.post('/api/market-data/live/retry').status_code == 200
        with factory.begin() as db:
            owner = db.get(PricingOwner, ownership[0])
            assert owner.error == 'unauthorized'
            assert owner.next_at == 125000 + settings.oanda_auth_probe_seconds * 1000
    finally:
        api_module.app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_sse_publishes_cooldown_start_and_expiry_with_unchanged_revision(monkeypatch):
    from alerts import live_api

    deadlines = iter((None, 200000, None))
    monkeypatch.setattr(live_api, "snapshots", lambda: [{"dataset_id": "dataset", "revision": 2,
        "quality": "healthy", "cooldown_until": next(deadlines)}])

    async def no_delay(_):
        return None

    monkeypatch.setattr(live_api.asyncio, "sleep", no_delay)

    class Request:
        remaining = 3

        async def is_disconnected(self):
            self.remaining -= 1
            return self.remaining < 0

    route = next(route for route in live_api.router(lambda: "test").routes
                 if route.path.endswith("/events"))
    response = await route.endpoint(Request())
    snapshots = []
    async for event in response.body_iterator:
        if event.startswith("event: snapshot"):
            snapshots.append(json.loads(event.split("data: ")[1])[0])
    assert [row["cooldown_until"] for row in snapshots] == [None, 200000, None]


def test_source_chart_is_readable_but_cannot_create_legacy_alert(running):
    factory, _, _, _ = running
    from alerts import business
    from alerts.storage import ChartAlertVersion
    from test_chart_alert_service import config

    with factory.begin() as db:
        dataset = db.scalar(select(MarketDataset).where(MarketDataset.logical_symbol == "EURUSD"))
        instrument = dataset.instrument_id
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            response = client.post("/api/chart-alerts", json={"request_id": "source-integration",
                "config": config(instrument=instrument, source="oanda", timeframe="M1").model_dump(mode="json")})
            assert response.status_code == 422, response.text
            assert "必须绑定组合行情" in response.json()["detail"]
        with factory.begin() as db:
            assert db.scalar(select(ChartAlertVersion)) is None
        assert instrument in {row["id"] for row in business.instruments()}
    finally:
        api_module.app.dependency_overrides.clear()


def test_shared_chart_query_renews_source_demand(running):
    factory, _, _, _ = running
    with factory.begin() as db:
        dataset = db.scalar(select(MarketDataset).where(MarketDataset.logical_symbol == "GBPUSD"))
        instrument = dataset.instrument_id
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            response = client.post("/api/charts/data", json={"instrument": instrument,
                "series_kind": "managed", "timeframe": "M1", "client": "merged-source-chart"})
            assert response.status_code == 200
        with factory.begin() as db:
            assert db.scalar(select(MarketDemand).where(
                MarketDemand.instrument_id == instrument)) is not None
    finally:
        api_module.app.dependency_overrides.clear()


def test_source_status_reports_configuration_without_exposing_credentials(database, monkeypatch):
    from alerts.config import settings

    monkeypatch.setattr(settings, 'oanda_account_id', '')
    monkeypatch.setattr(settings, 'oanda_token', '')
    empty = live.provider_status()
    assert empty['configured'] is False
    assert empty['collection_recorded'] is False
    assert empty['error_observed_at'] is None
    assert empty['connection_started_at'] is None
    monkeypatch.setattr(settings, 'oanda_account_id', 'status-test-account')
    assert live.provider_status()['configured'] is False
    monkeypatch.setattr(settings, 'oanda_token', 'status-test-secret-token')
    configured = live.provider_status()
    assert configured['configured'] is True
    assert configured['collection_recorded'] is False
    assert configured['error'] is None
    assert 'status-test-account' not in str(configured)
    assert 'status-test-secret-token' not in str(configured)


def test_source_status_never_borrows_probe_time_for_stream_error(running, monkeypatch):
    from alerts.config import settings
    from alerts.market_contracts import RequestResult

    factory, ownership, epoch, identities = running
    monkeypatch.setattr(settings, 'oanda_account_id', 'test-account')
    live.disconnected(ownership, epoch, identities, RequestResult(status='timeout'), now=125000)
    with factory.begin() as db:
        db.merge(Preference(key='oanda_probe_status:' + ownership[0],
                            value={'error': 'timeout', 'observed_at': 120000}))
    status = live.provider_status(now=130000)
    assert status['error'] == 'timeout'
    assert status['error_observed_at'] is None
    assert status['authentication_probe_at'] == 120000
    assert status['collection_recorded'] is True


def test_source_status_auth_probe_observation_belongs_to_its_actual_error(running, monkeypatch):
    from alerts.config import settings
    from alerts.market_contracts import RequestResult
    from alerts.storage import PricingOwner

    factory, ownership, epoch, identities = running
    monkeypatch.setattr(settings, 'oanda_account_id', 'test-account')
    live.disconnected(ownership, epoch, identities, RequestResult(status='unauthorized'), now=125000)
    assert live.provider_status()['error_observed_at'] is None
    with factory.begin() as db:
        due = db.get(PricingOwner, ownership[0]).next_at
    probe = live.claim_auth_probe('test-account', now=due)
    live.finish_auth_probe(probe, RequestResult(status='timeout'), now=due + 1)
    status = live.provider_status(now=due + 2)
    assert status['authentication_hold'] is True
    assert status['error'] == 'timeout'
    assert status['error_observed_at'] == due + 1
    assert status['authentication_probe_at'] == due + 1
    # A missing observation stays missing; the read clock does not fill it.
    with factory.begin() as db:
        db.merge(Preference(key='oanda_probe_status:' + ownership[0], value={'error': 'timeout'}))
    assert live.provider_status(now=due + 999)['error_observed_at'] is None


def test_source_status_only_shows_configured_account_and_reads_do_not_write(running, monkeypatch):
    from alerts.config import settings
    from alerts.storage import LiveState, PricingOwner

    factory, _, _, _ = running
    monkeypatch.setattr(settings, 'oanda_account_id', 'other-account')
    monkeypatch.setattr(settings, 'oanda_token', 'test-token')
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: 'test'

    def stored():
        with factory.begin() as db:
            return {
                'owners': [(row.id, row.token, row.expires, row.next_at, row.error) for row in db.scalars(select(PricingOwner))],
                'states': [(row.dataset_id, row.revision, row.connection, row.quote, row.ready) for row in db.scalars(select(LiveState))],
                'demand': [(row.id, row.expires) for row in db.scalars(select(MarketDemand))],
                'preferences': [(row.key, row.value) for row in db.scalars(select(Preference))],
            }

    before = stored()
    try:
        with TestClient(api_module.app) as client:
            assert client.get('/api/market-data/live/status').json()['datasets'] == []
            monkeypatch.setattr(settings, 'oanda_account_id', 'test-account')
            for _ in range(3):
                response = client.get('/api/market-data/live/status')
                assert response.status_code == 200
                body = response.json()
                assert {row['logical_symbol'] for row in body['datasets']} == {'EURUSD', 'XAUUSD'}
                assert all('quote_ready' in row and 'candle_ready' in row for row in body['datasets'])
                assert body['provider']['collection_recorded'] is True
        assert stored() == before
    finally:
        api_module.app.dependency_overrides.clear()
