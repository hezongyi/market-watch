"""Exercise public readiness and authenticated health over real local HTTP."""

import argparse
import json
from pathlib import Path

import httpx

parser = argparse.ArgumentParser()
parser.add_argument("--url", default="http://127.0.0.1:28472")
parser.add_argument("--credentials", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
with httpx.Client(base_url=args.url, timeout=15) as client:
    checks = {}
    for path, status in [("/healthz", 200), ("/readyz", 200), ("/api/health", 401)]:
        response = client.get(path)
        assert response.status_code == status, (path, response.status_code)
        checks[path] = response.status_code
    response = client.post("/api/login", json=json.loads(args.credentials.read_text()))
    assert response.status_code == 200, response.status_code
    checks["login"] = response.status_code
    response = client.get("/api/health")
    assert response.status_code == 200, response.status_code
    execution = response.json()["chart_alerts"]["execution"]
    assert execution == {"monitoring": 2, "settling": 1, "recovering": 1}, execution
    checks["authenticated_health"] = response.status_code
result = {"host": "Ubuntu quant-server", "url": args.url, "checks": checks,
          "execution": execution}
args.output.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
