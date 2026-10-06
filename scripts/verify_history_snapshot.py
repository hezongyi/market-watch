"""Bounded-memory audit of published original chunks in the isolated API container."""

import argparse
import hashlib
import json
from collections import Counter
from datetime import UTC, datetime
from decimal import Decimal

from alerts.source_history_store import raw_chunk
from alerts.storage import HistoryChunk, HistoryVersion, Instrument, MarketDataset, transaction
from sqlalchemy import select


def verify(db, version):
    dataset = db.get(MarketDataset, version.dataset_id)
    instrument = db.get(Instrument, dataset.instrument_id)
    precision = Decimal(1).scaleb(-instrument.precision)
    years = Counter()
    gaps_by_year = Counter()
    largest_gaps = []
    digest = hashlib.sha256()
    cursor = version.start
    rows = volume_present = volume_nonzero = gaps = gap_minutes = chunks = 0
    boundary_samples = []
    actual_precision = Counter()
    manifest = version.manifest
    manifest_chunks = manifest["chunks"]
    provenance = manifest.get("provenance")
    parent = db.get(HistoryVersion, provenance["derived_from_version"]) if provenance else None
    prefix_digest = hashlib.sha256()
    prefix_chunks = prefix_rows = 0
    for chunk in db.scalars(select(HistoryChunk).where(HistoryChunk.version_id == version.id)
                            .order_by(HistoryChunk.start).execution_options(yield_per=1)):
        if chunk.start != cursor or chunk.end <= cursor:
            raise ValueError("Chunk partition is discontinuous")
        raw = raw_chunk(db, chunk)
        digest.update(chunk.checksum.encode())
        content = json.loads(raw)
        if len(content) != chunk.count:
            raise ValueError("Chunk row count mismatch")
        if chunks >= len(manifest_chunks) or manifest_chunks[chunks] != {
                "id": chunk.id, "start": chunk.start, "end": chunk.end,
                "count": chunk.count, "checksum": chunk.checksum}:
            raise ValueError("Manifest chunk index mismatch")
        if provenance and chunk.start < provenance["original_cursor"]:
            original = db.scalar(select(HistoryChunk).where(HistoryChunk.version_id == parent.id,
                                                           HistoryChunk.start == chunk.start))
            if not original or any(getattr(original, key) != getattr(chunk, key) for key in (
                    "end", "count", "checksum", "content", "content_id", "unknown", "result", "observed_at")):
                raise ValueError("Derived prefix differs from immutable parent")
            prefix_digest.update(chunk.checksum.encode())
            prefix_chunks += 1
            prefix_rows += chunk.count
        prior = chunk.start - 60000
        observed = set()
        for row in content:
            stamp = row["timestamp"]
            if type(stamp) is not int or stamp <= prior or stamp % 60000 or not chunk.start <= stamp < chunk.end:
                raise ValueError("Rows are duplicate, disordered or outside their UTC minute partition")
            prior = stamp
            observed.add(stamp)
            prices = {key: Decimal(row[key]) for key in ("open", "high", "low", "close")}
            if row.get("complete") is not True or stamp + 60000 > chunk.observed_at - 5000:
                raise ValueError("Source row lacks completed-minute finality")
            if any(not price.is_finite() or price <= 0 or price != price.quantize(precision)
                   for price in prices.values()):
                raise ValueError("Invalid source price/precision")
            if not prices["low"] <= min(prices["open"], prices["close"]) <= max(
                    prices["open"], prices["close"]) <= prices["high"]:
                raise ValueError("Invalid OHLC envelope")
            volume = Decimal(row["volume"]) if row["volume"] is not None else None
            if volume is not None and (not volume.is_finite() or volume < 0):
                raise ValueError("Invalid original volume")
            for price in prices.values():
                actual_precision[str(max(0, -price.normalize().as_tuple().exponent))] += 1
            volume_present += volume is not None
            volume_nonzero += volume is not None and volume > 0
            date = datetime.fromtimestamp(stamp / 1000, UTC)
            years[str(date.year)] += 1
            # Public temporal evidence only, with no account or price export.
            if date.day == 1 and date.hour == 0 and date.minute == 0:
                boundary_samples.append(date.isoformat())
        previous_gap_end = chunk.start
        for start, end in chunk.unknown:
            if start < previous_gap_end or not chunk.start <= start < end <= chunk.end:
                raise ValueError("Unknown intervals overlap or exceed their partition")
            if start % 60000 or end % 60000 or any(stamp in observed for stamp in range(start, end, 60000)):
                raise ValueError("Unknown interval conflicts with observed rows")
            previous_gap_end = end
            count = (end - start) // 60000
            gap_minutes += count
            gaps += 1
            largest_gaps.append({"start": start, "end": end, "minutes": count})
            largest_gaps = sorted(largest_gaps, key=lambda span: span["minutes"], reverse=True)[:20]
            year_start = start
            while year_start < end:
                year = datetime.fromtimestamp(year_start / 1000, UTC).year
                limit = min(end, int(datetime(year + 1, 1, 1, tzinfo=UTC).timestamp() * 1000))
                gaps_by_year[str(year)] += (limit - year_start) // 60000
                year_start = limit
        if len(content) + sum((end - start) // 60000 for start, end in chunk.unknown) != (
                chunk.end - chunk.start) // 60000:
            raise ValueError("Observed and unknown minutes do not account for the whole partition")
        rows += len(content)
        chunks += 1
        cursor = chunk.end
    if (cursor != version.end or rows != manifest["rows"] or gap_minutes != manifest["unknown_minutes"]
            or digest.hexdigest() != manifest["checksum"] or chunks != len(manifest_chunks)):
        raise ValueError("Manifest totals/checksum/range mismatch")
    if provenance and (parent.cursor != provenance["original_cursor"]
            or prefix_chunks != provenance["copied_chunks"] or prefix_rows != provenance["copied_minutes"]
            or prefix_digest.hexdigest() != provenance["original_prefix_checksum"]):
        raise ValueError("Derivation provenance count/checksum mismatch")
    return {"version": version.id, "logical_symbol": dataset.logical_symbol, "identity": dataset.identity,
            "start": version.start, "end": version.end, "chunks": chunks,
            "checksum": digest.hexdigest(), "all_checks_passed": True,
            "observed_minutes": rows, "unknown_minutes": gap_minutes, "unknown_intervals": gaps,
            "years": {year: {"observed": years[year], "unknown": gaps_by_year[year]}
                      for year in sorted(set(years) | set(gaps_by_year))},
            "largest_unknown_intervals": largest_gaps,
            "precision": instrument.precision, "volume_kind": dataset.volume_kind,
            "observed_ohlc_nonzero_decimal_places": dict(sorted(actual_precision.items())),
            "completed_minute_finality_checked": True, "volume_nonnegative_checked": True,
            "manifest_chunk_index_checked": True,
            "derivation_provenance_verified": bool(provenance),
            "derived_prefix_chunks": prefix_chunks, "derived_prefix_minutes": prefix_rows,
            "volume_unit": dataset.volume_unit, "volume_present": volume_present,
            "volume_nonzero": volume_nonzero, "month_utc_boundary_samples": boundary_samples,
            "calendar_status": "candidate; no unknown interval is relabeled as proven closure",
            "coverage_meaning": "complete fixed query partition; observed prices and unknown gaps remain separate"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--minimum-years", type=int, default=0)
    args = parser.parse_args()
    with transaction() as db:
        reports = [verify(db, version) for version in db.scalars(select(HistoryVersion).where(
            HistoryVersion.status == "published")) if version.end - version.start >= (
                args.minimum_years * 365 * 86400000)]
    print(json.dumps({"host": "Ubuntu local isolated Docker", "versions": reports}, indent=2))
