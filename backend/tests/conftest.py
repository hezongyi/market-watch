import pytest
from alerts import api as api_module
from alerts import storage
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def database(monkeypatch):
    monkeypatch.setattr(storage.settings, "fx_source", "dukascopy")
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    storage.bootstrap(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    monkeypatch.setattr(api_module, "bootstrap", lambda: None)
    yield factory
    engine.dispose()
