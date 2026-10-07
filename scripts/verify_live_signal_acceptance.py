"""Real quote -> rule -> signal -> local notification/outbox; no external delivery."""

import json
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]


def main():
    result = {"host": "Ubuntu local isolated Docker", "started_at": int(time.time() * 1000),
              "external_delivery": "disabled; not exercised", "passed": False}
    watch_id = None
    with httpx.Client(base_url="http://127.0.0.1:16589", timeout=15, trust_env=False) as client:
        response = client.post("/api/login", json=json.loads((ROOT / "artifacts/data-integration/login.json")
                               .read_text()))
        response.raise_for_status()
        client.headers["X-CSRF-Token"] = response.json()["csrf"]

        def get(path):
            response = client.get(path)
            response.raise_for_status()
            return response.json()

        try:
            live = next(row for row in get("/api/market-data/live") if row["logical_symbol"] == "XAUUSD")
            if not live["quote_ready"] or not live["candle_ready"]:
                raise RuntimeError("Live gold must be ready before creating the acceptance rule")
            response = client.post("/api/watches", json={"instrument_id": live["instrument_id"],
                "name": "data integration real quote acceptance", "kind": "price", "timeframe": "tick",
                "direction": "both", "level": live["quote"]["bid"], "touch": True, "use_history": False})
            response.raise_for_status()
            watch_id = response.json()["id"]
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                signals = [row for row in get("/api/signals") if row["watch_id"] == watch_id]
                if signals:
                    if len(signals) != 1:
                        raise RuntimeError("The real quote rule created duplicate signals")
                    signal = signals[0]
                    evidence = signal["evidence"]
                    if (evidence["dataset_identity"] != live["identity"]
                            or evidence["selection_epoch"] != live["connection_epoch"]
                            or signal["notification_status"] != "pending"):
                        raise RuntimeError("Notification provenance or isolated delivery state is invalid")
                    result.update({"watch_id": watch_id, "signal_id": signal["id"],
                        "notification_id": signal["notification_id"], "symbol": "XAUUSD",
                        "source": "oanda", "environment": "practice", "epoch": evidence["selection_epoch"],
                        "source_event_at": signal["occurred_at"], "signal_created_at": signal["created_at"],
                        "source_to_signal_ms": signal["created_at"] - signal["occurred_at"],
                        "notification_status": signal["notification_status"]})
                    time.sleep(10)
                    after = [row for row in get("/api/signals") if row["watch_id"] == watch_id]
                    if len(after) != 1 or after[0]["id"] != signal["id"]:
                        raise RuntimeError("Repeated real quotes changed the triggered signal")
                    result["passed"] = True
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Real price did not trigger the bounded acceptance rule")
        except Exception as error:
            result.update({"error_type": type(error).__name__, "error": str(error)})
            raise
        finally:
            if watch_id:
                response = client.post(f"/api/watches/{watch_id}/cancel")
                response.raise_for_status()
            result["finished_at"] = int(time.time() * 1000)
            (ROOT / "docs/verification/data-integration/live-signal-runtime.json").write_text(
                json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
