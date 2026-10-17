import json
from sqlalchemy import select
from alerts.history_catalog import refresh_oanda, account_scope
from alerts.composite_definitions import save_mapping,first_use
from alerts.storage import transaction, MarketCatalog,CompositePreparation,CompositeRevision,Instrument

try:
    result=refresh_oanda()
    print(json.dumps({"stage":"real_oanda_catalog_refreshed",**result}),flush=True)
    with transaction() as db:
        entry=db.scalar(select(MarketCatalog).where(MarketCatalog.source=='oanda',
            MarketCatalog.symbol=='XAU_USD',MarketCatalog.available.is_(True),
            MarketCatalog.metadata_json['history_account_scope'].as_string()==account_scope()))
        assert entry and entry.metadata_json.get('history_account_scope')==account_scope()
        proof={"underlying":"XAU","quote_currency":"USD","historical_product":"spot_metal",
            "live_product":"cfd","relationship":"same_underlying_different_product","reviewed":True,
            "historical_evidence":"https://www.dukascopy.com/swiss/english/marketwatch/historical/",
            "live_evidence":"https://developer.oanda.com/rest-live-v20/instrument-ep/",
            "rationale":"Explicit gold/USD BID mapping from Dukascopy public historical XAU/USD to the actual OANDA Practice XAU_USD account instrument. Distinct brokers/products may have different prices and spreads; no identical-price assumption. NY17 specifies aggregation phase only; missing minutes remain unknown."}
        mapping=save_mapping(db,'876dea0322a7af95954ef967ccf66fc05b26dd1cc8026499d7f60dab3a90cf65',entry.id,proof)
        composite=first_use(db,mapping.dataset_id,mapping.id)
        inst=db.get(Instrument,composite.instrument_id)
        inst.label='Issue74 真实 XAUUSD 近两个月 · Duka→OANDA'
        revision=db.get(CompositeRevision,composite.active_revision_id)
        prep=db.get(CompositePreparation,revision.id)
        print(json.dumps({"stage":"composite_created","composite_id":composite.id,
            "instrument":composite.instrument_id,"revision_id":revision.id,
            "mapping_id":mapping.id,"seam":revision.seam,"cutoff":prep.cutoff,
            "target_catalog_origin":entry.metadata_json.get('origin'),
            "prep_status":prep.status}),flush=True)
except Exception as e:
    print(json.dumps({"stage":"failed","error_type":type(e).__name__}),flush=True)
    raise SystemExit(1)
