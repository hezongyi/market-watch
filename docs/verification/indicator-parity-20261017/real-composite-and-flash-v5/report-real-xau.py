import json
from sqlalchemy import select
from alerts.storage import transaction,MarketDataset,HistoryVersion,HistoryArtifact,Instrument,MarketComposite,CompositeRevision,CompositePreparation,CompositeReadAttempt,DatasetMaintenance

with transaction() as db:
 dataset_id='876dea0322a7af95954ef967ccf66fc05b26dd1cc8026499d7f60dab3a90cf65'
 dataset=db.get(MarketDataset,dataset_id);inst=db.get(Instrument,dataset.instrument_id)
 versions=list(db.scalars(select(HistoryVersion).where(HistoryVersion.dataset_id==dataset_id)))
 v=next(v for v in versions if v.manifest.get('provenance'))
 c=db.scalar(select(MarketComposite).where(MarketComposite.dataset_id==dataset_id))
 r=db.get(CompositeRevision,c.active_revision_id);p=db.get(CompositePreparation,r.id)
 m=db.get(DatasetMaintenance,dataset_id)
 artifacts=[{'frame':a.timeframe,'status':a.status,'rows':a.count,'complete_rows':a.complete_count,
  'checksum':a.manifest.get('checksum')} for a in db.scalars(select(HistoryArtifact).where(HistoryArtifact.version_id==v.id))]
 attempts=[{k:getattr(a,k) for k in ['start','end','result','observations','accepted','read_kind']} for a in db.scalars(select(CompositeReadAttempt).where(CompositeReadAttempt.revision_id==r.id))]
 out={'dataset_id':dataset_id,'source':dataset.identity,'label':inst.label,'calendar':inst.calendar,
  'calendar_profile':inst.calendar_profile,'version_id':v.id,'manifest':v.manifest,'artifacts':artifacts,
  'composite_id':c.id,'revision_id':r.id,'seam':r.seam,'preparation':{'status':p.status,'cutoff':p.cutoff,
   'cursor':p.cursor,'input_revision':p.input_revision,'error':p.error,'confirmed_end':p.confirmed_end,'attempts':attempts},
  'maintenance':{k:getattr(m,k) for k in ['frequency','target_start','timeframes','overlap_minutes','paused','next_at']},
  'limitations':['Real-time reopening and cross-broker seam not observed during Saturday closure.',
   'Regular source closures reviewed for finite interval only; holiday exceptions and remaining missing minutes stay unknown.',
   'Dukascopy historical quotes and OANDA Practice CFD quotes are distinct broker/product price series.']}
 print(json.dumps(out,indent=2))
