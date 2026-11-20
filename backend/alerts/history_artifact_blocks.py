"""Single-hop immutable period payload references, scoped to one dataset/frame.

Each version keeps its own ordered block index and manifest. The compressed
payload stays at its original inline block; readers bind provenance to the
requested version only after checking the original checksum and source scope.
"""

import gzip
import hashlib
import json

from sqlalchemy import select
from sqlalchemy.orm import aliased, defer, load_only

from .market_datasets import price_rule
from .storage import HistoryArtifact, HistoryArtifactBlock, HistoryVersion


def metadata_query():
    return select(HistoryArtifactBlock).options(defer(HistoryArtifactBlock.content))


def source_block(db, block, artifact):
    if not block.source_block_id:
        return block
    source = db.get(
        HistoryArtifactBlock, block.source_block_id, options=[defer(HistoryArtifactBlock.content)]
    )
    if not source or source.source_block_id:
        raise ValueError("Invalid shared period payload reference")
    source_artifact = db.get(
        HistoryArtifact,
        source.artifact_id,
        options=[
            load_only(
                HistoryArtifact.version_id,
                HistoryArtifact.timeframe,
                HistoryArtifact.rule_version,
                HistoryArtifact.status,
            )
        ],
    )
    parent = db.get(
        HistoryVersion, artifact.version_id, options=[load_only(HistoryVersion.dataset_id)]
    )
    source_parent = db.get(
        HistoryVersion,
        source_artifact.version_id,
        options=[
            load_only(HistoryVersion.dataset_id, HistoryVersion.status, HistoryVersion.manifest)
        ],
    )
    if (
        source_artifact.timeframe != artifact.timeframe
        or source_artifact.rule_version != artifact.rule_version
        or source_parent.dataset_id != parent.dataset_id
        or source_parent.status != "published"
        or source_artifact.status != "published"
        or price_rule(source_parent.manifest) != price_rule(parent.manifest)
        or any(
            getattr(source, key) != getattr(block, key)
            for key in ("start", "end", "count", "checksum")
        )
    ):
        raise ValueError("Shared period payload identity mismatch")
    for key in ("input_count", "complete_count"):
        expected = getattr(source, key)
        if expected is not None and expected != getattr(block, key):
            raise ValueError("Shared period payload counter mismatch")
    return source


def read_rows(db, block, artifact):
    source = source_block(db, block, artifact)
    raw = gzip.decompress(source.content)
    if hashlib.sha256(raw).hexdigest() != block.checksum:
        raise ValueError("Published timeframe artifact checksum mismatch")
    rows = json.loads(raw)
    return [{**row, "parent_version_id": artifact.version_id} for row in rows]


def reference_block(db, block, source_artifact, artifact):
    """Build a metadata-only reference; legacy metadata is decoded once on adoption."""
    source = source_block(db, block, source_artifact)
    input_count, complete_count = block.input_count, block.complete_count
    if input_count is None or complete_count is None:
        rows = read_rows(db, block, source_artifact)
        input_count = sum(row["observed_minutes"] for row in rows)
        complete_count = sum(row["complete"] for row in rows)
    return HistoryArtifactBlock(
        artifact_id=artifact.id,
        start=block.start,
        end=block.end,
        count=block.count,
        checksum=block.checksum,
        content=b"",
        source_block_id=source.id,
        input_count=input_count,
        complete_count=complete_count,
    )


def reference_blocks(db, blocks, source_artifact, artifact):
    # Retain strong references so per-block validation uses the identity map.
    # No compressed content is fetched when durable counters already exist.
    sources = list(
        db.scalars(
            metadata_query().where(
                HistoryArtifactBlock.id.in_(
                    {b.source_block_id for b in blocks if b.source_block_id}
                )
            )
        )
    )
    owners = list(
        db.scalars(
            select(HistoryArtifact)
            .options(
                load_only(
                    HistoryArtifact.version_id,
                    HistoryArtifact.timeframe,
                    HistoryArtifact.rule_version,
                    HistoryArtifact.status,
                )
            )
            .where(HistoryArtifact.id.in_({s.artifact_id for s in sources}))
        )
    )
    _parents = list(
        db.scalars(
            select(HistoryVersion)
            .options(
                load_only(HistoryVersion.dataset_id, HistoryVersion.status, HistoryVersion.manifest)
            )
            .where(HistoryVersion.id.in_({a.version_id for a in owners}))
        )
    )
    refs = [reference_block(db, block, source_artifact, artifact) for block in blocks]
    # Keep the preloaded ownership rows alive until all references are checked.
    return refs


