"""Pure, bounded publication comparison; never infer price changes from row counts."""

from sqlalchemy import select

from .history_artifacts import artifact_report
from .history_versions import version_report
from .storage import HistoryRun, HistoryVersion


def report(db, version_id, previous_version_id=None):
    version = db.get(HistoryVersion, version_id)
    if not version or version.status != "published":
        raise ValueError("请选择已发布的固定历史版本")
    if previous_version_id:
        previous = db.get(HistoryVersion, previous_version_id)
        if (not previous or previous.dataset_id != version.dataset_id
                or previous.status != "published" or previous.id == version.id):
            raise ValueError("对比版本必须是同一数据集的另一已发布版本")
    else:
        run = db.get(HistoryRun, version.id)
        previous = db.get(HistoryVersion, run.parent_version_id) if run and run.parent_version_id else None
        if previous is None:
            previous = db.scalar(select(HistoryVersion).where(
                HistoryVersion.dataset_id == version.dataset_id, HistoryVersion.status == "published",
                HistoryVersion.id != version.id, HistoryVersion.published_at < version.published_at
            ).order_by(HistoryVersion.published_at.desc(), HistoryVersion.id.desc()).limit(1))

    def summary(row):
        return {**version_report(db, row.id), "periods": artifact_report(db, row.id)}

    output = {"current": summary(version), "previous": summary(previous) if previous else None,
        "meaning": "发布清单与周期状态差异；根数或校验和变化不等于逐分钟价格修订数量。已回收版本仅比较保留清单。"}
    if previous:
        old_chunks = {(c.get("timeframe", "M1"), c["start"], c["end"]): c
                      for c in previous.manifest.get("chunks", [])}
        comparable = shared = changed = 0
        for chunk in version.manifest.get("chunks", []):
            old = old_chunks.get((chunk.get("timeframe", "M1"), chunk["start"], chunk["end"]))
            if old:
                comparable += 1
                same = old["checksum"] == chunk["checksum"]
                shared += int(same)
                changed += int(not same)
        output["differences"] = {
            "start_delta_ms": version.start - previous.start,
            "end_delta_ms": version.end - previous.end,
            "observed_minutes_delta": version.manifest.get("rows", 0) - previous.manifest.get("rows", 0),
            "unknown_minutes_delta": version.manifest.get("unknown_minutes", 0) - previous.manifest.get("unknown_minutes", 0),
            "same_original_checksum": version.manifest.get("checksum") == previous.manifest.get("checksum"),
            "same_window_chunks": comparable, "unchanged_same_window_chunks": shared,
            "changed_same_window_chunks": changed,
            "nonmatching_partition_chunks": len(version.manifest.get("chunks", [])) - comparable,
        }
    return output
