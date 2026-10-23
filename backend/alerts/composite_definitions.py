"""Explicit saved source mapping and atomic first-use fixed-history selection.

Reads never create composites or demand. The first-use command serializes on the
managed dataset, fixes baseline/T once, and leaves preparation to a durable job.
"""

import hashlib
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator
from sqlalchemy import select

from .chart_data import FRAMES
from .config import settings
from .domain import session_bounds
from .history_artifacts import chart_page, request_artifacts
from .history_catalog import account_scope, asset_class
from .history_sources import history_identity
from .market_contracts import DatasetIdentity
from .market_datasets import register_dataset
from .source_registry import collection_identity
from .storage import (
    CompositePreparation,
    CompositeRevision,
    HistoryArtifact,
    HistoryReclamation,
    HistoryVersion,
    Instrument,
    LiveState,
    MarketCatalog,
    MarketComposite,
    MarketDataset,
    RealtimeMapping,
    RealtimeMappingNote,
    instant,
    ms,
    now_ms,
)

RULES = {"aggregation": "configured-phase-m1-v1", "seam": "latest-day-boundary-v1",
         "selection": "history-before-T-target-from-T-v1", "tail_revisions": "source-confirmed-replace-audit-v1"}


class ProductMatch(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    underlying: str = Field(pattern=r"^[A-Z0-9]{1,30}$")
    quote_currency: str = Field(pattern=r"^[A-Z]{3,8}$")
    historical_product: Literal["spot_fx", "spot_metal", "crypto", "index", "cfd", "future", "other"]
    live_product: Literal["spot_fx", "spot_metal", "crypto", "index", "cfd", "future", "other"]
    relationship: Literal["same_product", "same_underlying_different_product"]
    historical_evidence: HttpUrl
    live_evidence: HttpUrl
    rationale: str = Field(min_length=10, max_length=1000)
    reviewed: Literal[True]

    @model_validator(mode="after")
    def explicit_relationship(self):
        if self.relationship == "same_product" and self.historical_product != self.live_product:
            raise ValueError("不同产品类型必须明确记录标的相同但产品不同，不能默认为等价")
        for url in (self.historical_evidence, self.live_evidence):
            if url.username or url.password:
                raise ValueError("匹配依据URL不能包含凭据")
        return self


def key(document):
    return hashlib.sha256(json.dumps(document, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def save_mapping(db, dataset_id, catalog_id, match, *, permission_scope="workspace:default",
                 snapshot=None, reuse_mapping_id=None):
    from .composite_matching import MappingDraft, check_match

    if isinstance(match, MappingDraft) or isinstance(match, dict) and match.get("schema_version") == 2:
        return save_checked_mapping(db, dataset_id, catalog_id, match, permission_scope=permission_scope,
            snapshot=snapshot, reuse_mapping_id=reuse_mapping_id)
    match = ProductMatch.model_validate(match)
    dataset = db.scalar(select(MarketDataset).where(MarketDataset.id == dataset_id).with_for_update())
    if not dataset:
        raise ValueError("自建数据集不存在")
    historical_identity = history_identity(dataset.identity)
    if historical_identity.basis != "bid":
        raise ValueError("首版组合只接续一致的Bid价格口径")
    entry = db.get(MarketCatalog, catalog_id)
    if (not entry or entry.source != "oanda" or not entry.available or
            entry.metadata_json.get("history_account_scope") != account_scope()):
        raise ValueError("请选择当前OANDA Practice账户目录中的准确品种")
    if not settings.oanda_account_id or not settings.oanda_token:
        raise ValueError("OANDA Practice连接尚未配置")
    target_asset = asset_class(entry.asset_type, entry.symbol)
    if dataset.asset_class in ("forex", "metal", "crypto", "index") and target_asset != dataset.asset_class:
        raise ValueError("历史与实时品种资产类别不匹配")
    product_asset = {"spot_fx": "forex", "spot_metal": "metal", "crypto": "crypto", "index": "index"}
    if match.historical_product in product_asset and target_asset != product_asset[match.historical_product]:
        raise ValueError("匹配依据的产品类型与目标目录类别不一致")
    # These assertions validate the supplied economic match, not a fuzzy code
    # heuristic. Other products remain explicitly described and reviewed.
    if match.historical_product in ("spot_fx", "spot_metal"):
        expected = match.underlying + match.quote_currency
        source_symbol = DatasetIdentity.model_validate(dataset.identity).provider_symbol
        if source_symbol not in (expected, match.underlying + "/" + match.quote_currency,
                                 match.underlying + "_" + match.quote_currency):
            raise ValueError("匹配依据的标的/报价币种与历史准确代码不一致")
        if entry.symbol != match.underlying + "_" + match.quote_currency:
            raise ValueError("匹配依据的标的/报价币种与实时准确代码不一致")
    # Existing legacy rows keep their identities; every new legacy-format write
    # must satisfy the same source/product rules as a v2 write.
    checked = check_match(db, dataset_id, catalog_id,
        MappingDraft.model_validate(match.model_dump(mode="json")))
    if checked["status"] != "ready":
        raise ValueError("；".join(checked["errors"].values()))
    logical = entry.symbol.replace("_", "")
    if not 0 < len(logical) <= 10:
        raise ValueError("目标品种尚未支持实时身份登记")
    identity = DatasetIdentity(source="oanda", channel="v20", environment="practice",
        account_scope=account_scope(), provider_symbol=entry.symbol, basis="bid",
        calendar_version=settings.oanda_calendar_version)
    # Registration creates identity/state only: disabled, no stream or demand.
    register_dataset(db, identity, logical_symbol=logical, label=entry.label,
        calendar="ny17", precision=entry.precision, volume_kind="price_count", volume_unit="quotes",
        calendar_profile=settings.oanda_calendar_profiles.get(entry.symbol))
    if not db.get(LiveState, identity.key):
        db.add(LiveState(dataset_id=identity.key))
    proof = {**match.model_dump(mode="json"), "basis": "bid", "historical_identity": dataset.identity,
        "target_identity": identity.model_dump(), "target_catalog": {"symbol": entry.symbol,
            "type": entry.asset_type, "precision": entry.precision, "updated_at": entry.updated_at},
        "collection_identity": collection_identity(identity).model_dump()}
    ident = key({"dataset_id": dataset_id, "permission_scope": permission_scope,
                 "target_dataset_id": identity.key, "match": proof})
    mapping = db.get(RealtimeMapping, ident)
    if not mapping:
        mapping = RealtimeMapping(id=ident, dataset_id=dataset_id, target_dataset_id=identity.key,
            permission_scope=permission_scope, match=proof)
        db.add(mapping)
        db.flush()
    return mapping


def latest_note(db, mapping_id):
    return db.scalar(select(RealtimeMappingNote).where(RealtimeMappingNote.mapping_id == mapping_id)
        .order_by(RealtimeMappingNote.version.desc()).limit(1))


def save_checked_mapping(db, dataset_id, catalog_id, draft, *, permission_scope, snapshot, reuse_mapping_id):
    from .composite_matching import (
        PRODUCT_FIELDS,
        CatalogSnapshot,
        MappingDraft,
        check_match,
        live_identity,
        selection,
    )

    # Also serializes note versions and reuse with legacy/new save commands.
    db.scalar(select(MarketDataset).where(MarketDataset.id == dataset_id).with_for_update())
    draft = MappingDraft.model_validate(draft)
    result = check_match(db, dataset_id, catalog_id, draft)
    if snapshot is None or CatalogSnapshot.model_validate(snapshot).model_dump() != result["snapshot"]:
        raise ValueError("账户、品种或目录关键属性已变化，请重新核对配置")
    if result["status"] != "ready":
        raise ValueError("；".join(result["errors"].values()))
    dataset, _, entry, _ = selection(db, dataset_id, catalog_id)
    identity = live_identity(entry.symbol)
    operational = {field: getattr(draft, field) for field in PRODUCT_FIELDS}
    compatible = [row for row in db.scalars(select(RealtimeMapping).where(
        RealtimeMapping.dataset_id == dataset_id, RealtimeMapping.target_dataset_id == identity.key,
        RealtimeMapping.permission_scope == permission_scope))
        if all(row.match.get(field) == value for field, value in operational.items()) and
        row.match.get("target_catalog", {}).get("type") == entry.asset_type and
        row.match.get("target_catalog", {}).get("precision") == entry.precision]
    if reuse_mapping_id:
        mapping = next((row for row in compatible if row.id == reuse_mapping_id), None)
        if not mapping:
            raise ValueError("所选已保存配置已不适用，请重新选择并核对")
    elif len(compatible) > 1:
        raise ValueError("存在多条不同的有效配置，请明确选择要使用的配置")
    else:
        mapping = compatible[0] if compatible else None
    if mapping is None:
        logical = entry.symbol.replace("_", "")
        register_dataset(db, identity, logical_symbol=logical, label=entry.label,
            calendar="ny17", precision=entry.precision, volume_kind="price_count", volume_unit="quotes",
            calendar_profile=settings.oanda_calendar_profiles.get(entry.symbol))
        if not db.get(LiveState, identity.key):
            db.add(LiveState(dataset_id=identity.key))
        # Exclude note, review clicks, URLs and catalog read timestamps. Identity
        # covers behaviour and source attributes, not explanatory revisions.
        document = {"schema_version": 2, "dataset_id": dataset_id, "permission_scope": permission_scope,
            "target_identity": identity.model_dump(), "product": operational,
            "target_attributes": {"type": entry.asset_type, "precision": entry.precision}}
        mapping = RealtimeMapping(id=key(document), dataset_id=dataset_id, target_dataset_id=identity.key,
            permission_scope=permission_scope, match={"schema_version": 2, **operational,
                "basis": "bid", "historical_identity": dataset.identity, "target_identity": identity.model_dump(),
                "target_catalog": {"symbol": entry.symbol, "type": entry.asset_type,
                    "precision": entry.precision, "updated_at": entry.updated_at},
                "collection_identity": collection_identity(identity).model_dump(),
                "rule": result["rule"], "sources": result["sources"], "difference": result["difference"]})
        db.add(mapping)
        db.flush()
    content = {field: getattr(draft, field) for field in ("historical_evidence", "live_evidence", "rationale")}
    content = {field: str(value) if value is not None else None for field, value in content.items()}
    previous = latest_note(db, mapping.id)
    if not previous or previous.content != content:
        version = previous.version + 1 if previous else 1
        db.add(RealtimeMappingNote(id=key({"mapping_id": mapping.id, "version": version, "content": content}),
            mapping_id=mapping.id, version=version, content=content))
        db.flush()
    return mapping


def baseline(db, dataset_id, calendar):
    """Pure fixed-baseline eligibility shared by candidate reads and first use."""
    version = db.scalar(select(HistoryVersion).join(HistoryArtifact).where(
        HistoryVersion.dataset_id == dataset_id, HistoryVersion.status == "published",
        HistoryArtifact.timeframe == "M1", HistoryArtifact.status == "published", HistoryArtifact.count > 0,
        ~select(HistoryReclamation.version_id).where(HistoryReclamation.version_id == HistoryVersion.id).exists())
        .order_by(HistoryVersion.published_at.desc(), HistoryVersion.id.desc()).limit(1))
    if not version:
        raise ValueError("组合需要已有可用的固定M1历史及周期产物，请先维护")
    newest = chart_page(db, version.id, "M1", count=1)["bars"][-1]
    cutoff = min(version.end, newest["end"])
    seam = ms(session_bounds(instant(cutoff), calendar)[0])
    if seam <= version.start:
        raise ValueError("日界拼接点之前没有历史基线，请先维护更早历史；不会自动改成非日界拼接")
    return version, seam


def definition(db, dataset_id, mapping_id, *, permission_scope="workspace:default"):
    """Pure identity computation for saved mappings and uncreated candidates."""
    dataset = db.get(MarketDataset, dataset_id)
    mapping = db.get(RealtimeMapping, mapping_id)
    if (not dataset or not mapping or mapping.dataset_id != dataset_id or
            mapping.permission_scope != permission_scope):
        raise ValueError("请选择本权限范围内明确保存的实时映射")
    source = db.get(Instrument, dataset.instrument_id)
    rules = {**RULES, "aggregation_calendar": source.calendar,
             "historical_calendar_version": dataset.identity["calendar_version"]}
    ident = key({"permission_scope": permission_scope, "dataset_id": dataset_id,
                 "mapping_id": mapping_id, "rules": rules})
    target = db.get(MarketDataset, mapping.target_dataset_id)
    identity = DatasetIdentity.model_validate(target.identity)
    if identity.account_scope != account_scope():
        raise ValueError("实时映射属于其他账户，请明确保存新映射")
    return dataset, mapping, source, target, identity, rules, ident


def first_use(db, dataset_id, mapping_id, *, permission_scope="workspace:default"):
    db.scalar(select(MarketDataset).where(MarketDataset.id == dataset_id).with_for_update())
    dataset, mapping, source, target, identity, rules, ident = definition(
        db, dataset_id, mapping_id, permission_scope=permission_scope)
    existing = db.get(MarketComposite, ident)
    if existing:
        fixed = db.get(CompositeRevision, existing.active_revision_id)
        request_artifacts(db, db.get(HistoryVersion, fixed.history_version_id), FRAMES)
        from .composite_aggregates import request
        request(db, fixed.id)
        return existing  # Daily publication never moves the original baseline/T.
    version, seam = baseline(db, dataset_id, source.calendar)
    ticker = "MC:" + ident[:25] + ":" + dataset.logical_symbol
    instrument = Instrument(id=ticker, label=dataset.logical_symbol, source="composite",
        symbol=dataset.logical_symbol, basis="bid", calendar=source.calendar,
        precision=max(source.precision, db.get(Instrument, target.instrument_id).precision),
        calendar_profile={}, enabled=False)
    db.add(instrument)
    db.flush()
    composite = MarketComposite(id=ident, instrument_id=ticker, dataset_id=dataset_id,
        mapping_id=mapping_id, permission_scope=permission_scope, rules=rules)
    db.add(composite)
    db.flush()
    revision = CompositeRevision(composite_id=ident, history_version_id=version.id,
        mapping_id=mapping_id, seam=seam, rules=rules, request_id="first-use")
    db.add(revision)
    db.flush()
    composite.active_revision_id = revision.id
    request_artifacts(db, version, FRAMES)
    db.add(CompositePreparation(revision_id=revision.id, cursor=seam,
        cutoff=(now_ms() - 5000) // 60000 * 60000, state={"stage": "confirm_recent_m1",
            "historical_input": {"version_id": version.id, "checksum": version.manifest["checksum"],
                "start": version.start, "end": seam}, "target_identity": identity.model_dump()}))
    db.flush()
    from .composite_aggregates import request
    request(db, revision.id)
    return composite
