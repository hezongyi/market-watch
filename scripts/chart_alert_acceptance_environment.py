"""Named local acceptance environments; never use production configuration."""

import os
from pathlib import Path

PROJECT = os.environ.get("MW_ALERT_ACCEPTANCE_PROJECT", "mw-chart-alerts-acceptance")
ENVIRONMENTS = {
    "mw-chart-alerts-acceptance": ("chart_alerts_acceptance", 19443),
    "mw-chart-alerts-integration": ("chart_alerts_integration", 19543),
}
if PROJECT not in ENVIRONMENTS:
    raise ValueError("Only the named isolated alert acceptance projects are allowed")
DATABASE, PORT = ENVIRONMENTS[PROJECT]
ROOT = Path("/tmp") / PROJECT
APP = f"https://localhost:{PORT}"
COMPOSE = (
    Path(__file__).resolve().parents[1]
    / "docs/verification/chart-alerts"
    / ("compose.yaml" if PROJECT == "mw-chart-alerts-acceptance" else "compose.integration.yaml")
)
