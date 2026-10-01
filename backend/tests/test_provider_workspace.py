import json

from alerts import api as api_module
from alerts.storage import AdvancedWorkspace
from fastapi.testclient import TestClient


def test_new_defaults_provider_old_native_state_and_drawings_preserved(database):
    old_state = {"charts": [{"symbol": "XAUUSD", "drawing": {"ownerSource": "XAUUSD", "id": "old-line"}}]}
    with database.begin() as db:
        old = AdvancedWorkspace(name="旧图", document={"engine": "tv31", "schemaVersion": 1,
                                                      "symbol": "XAUUSD", "state": old_state})
        db.add(old)
        db.flush()
        ident = old.id
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            old = client.get("/api/advanced-charts/native-charts/" + ident).json()
            assert old["series_kind"] == "managed"
            assert json.loads(old["content"]) == old_state
            new = client.post("/api/advanced-charts/workspaces", json={"name": "新图"}).json()
            assert new["document"]["symbol"] == "MWP:XAUUSD"
            state = {"charts": [{"symbol": "MWP:XAUUSD", "drawing": {"ownerSource": "MWP:XAUUSD", "id": "platform-line"}}]}
            saved = client.post("/api/advanced-charts/native-charts/save", json={"id": new["id"],
                "name": new["name"], "revision": new["revision"], "symbol": "MWP:XAUUSD",
                "resolution": "240", "content": json.dumps(state)})
            assert saved.status_code == 200 and saved.json()["series_kind"] == "provider"
            loaded = client.get("/api/advanced-charts/native-charts/" + new["id"]).json()
            assert json.loads(loaded["content"]) == state
            assert client.get("/api/advanced-charts/native-charts/" + ident).json()["document"]["state"] == old_state
    finally:
        api_module.app.dependency_overrides.clear()


def test_initial_workspace_metadata_is_ephemeral_and_never_fetches_candles(database, monkeypatch):
    from alerts import provider_chart
    expected = {'id': 'BTCUSDT', 'source': 'binance', 'calendar': 'utc0', 'precision': 2,
                'basis': 'last', 'name': 'BTC/USDT', 'series_kind': 'provider'}
    monkeypatch.setattr(provider_chart, 'metadata', lambda ident: expected if ident == 'BTCUSDT' else None)
    monkeypatch.setattr(provider_chart, 'native_page', lambda *a, **kw: (_ for _ in ()).throw(
        AssertionError('startup metadata cannot acquire candles')))
    with database.begin() as db:
        row = AdvancedWorkspace(name='startup', document={'symbol': 'MWP:BTCUSDT',
                                'state': {'opaque': 'preserved'}})
        db.add(row)
        db.flush()
        ident = row.id
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: 'test'
    try:
        with TestClient(api_module.app) as client:
            loaded = client.get('/api/advanced-charts/workspaces?limit=1').json()[0]
            assert loaded['initial_symbol'] == {'ticker': 'MWP:BTCUSDT', 'metadata': expected}
            assert loaded['document']['state'] == {'opaque': 'preserved'}
            assert 'initial_symbol' not in client.get('/api/advanced-charts/workspaces').json()[0]
        with database.begin() as db:
            assert db.get(AdvancedWorkspace, ident).document == {'symbol': 'MWP:BTCUSDT',
                                                               'state': {'opaque': 'preserved'}}
    finally:
        api_module.app.dependency_overrides.clear()
