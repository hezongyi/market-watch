"""Signal-level slow-source assertions for the isolated stage-5 top-up fixture."""

import json
import time

import httpx


def fresh(value):
    source = value["source"]
    return (source and source["ready"] and source["owner_valid"]
            and 0 <= source["received_age_ms"] < 15_000)


def boots(value):
    return {role: row["boot_id"] for role, row in value["roles"].items()}


def chain(value, ident):
    signals = [row for row in value["signals"] if row["rule"] == ident]
    ids = {row["id"] for row in signals}
    notes = [row for row in value["notifications"] if row["signal"] in ids]
    note_ids = {row["id"] for row in notes}
    outbox = [row for row in value["outbox"] if row["notification"] in note_ids]
    return signals, notes, outbox


def run(phase, seconds, fixture):
    def sample(label):
        return fixture.snapshot("a09-" + label, quiet=True)

    path = fixture.ROOT / "a09-baseline.json"
    if phase == "prepare":
        from alerts.chart_alert_service import lifecycle
        from alerts.storage import ChartAlert, Session, now_ms

        value = sample("before-prepare")
        assert fresh(value), value["source"]
        ident = next(rule for rule, mode in fixture.CONTROL["rule_modes"].items()
                     if mode == "price_intrabar")
        with Session.begin() as db:
            for rule in fixture.CONTROL["rules"]:
                row = db.get(ChartAlert, rule)
                if row.status == "active":
                    lifecycle(db, rule, row.version, "pause",
                              expected_revision=row.control_revision,
                              request_id="a09-pause-" + rule, at=now_ms())
        with Session.begin() as db:
            row = db.get(ChartAlert, ident)
            lifecycle(db, ident, row.version, "restart",
                      expected_revision=row.control_revision,
                      request_id="a09-restart-" + ident, at=now_ms())
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = sample("baseline")
            rule = next(row for row in value["rules"] if row["id"] == ident)
            if fresh(value) and rule["health"] == "ready" and rule["status"] == "active":
                break
            time.sleep(.5)
        assert fresh(value) and rule["health"] == "ready" and rule["status"] == "active", rule
        assert rule["count"] == 0 and not chain(value, ident)[0], rule
        assert float(rule["state"]["left"]) < 1.115, rule["state"]
        assert all(row["status"] == "paused" for row in value["rules"] if row["id"] != ident)
        fixture.write(path, {"rule": ident, "snapshot": value})
        print(json.dumps({"phase": phase, "passed": True, "rule": ident}), flush=True)
        return

    baseline = json.loads(path.read_text())
    ident, before = baseline["rule"], baseline["snapshot"]
    value = sample(phase + "-before")
    assert fresh(value) and boots(value) == boots(before), value["source"]
    if phase == "fault-ready":
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = sample("fault-ready")
            assert fresh(value) and boots(value) == boots(before), value["source"]
            slow = next(row for row in value["interests"] if row["id"] == "acceptance-slow-source")
            if slow["error"] == "ReadTimeout":
                break
            time.sleep(.5)
        assert slow["error"] == "ReadTimeout", slow
        print(json.dumps({"phase": phase, "passed": True}), flush=True)
    elif phase == "crossing":
        assert seconds >= 10, "Observe at least ten seconds after crossing"
        slow = next(row for row in value["interests"] if row["id"] == "acceptance-slow-source")
        assert slow["error"] == "ReadTimeout", slow
        supplier = httpx.get("http://fixture-supplier:8080/fixture/state").json()
        assert supplier["slow_hits"] > 0, supplier["slow_hits"]
        assert not chain(value, ident)[0]
        fault_before = value
        baseline_rule = next(row for row in before["rules"] if row["id"] == ident)
        fixture.price("1.119")
        deadline = time.monotonic() + seconds
        samples = []
        while time.monotonic() < deadline:
            value = sample("crossing")
            assert fresh(value) and boots(value) == boots(before), value["source"]
            rule = next(row for row in value["rules"] if row["id"] == ident)
            assert rule["status"] == "active" and rule["health"] == "ready", rule
            assert all(rule[key] == baseline_rule[key]
                       for key in ("run", "control_revision", "version")), rule
            slow = next(row for row in value["interests"] if row["id"] == "acceptance-slow-source")
            assert slow["error"] == "ReadTimeout", slow
            signals, notes, outbox = chain(value, ident)
            assert max(len(signals), len(notes), len(outbox)) <= 1
            samples.append({"at": value["business_at"], "source": value["source"],
                            "slow_error": slow["error"], "signals": len(signals),
                            "notifications": len(notes), "outbox": len(outbox),
                            "count": rule["count"]})
            time.sleep(.5)
        assert len(signals) == len(notes) == len(outbox) == rule["count"] == 1
        assert notes[0]["kind"] == "signal" and notes[0]["signal"] == signals[0]["id"]
        fixture.write(fixture.ROOT / "a09-signal-proof.json", {
            "rule": ident, "before": before, "fault_before_crossing": fault_before,
            "after": value, "samples": samples, "passed": True})
        print(json.dumps({"phase": phase, "passed": True, "samples": len(samples),
                          "signal": signals[0]["id"], "notification": notes[0]["id"],
                          "outbox": outbox[0]["id"]}), flush=True)
    elif phase == "released":
        assert not any(row["id"] == "acceptance-slow-source" for row in value["interests"])
        expected = json.loads((fixture.ROOT / "a09-signal-proof.json").read_text())["after"]
        assert [[row["id"] for row in rows] for rows in chain(value, ident)] == [
            [row["id"] for row in rows] for rows in chain(expected, ident)]
        assert value["source"]["revision"] > expected["source"]["revision"]
        fixture.write(fixture.ROOT / "a09-released.json", value)
        print(json.dumps({"phase": phase, "passed": True}), flush=True)
    else:
        raise ValueError("Unknown A09 phase: " + phase)
