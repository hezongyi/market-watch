"""Managed-history extension commands; reads never create collection demand."""

from sqlalchemy import select

from .composite_center import SCOPE, detail, mappings
from .composite_definitions import baseline, definition, first_use
from .composite_matching import product_rule
from .config import settings
from .history_catalog import account_scope
from .market_contracts import DatasetIdentity
from .realtime_switch import enabled, set_enabled
from .storage import Instrument, MarketCatalog, MarketComposite, MarketDataset, Preference, now_ms


def default_key(dataset_id):
    return "managed_continuation:" + dataset_id


def report(db, dataset_id):
    dataset = db.get(MarketDataset, dataset_id)
    if not dataset:
        raise ValueError("自建行情不存在")
    source = db.get(Instrument, dataset.instrument_id)
    identity = DatasetIdentity.model_validate(dataset.identity)
    reason = None
    supported = identity.mode == "base_m1" and identity.basis == "bid"
    if not supported:
        reason = "实时接续目前只支持已核实品种的 M1 基础 Bid 行情"
    elif not settings.oanda_account_id or not settings.oanda_token:
        supported, reason = False, "OANDA Practice 连接尚未配置"
    else:
        entries = db.scalars(select(MarketCatalog).where(MarketCatalog.source == "oanda",
            MarketCatalog.available.is_(True)))
        supported = any(entry.metadata_json.get("history_account_scope") == account_scope()
            and bool(product_rule(identity, entry)[0]) for entry in entries)
        if not supported:
            reason = "当前账户目录中没有已核实可接续的品种，请检查来源目录与产品规则"
    options = mappings(db, dataset_id)["items"]
    valid = [item for item in options if item["current_account"] and item["valid_for_selection"]]
    saved = db.get(Preference, default_key(dataset_id))
    selected = saved.value.get("mapping_id") if saved else valid[0]["id"] if len(valid) == 1 else None
    chosen = next((item for item in valid if item["id"] == selected), None)
    composite = None
    ready = False
    if supported and chosen:
        try:
            *_, ident = definition(db, dataset_id, chosen["id"])
            composite = db.get(MarketComposite, ident)
            if composite is None:
                baseline(db, dataset_id, source.calendar)
            ready = True
        except ValueError as error:
            reason = str(error)
    elif supported:
        reason = ("请选择默认实时接续配置" if len(valid) > 1 else
                  "原默认接续配置已失效，请重新核对来源" if saved else "请先配置并核对实时来源")
    active = enabled(db, source.id)
    current = detail(db, composite.id) if composite else None
    state = ("disabled" if not active else "attention" if not ready else
             current["status"] if current else "preparing")
    configurations = [{"id": item.id, "active_revision_id": item.active_revision_id,
        "created_at": item.created_at} for item in db.scalars(select(MarketComposite).where(
            MarketComposite.dataset_id == dataset_id, MarketComposite.permission_scope == SCOPE)
            .order_by(MarketComposite.created_at.desc(), MarketComposite.id))]
    return {"dataset_id": dataset_id, "supported": supported, "reason": reason,
        "enabled": active, "ready_to_enable": ready, "status": state,
        "default_mapping_id": selected, "mappings": options, "composite": current,
        "configurations": configurations}


def configure(db, dataset_id, *, value, mapping_id=None):
    # Serialize default selection and first-use with mapping/history commands.
    dataset = db.scalar(select(MarketDataset).where(MarketDataset.id == dataset_id).with_for_update())
    if not dataset:
        raise ValueError("自建行情不存在")
    if not value:
        set_enabled(db, dataset.instrument_id, False, now=now_ms())
        return report(db, dataset_id)
    current = report(db, dataset_id)
    if not current["supported"]:
        raise ValueError(current["reason"])
    selected = mapping_id or current["default_mapping_id"]
    if not any(row["id"] == selected and row["valid_for_selection"] and row["current_account"]
               for row in current["mappings"]):
        raise ValueError("请选择并核对当前账户的默认实时接续配置")
    # A failed baseline/configuration rolls back the choice and switch together.
    first_use(db, dataset_id, selected, permission_scope=SCOPE)
    saved = db.get(Preference, default_key(dataset_id))
    value_document = {"mapping_id": selected}
    if saved:
        saved.value = value_document
    else:
        db.add(Preference(key=default_key(dataset_id), value=value_document))
    set_enabled(db, dataset.instrument_id, True, now=now_ms())
    db.flush()
    return report(db, dataset_id)
