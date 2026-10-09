"""Exercise synthetic composite inputs through the real writers/calculator."""

import importlib.util
import json
import sys
from pathlib import Path

import pytest
from alerts import live_pricing
from alerts import market_stream as stream
from alerts.chart_api import DataQuery
from alerts.history_artifacts import artifact_tick
from alerts.market_stream_api import Subscription, resolve
from alerts.market_stream_worker import Calculator
from alerts.series_access import chart_data
from alerts.storage import transaction
from sqlalchemy import select
from test_market_stream import session

directory = Path(__file__).resolve().parents[2] / "scripts"
for name in ("unified_sse_acceptance_fixture", "unified_sse_composite_fixture"):
    spec = importlib.util.spec_from_file_location(name,directory / (name+".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
fixture = sys.modules["unified_sse_composite_fixture"]


def invoke(monkeypatch,capsys,*args):
    monkeypatch.setattr(sys,"argv",["fixture",*args])
    fixture.main()
    return json.loads(capsys.readouterr().out)


def test_owned_composite_fixture_drives_shared_authoritative_quote_overlay(database,monkeypatch,capsys):
    monkeypatch.setattr(fixture,"guard",lambda:None)
    monkeypatch.setattr(fixture.settings,"oanda_account_id","")
    monkeypatch.setattr(fixture.settings,"oanda_token","")
    seeded = invoke(monkeypatch,capsys,"seed")
    assert invoke(monkeypatch,capsys,"seed")["version"] == seeded["version"]
    for _ in range(100):
        if not artifact_tick(seeded["version"]):
            break
    else:
        pytest.fail("Fixture artifacts did not finish")
    active = invoke(monkeypatch,capsys,"activate")
    query = DataQuery(instrument=active["composite"],series_kind="composite",timeframe="W1",provisional=True)
    identity,serialized = resolve(Subscription(client="fixture",listener="chart",generation=1,kind="bars",query=query))
    owner = session(database)
    for client in ("fixture","second"):
        stream.register(owner,client,"chart",1,identity,serialized,{})
    calculator = Calculator()
    cursors = {}
    for close in ("1.121","1.122"):
        invoke(monkeypatch,capsys,"quote","--bid",close)
        work = stream.claim()
        payload,_ = calculator.build(work)
        stream.commit(work,payload,delay_ms=0)
        assert stream.events(owner,"fixture",cursors)[-1]["bars"][-1]["close"] == close
        with transaction() as db:
            assert payload["bars"] == chart_data(db,query)["bars"]
    assert calculator.buckets.builds == 1
    invoke(monkeypatch,capsys,"expire")


def test_synthetic_composite_refuses_supplier_credentials_before_database(monkeypatch):
    monkeypatch.setattr(fixture,"guard",lambda:None)
    monkeypatch.setattr(fixture.settings,"oanda_account_id","a-practice-account")
    monkeypatch.setattr(sys,"argv",["fixture","seed"])
    monkeypatch.setattr(fixture,"transaction",lambda:pytest.fail("must refuse before DB"))
    with pytest.raises(SystemExit,match="credential-free"):
        fixture.main()


def test_repeated_fixture_runs_fill_confirmation_gaps_without_rewriting_existing_inputs(database,monkeypatch,capsys):
    monkeypatch.setattr(fixture,"guard",lambda:None)
    monkeypatch.setattr(fixture.settings,"oanda_account_id","")
    monkeypatch.setattr(fixture.settings,"oanda_token","")
    clock = [fixture.now_ms()]
    monkeypatch.setattr(fixture,"now_ms",lambda:clock[0])
    monkeypatch.setattr(live_pricing,"now_ms",lambda:clock[0])
    seeded = invoke(monkeypatch,capsys,"seed")
    while artifact_tick(seeded["version"]):
        pass
    active = invoke(monkeypatch,capsys,"activate")
    invoke(monkeypatch,capsys,"quote","--bid","1.121")
    with transaction() as db:
        before = {row.start:row.source_revision_id for row in db.scalars(select(fixture.CompositeMinute).where(
            fixture.CompositeMinute.revision_id == active["revision"]))}
    # A stopped synthetic source leaves multiple missing confirmation minutes.
    clock[0] += 3 * fixture.WIDTH
    invoke(monkeypatch,capsys,"quote","--bid","1.122")
    with transaction() as db:
        after = {row.start:row.source_revision_id for row in db.scalars(select(fixture.CompositeMinute).where(
            fixture.CompositeMinute.revision_id == active["revision"]))}
        value = db.get(fixture.Preference,fixture.MARKER).value
        assert set(after) == set(range(value["seam"],value["confirmed_cursor"],fixture.WIDTH))
        assert {at:after[at] for at in before} == before
        assert len(after) > len(before)
    invoke(monkeypatch,capsys,"expire")
