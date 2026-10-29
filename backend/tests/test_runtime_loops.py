"""The weekly switch, activation and cleanup cycles inside the fixed profiles."""

import threading
from contextlib import nullcontext

from alerts import data_runtime, market_runtime, runtime_health, switch_schedule
from alerts.runtime_supervisor import Loop
from alerts.storage import Preference, now_ms


class Reporter:
    """Record the heartbeat registration the profiles hand to runtime_health."""

    def __init__(self, deadlines, claimed):
        self.deadlines, self.claimed = deadlines, claimed

    def __call__(self, group, role, boot_id, *, deadline_ms=0):
        self.deadlines[role] = deadline_ms
        self.claimed.append(role)
        return self

    def claim(self):
        return None

    def record(self, **kwargs):
        return None


def test_data_profile_owns_the_weekly_window_and_its_cleanup():
    loops = data_runtime.build_loops()
    roles = [loop.role for loop in loops]
    assert roles[-2:] == ["switch_shadow", "retention"]
    assert len(roles) == len(set(roles))
    assert [loop.run for loop in loops[-2:]] == [switch_schedule.run_shadow,
                                                switch_schedule.run_retention]


def test_market_profile_owns_activation_when_it_is_enabled(monkeypatch):
    from alerts.config import settings

    assert [loop.role for loop in market_runtime.build_loops()][-1] == "switch_activation"
    monkeypatch.setattr(settings, "switch_auto_activate_enabled", False)
    assert "switch_activation" not in [loop.role for loop in market_runtime.build_loops()]


def test_data_profile_reports_a_heartbeat_and_deadline_for_the_new_loops(database, monkeypatch):
    deadlines, claimed, selected = {}, [], []
    reporter = Reporter(deadlines, claimed)
    monkeypatch.setattr(data_runtime.runtime_health, "Progress", reporter)
    monkeypatch.setattr(data_runtime.runtime_health, "boot", lambda: "boot")
    monkeypatch.setattr("alerts.config.settings.oanda_native_latest_owner", "provider")
    monkeypatch.setattr("alerts.storage.bootstrap", lambda: None)
    monkeypatch.setattr("alerts.swing_sr.register_indicator", lambda: None)
    monkeypatch.setattr("alerts.provider_chart.warm_clients", lambda: None)
    monkeypatch.setattr("alerts.yahoo_catalog.seed", lambda: None)
    monkeypatch.setattr("alerts.akshare_catalog.seed", lambda: None)
    monkeypatch.setattr(data_runtime, "ownership", lambda _engine: nullcontext(lambda _stop: None))
    monkeypatch.setattr("alerts.provider_transport.close_clients", lambda: None)
    monkeypatch.setattr(data_runtime, "run_group",
                        lambda loops, **kwargs: selected.extend(loop.role for loop in loops))

    data_runtime.run(stop=threading.Event(), handle_signals=False)

    assert deadlines["switch_shadow"] == 300_000
    assert deadlines["retention"] == 300_000
    assert selected[-3:] == ["switch_shadow", "retention", "data_ownership"]
    assert {"switch_shadow", "retention", "data_ownership"} <= set(claimed)


def test_market_profile_reports_a_heartbeat_for_the_activation_loop(database, monkeypatch):
    deadlines, claimed = {}, []
    reporter = Reporter(deadlines, claimed)
    monkeypatch.setattr(market_runtime.runtime_health, "Progress", reporter)
    monkeypatch.setattr(market_runtime.runtime_health, "boot", lambda: "boot")
    monkeypatch.setattr("alerts.config.settings.oanda_native_latest_owner", "provider")
    monkeypatch.setattr("alerts.storage.bootstrap", lambda: None)
    monkeypatch.setattr("alerts.swing_sr.register_indicator", lambda: None)
    monkeypatch.setattr(market_runtime, "ownership", lambda _engine: nullcontext(lambda _stop: None))
    monkeypatch.setattr("alerts.provider_transport.close_clients", lambda: None)
    monkeypatch.setattr(market_runtime, "run_group", lambda loops, **kwargs: None)

    market_runtime.run(stop=threading.Event(),
                       loops=(Loop("switch_activation", switch_schedule.run_activation),),
                       handle_signals=False)

    assert deadlines["switch_activation"] == 60_000
    assert "switch_activation" in claimed


def test_switch_roles_are_in_the_existing_health_scope(monkeypatch):
    from alerts.config import settings

    monkeypatch.setattr(settings, "switch_auto_activate_enabled", True)
    assert {"data:switch_shadow", "data:retention", "market:switch_activation"} <= set(
        runtime_health.expected_roles())


def test_a_disabled_activation_loop_is_not_a_fault(database, monkeypatch):
    from alerts import notification_runtime
    from alerts.config import settings

    monkeypatch.setattr(settings, "switch_auto_activate_enabled", False)
    assert "market:switch_activation" not in runtime_health.expected_roles()
    notification_runtime.inspect_health()
    with database() as db:
        assert db.get(Preference, "runtime_incident:market:switch_activation") is None


def test_a_missing_or_stale_activation_loop_is_reported(database, monkeypatch):
    from alerts import notification_runtime
    from alerts.config import settings

    monkeypatch.setattr(settings, "switch_auto_activate_enabled", True)
    assert "market:switch_activation" in runtime_health.expected_roles()
    notification_runtime.inspect_health()
    with database() as db:
        incident = db.get(Preference, "runtime_incident:market:switch_activation")
        assert incident.value["category"] == "missing"
    with database.begin() as db:
        db.add(Preference(key=runtime_health.key("switch_activation"), value={
            "role": "switch_activation", "boot_id": "boot", "state": "idle",
            "started_at": now_ms(), "checked_at": now_ms() - 60_000,
            "stale_after_ms": 60_000, "error_type": None}))
    notification_runtime.inspect_health()
    with database() as db:
        incident = db.get(Preference, "runtime_incident:market:switch_activation")
        assert incident.value["category"] == "stale"


def test_health_reports_a_new_role_as_missing_or_stale(database):
    """The existing fenced heartbeat reader already covers the new roles."""
    with database() as db:
        assert runtime_health.summary(db, ("switch_shadow",))[0]["state"] == "missing"
    with database.begin() as db:
        db.add(Preference(key=runtime_health.key("retention"), value={
            "role": "retention", "state": "idle", "started_at": now_ms(),
            "checked_at": now_ms() - 600_000, "stale_after_ms": 300_000,
            "error_type": None}))
    with database() as db:
        assert runtime_health.summary(db, ("retention",))[0]["state"] == "stale"
