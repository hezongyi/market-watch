const fs=require('node:fs');
const target=await state.realChart.evaluate(()=>{
 const c=widget.activeChart(),id=c.getAllStudies().find(p=>p.name.endsWith(' EMA')).id;
 const scope=MWNativeIndicatorResults.scope(c,id),commit=realCommits.filter(x=>x.identity.algorithmVersion==='EMA:1'&&x.generation===scope.coverage.generation).at(-1);
 const n=c._chartWidget.model().model().dataSourceForId(id),native=[];
 n.data().each((index,row)=>{native.push(row);});
 return {commit,native,query:{instrument:'DUKA:'+c.symbol().split(':')[2].toLowerCase(),series_kind:'provider',timeframe:'H4',
  before:scope.last+14400000,limit:20000,calculation_origin:commit.identity.calculationStart,
  provider_snapshot_id:commit.displaySnapshot,indicators:[]}};
});
const source=await state.realPage.evaluate(async query=>{
 const {csrf}=await(await fetch('/api/session')).json();
 const r=await fetch('/api/charts/data',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(query)});
 return {status:r.status,page:await r.json()};
},target.query);
fs.writeFileSync(state.realReviewDir+'/18-real-xauusd-ema500-source.json',JSON.stringify({target,source},null,2));
console.log({status:source.status,bars:source.page.bars?.length,origin:target.commit.identity.calculationStart,snapshotMatched:source.page.provider_snapshot_id===target.commit.displaySnapshot,error:source.page.detail,native:target.native.length});
