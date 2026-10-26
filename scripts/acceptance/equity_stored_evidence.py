"""Read-only verification of real persisted raw/basis/qfq rows on mwa."""

import json
from decimal import Decimal

from alerts.history_artifacts import read_artifact
from alerts.source_history_store import raw_chunk
from alerts.storage import HistoryArtifact, HistoryChunk, HistoryVersion, MarketDataset, transaction
from sqlalchemy import select

report = []
with transaction() as db:
    for dataset in db.scalars(select(MarketDataset).where(MarketDataset.asset_class == "equity")):
        if dataset.identity.get("source_family") not in ("sina-a", "sina-hk", "yfinance"):
            continue
        for version in db.scalars(
            select(HistoryVersion).where(
                HistoryVersion.dataset_id == dataset.id, HistoryVersion.status == "published"
            )
        ):
            artifact = db.scalar(
                select(HistoryArtifact).where(
                    HistoryArtifact.version_id == version.id,
                    HistoryArtifact.timeframe == "D1",
                    HistoryArtifact.status == "published",
                )
            )
            if not artifact or artifact.manifest.get("adjustment_view") != "qfq":
                continue
            raw = [
                row
                for chunk in db.scalars(
                    select(HistoryChunk).where(HistoryChunk.version_id == version.id)
                )
                for row in json.loads(raw_chunk(db, chunk))
            ]
            qfq = {r["start"]: r for r in read_artifact(db, version.id, "D1", limit=20000)}
            normalized = changed = count = 0
            for row in raw:
                basis = row["adjustment_basis"]
                factor = Decimal(basis["value"])
                own = qfq[row["start"]]
                for field in ("open", "high", "low", "close"):
                    value = Decimal(row[field])
                    expected = (
                        value / factor
                        if dataset.identity["source_family"] == "sina-a"
                        else value * factor
                    )
                    assert abs(expected - Decimal(own[field])) < Decimal("1e-20")
                assert row.get("adjustment_view") is None
                normalized += bool(row.get("source_ohlc"))
                changed += row["close"] != own["close"]
                count += 1
            report.append(
                {
                    "dataset_id": dataset.id,
                    "version_id": version.id,
                    "symbol": dataset.identity["provider_symbol"],
                    "family": dataset.identity["source_family"],
                    "raw_adjustment": dataset.identity["adjustment"],
                    "rows": count,
                    "changed_close_rows": changed,
                    "source_ohlc_retained_rows": normalized,
                    "basis_kinds": sorted({r["adjustment_basis"]["kind"] for r in raw}),
                    "qfq_rule": artifact.rule_version,
                    "passed": True,
                }
            )
assert len(report) >= 3, report
print(json.dumps({"passed": True, "cases": report}, indent=2))
