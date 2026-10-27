"""Read-only inventory of completed stage-zero fixture schemas, never production."""

import json
import os
import re
from pathlib import Path

from alerts import storage
from alerts.config import settings
from runtime_market_baseline import connect
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url


def inventory(result):
    schema = result["schema"]
    if not re.fullmatch(r"runtime_baseline_[a-z_]+_[0-9a-f]{8}", schema):
        raise ValueError("Unexpected fixture schema")
    engine, factory = connect(schema)
    try:
        with factory() as db:
            db.execute(text("SET TRANSACTION READ ONLY"))

            def count(model):
                return db.scalar(select(func.count()).select_from(model))

            rules = []
            for rule in db.scalars(select(storage.ChartAlert)):
                version = db.scalar(select(storage.ChartAlertVersion).where(
                    storage.ChartAlertVersion.alert_id == rule.id,
                    storage.ChartAlertVersion.version == rule.version))
                condition = version.config.get("condition", {})
                notes = list(db.scalars(select(storage.Notification).join(storage.SignalRow,
                    storage.SignalRow.id == storage.Notification.signal_id).where(
                    storage.SignalRow.chart_alert_id == rule.id)))
                rules.append({"id": rule.id, "status": rule.status,
                    "series_kind": version.config.get("series_kind"),
                    "source": version.market_identity.get("source"),
                    "atr_dependency": (condition.get("offset") or {}).get("kind") == "atr",
                    "indicator_dependency": (condition.get("left") or {}).get("kind") == "indicator",
                    "signals": db.scalar(select(func.count()).select_from(storage.SignalRow).where(
                        storage.SignalRow.chart_alert_id == rule.id)),
                    "notifications": len(notes),
                    "unfinished_notifications": sum(note.status not in (
                        "server_accepted", "acknowledged", "retired") for note in notes)})
            sources = []
            initial_end = result["inputs"][0]["end"]
            for series in db.scalars(select(storage.SourceSeries)):
                source = series.identity.get("source")
                query = select(func.count(), func.min(storage.SourceMinuteRevision.start),
                    func.max(storage.SourceMinuteRevision.start)).where(
                    storage.SourceMinuteRevision.source_id == series.id)
                total, first, last = db.execute(query).one()
                new_rows = db.scalar(select(func.count()).select_from(storage.SourceMinuteRevision).where(
                    storage.SourceMinuteRevision.source_id == series.id,
                    storage.SourceMinuteRevision.start >= initial_end))
                sources.append({"source": source, "revisions": total,
                    "first_business_minute": first, "last_business_minute": last,
                    "revisions_at_or_after_initial_minute": new_rows,
                    "note": "fixture timestamps; this is neither production growth nor wall-clock age"})
            histories = []
            for version in db.scalars(select(storage.HistoryVersion)):
                dataset = db.get(storage.MarketDataset, version.dataset_id)
                histories.append({"id": version.id, "source": dataset.identity.get("source"),
                    "start": version.start, "cursor": version.cursor, "end": version.end,
                    "status": version.status,
                    "coverage": "synthetic fixture only; no real supplier coverage certified"})
            mappings = []
            for composite in db.scalars(select(storage.MarketComposite)):
                active = db.get(storage.CompositeRevision, composite.active_revision_id)
                mapping = db.get(storage.RealtimeMapping, composite.mapping_id)
                consumers = db.scalar(select(func.count()).select_from(storage.ChartAlert).join(
                    storage.ChartAlertVersion,
                    (storage.ChartAlertVersion.alert_id == storage.ChartAlert.id)
                    & (storage.ChartAlertVersion.version == storage.ChartAlert.version)).where(
                    storage.ChartAlert.status == "active",
                    storage.ChartAlertVersion.config["instrument"].as_string() == composite.id))
                mappings.append({"composite": composite.id, "active_revision": active.id,
                    "mapping": mapping.id, "target": mapping.target_dataset_id,
                    "active_rule_consumers": consumers,
                    "compatible_realtime_initial_value": bool(active and consumers)})
            size = db.execute(text("SELECT pg_total_relation_size("
                "'market_source_minute_revisions'::regclass) AS source_relation_bytes, "
                "pg_total_relation_size('market_composite_minute_inputs'::regclass) "
                "AS composite_input_relation_bytes")).mappings().one()
            return {"schema": schema, "scenario": result["scenario"],
                "history_pause_s": result["history_pause_s"],
                "scope": "task fixture only; not a census of user or production data",
                "chart_workspaces": count(storage.ChartWorkspace),
                "old_bindings": count(storage.CompositeWatchBinding),
                "old_judgments": count(storage.CompositeWatchJudgment),
                "market_demands": count(storage.MarketDemand),
                "rules": rules, "mappings": mappings, "sources": sources,
                "histories": histories, "relation_sizes": dict(size),
                "retirement_note": "No provider/managed rule or old binding in these measurement schemas. "
                    "That cannot prove production absence or authorize dropping reference protection."}
    finally:
        engine.dispose()


def main():
    url = make_url(settings.database_url)
    if (os.environ.get("MW_RUNTIME_BASELINE_TASK") != "mw-runtime-20261026"
            or url.host != "postgres" or url.database != "runtime_baseline"):
        raise RuntimeError("Only the task database is allowed")
    root = Path("/artifacts")
    values = [inventory(json.loads(path.read_text()))
              for path in sorted(root.glob("runtime_baseline_*.json"))]
    (root / "instance-inventory.json").write_text(json.dumps(values, indent=2))
    print(json.dumps({"schemas": len(values), "output": "instance-inventory.json"}))


if __name__ == "__main__":
    main()
