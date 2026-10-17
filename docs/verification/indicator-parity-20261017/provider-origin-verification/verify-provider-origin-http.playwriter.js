const fs=require('node:fs');
state.originCheckDir='/tmp/mw-issue74-20261017/provider-origin-verification';
fs.mkdirSync(state.originCheckDir,{recursive:true});
const result=await state.realPage.evaluate(async()=>{
 const {csrf}=await(await fetch('/api/session')).json();
 const query={instrument:'DUKA:c2893271b856e9d2550cadc243bdf793',series_kind:'provider',timeframe:'H4',
  before:1792195200000,limit:535,indicators:[{name:'EMA',params:{period:500}}]};
 async function read(body){
  const at=Date.now(),r=await fetch('/api/charts/data',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
  return {at,elapsed:Date.now()-at,status:r.status,page:await r.json(),query:body};
 }
 const fixed=await read({...query,calculation_origin:1787947200000});
 if(fixed.status!==200)return {fixed};
 const snapshot=fixed.page.provider_snapshot_id;
 const fresh=await read({...query,provider_snapshot_id:snapshot});
 const repeated=await read({...query,provider_snapshot_id:snapshot,calculation_origin:1787947200000});
 return {source:'actual task-local API; same exact real XAU/USD provider price snapshot; no source mutation',fixed,fresh,repeated};
});
fs.writeFileSync(state.originCheckDir+'/same-price-snapshot.json',JSON.stringify(result,null,2),{flag:'wx'});
console.log(Object.fromEntries(['fixed','fresh','repeated'].map(k=>{
 const r=result[k],c=r?.page.indicators?.[0]?.calculation;
 return [k,{status:r?.status,bars:r?.page.bars?.length,origin:r?.page.calculation_origin,revision:r?.page.cache_revision,
  inputRows:c?.execution?.input_rows,finite:r?.page.indicators?.[0]?.series[0].values.filter(v=>Number.isFinite(v.value)).length,
  last:r?.page.indicators?.[0]?.series[0].values.at(-1),error:r?.page.detail}];
})));