def validate_new_references(db):
    """The dataset fence is also held by reclamation; FK retains the inline payload."""
    refs = [
        block
        for block in db.new
        if isinstance(block, HistoryArtifactBlock) and block.source_block_id
    ]
    if not refs:
        return
    from .history_retention import lock_reference_values

    artifacts = {
        a.id: a
        for a in db.scalars(
            select(HistoryArtifact)
            .options(
                load_only(
                    HistoryArtifact.version_id,
                    HistoryArtifact.timeframe,
                    HistoryArtifact.rule_version,
                    HistoryArtifact.status,
                )
            )
            .where(HistoryArtifact.id.in_({b.artifact_id for b in refs}))
        )
    }
    sources = list(
        db.scalars(
            metadata_query().where(HistoryArtifactBlock.id.in_({b.source_block_id for b in refs}))
        )
    )
    owners = list(
        db.scalars(
            select(HistoryArtifact)
            .options(
                load_only(
                    HistoryArtifact.version_id,
                    HistoryArtifact.timeframe,
                    HistoryArtifact.rule_version,
                    HistoryArtifact.status,
                )
            )
            .where(HistoryArtifact.id.in_({s.artifact_id for s in sources}))
        )
    )
    _parents = list(
        db.scalars(
            select(HistoryVersion)
            .options(
                load_only(HistoryVersion.dataset_id, HistoryVersion.status, HistoryVersion.manifest)
            )
            .where(
                HistoryVersion.id.in_(
                    {a.version_id for a in owners} | {a.version_id for a in artifacts.values()}
                )
            )
        )
    )
    lock_reference_values(db, [{"history_version_id": a.version_id} for a in artifacts.values()])
    for block in refs:
        artifact = artifacts[block.artifact_id]
        if block.content or artifact.status != "pending":
            raise ValueError(
                "Shared period payload references require an unfinished destination and empty content"
            )
        source_block(db, block, artifact)


def manifest_blocks(db, artifact_id):
    # Large payloads must never be selected merely to finalize a manifest.
    return db.execute(
        select(
            HistoryArtifactBlock.id,
            HistoryArtifactBlock.start,
            HistoryArtifactBlock.end,
            HistoryArtifactBlock.count,
            HistoryArtifactBlock.checksum,
        )
        .where(HistoryArtifactBlock.artifact_id == artifact_id)
        .order_by(HistoryArtifactBlock.start)
    ).all()


def iter_rows(db, artifact, parent, *, start=None, end=None, newest_first=False):
    """One streaming SQL for inline/shared payloads, without per-block SELECTs."""
    block = HistoryArtifactBlock
    source = aliased(HistoryArtifactBlock)
    owner = aliased(HistoryArtifact)
    version = aliased(HistoryVersion)
    query = (
        select(
            block,
            source,
            owner.timeframe,
            owner.rule_version,
            owner.status,
            version.dataset_id,
            version.status,
            version.manifest["price_rule_version"].as_string(),
            version.manifest["price_precision"].as_integer(),
        )
        .outerjoin(source, source.id == block.source_block_id)
        .outerjoin(owner, owner.id == source.artifact_id)
        .outerjoin(version, version.id == owner.version_id)
        .where(block.artifact_id == artifact.id)
    )
    if start is not None:
        query = query.where(block.end > start)
    if end is not None:
        query = query.where(block.start < end)
    query = query.order_by(block.start.desc() if newest_first else block.start)
    for (
        current,
        original,
        frame,
        rule,
        status,
        dataset,
        parent_status,
        price_version,
        precision,
    ) in db.execute(query.execution_options(yield_per=1)):
        if current.source_block_id:
            original_rule = price_rule(
                {}
                if price_version is None and precision is None
                else {"price_rule_version": price_version, "price_precision": precision}
            )
            if (
                not original
                or original.source_block_id
                or current.content
                or frame != artifact.timeframe
                or rule != artifact.rule_version
                or dataset != parent.dataset_id
                or status != "published"
                or parent_status != "published"
                or original_rule != price_rule(parent.manifest)
                or any(
                    getattr(original, key) != getattr(current, key)
                    for key in ("start", "end", "count", "checksum")
                )
            ):
                raise ValueError("Shared period payload identity mismatch")
            payload = original.content
        else:
            payload = current.content
        raw = gzip.decompress(payload)
        if hashlib.sha256(raw).hexdigest() != current.checksum:
            raise ValueError("Published timeframe artifact checksum mismatch")
        rows = json.loads(raw)
        for row in reversed(rows) if newest_first else rows:
            if (start is None or row["start"] >= start) and (end is None or row["start"] < end):
                yield {**row, "parent_version_id": artifact.version_id}
