"""Bounded-memory audit of published original chunks in the isolated API container."""

import argparse
import gzip
import hashlib
import json
from collections import Counter
from datetime import UTC, datetime
from decimal import Decimal

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
    for chunk in db.scalars(select(HistoryChunk).where(HistoryChunk.version_id == version.id)
                            .order_by(HistoryChunk.start).execution_options(yield_per=1)):
        if chunk.start != cursor or chunk.end <= cursor:
            raise ValueError("Chunk partition is discontinuous")
        raw = gzip.decompress(chunk.content)
        if hashlib.sha256(raw).hexdigest() != chunk.checksum:
            raise ValueError("Original chunk checksum mismatch")
        digest.update(chunk.checksum.encode())
        content = json.loads(raw)
        if len(content) != chunk.count:
            raise ValueError("Chunk row count mismatch")
        prior = chunk.start - 60000
        observed = set()
        for row in content:
            stamp = row["timestamp"]
            if stamp <= prior or stamp % 60000 or not chunk.start <= stamp < chunk.end:
                raise ValueError("Rows are duplicate, disordered or outside their UTC minute partition")
            prior = stamp
            observed.add(stamp)
            prices = {key: Decimal(row[key]) for key in ("open", "high", "low", "close")}
            if any(not price.is_finite() or price <= 0 or price != price.quantize(precision)
                   for price in prices.values()):
                raise ValueError("Invalid source price/precision")
            if not prices["low"] <= min(prices["open"], prices["close"]) <= max(
                    prices["open"], prices["close"]) <= prices["high"]:
                raise ValueError("Invalid OHLC envelope")
            volume = Decimal(row["volume"]) if row["volume"] is not None else None
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
    manifest = version.manifest
    if (cursor != version.end or rows != manifest["rows"] or gap_minutes != manifest["unknown_minutes"]
            or digest.hexdigest() != manifest["checksum"]):
        raise ValueError("Manifest totals/checksum/range mismatch")
    return {"version": version.id, "logical_symbol": dataset.logical_symbol, "identity": dataset.identity,
            "start": version.start, "end": version.end, "chunks": chunks,
            "checksum": digest.hexdigest(), "all_checks_passed": True,
            "observed_minutes": rows, "unknown_minutes": gap_minutes, "unknown_intervals": gaps,
            "years": {year: {"observed": years[year], "unknown": gaps_by_year[year]}
                      for year in sorted(set(years) | set(gaps_by_year))},
            "largest_unknown_intervals": largest_gaps,
            "precision": instrument.precision, "volume_kind": dataset.volume_kind,
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
