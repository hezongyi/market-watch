"""Bounded actual supplier recheck in the isolated centre; no fixture injection."""

import json
import time
from pathlib import Path

import httpx


def main():
    base = "http://127.0.0.1:16629"
    directory = Path("artifacts/data-integration")
    with httpx.Client(base_url=base, timeout=30, trust_env=False) as client:
        response = client.post("/api/login", json=json.loads((directory / "three-layer-login.json").read_text()))
        response.raise_for_status()
        client.headers["X-CSRF-Token"] = response.json()["csrf"]
        def get(path):
            response = client.get("/api/market-data/" + path)
            response.raise_for_status()
            return response.json()
        row = next(row for row in get("center/datasets?status=available&source=oanda")["items"]
                   if row["logical_symbol"] == "EURUSD" and row["aggregation_calendar"] == "ny17")
        ident, parent = row["id"], row["latest_version_id"]
        original = get("versions/" + parent)["manifest"]
        end = original["end"]
        response = client.post(f"/api/market-data/datasets/{ident}/tasks", json={
            "request_id": "real-request-evidence-recheck-ad31", "kind": "recheck",
            "start": max(original["start"], end - 20 * 60000), "end": end})
        response.raise_for_status()
        version = response.json()["id"]
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            report = get("versions/" + version)
            if report["status"] == "published":
                break
            if report["status"] == "configuration_error":
                raise RuntimeError("supplier configuration rejected bounded recheck")
            time.sleep(2)
        else:
            raise RuntimeError("bounded supplier recheck did not publish within 120 seconds")
        requests = get(f"versions/{version}/requests?page_size=100")
        assert requests["total"] > 0 and requests["evidence_available"]
        assert any(item["read_kind"] == "supplier_request" and item["accepted"] for item in requests["items"])
        assert report["manifest"]["request_evidence"]["count"] == requests["total"]
        assert get("versions/" + parent)["manifest"] == original
        coverage = get(f"versions/{version}/coverage")
        assert coverage["version_id"] == version
    result = {"environment": "Ubuntu isolated market-watch-three-layer", "base": base,
        "dataset_id": ident, "version_id": version, "parent_version_id": parent,
        "requests": requests, "fixed_original_manifest_preserved": True,
        "supplier_recheck_minutes": 20, "passed": True}
    (directory / "history-request-real-supplier.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"requests": requests["total"], "passed": True}))


if __name__ == "__main__":
    main()
