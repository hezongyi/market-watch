const fs=require('node:fs');
state.flashSetupRoute=async route=>{
 const q=route.request().postDataJSON();
 if(q?.series_kind==='provider'&&q.native_history){
  q.before=Math.min(q.before||1792195200000,1792195200000);q.firstDataRequest=false;
  if(q.from>=q.before)q.from=q.before-86400000*14;
  if(q.native_reserve?.target_end>q.before)q.native_reserve.target_end=q.before;
  fs.writeFileSync('/tmp/mw-issue74-20261017/flash-bounded-load-query.json',JSON.stringify(q,null,2));
  return route.continue({postData:JSON.stringify(q)});
 }return route.continue();
};
await state.flashPage.route('**/api/charts/history-loads',state.flashSetupRoute);
await state.flashPage.route('**/api/charts/data',state.flashSetupRoute);
try{
 await state.flashChart.evaluate(()=>widget.activeChart().resetData());
 await state.flashChart.waitForFunction(()=>widget.activeChart().dataReady()&&providerRecoveryRows(widget.activeChart())?.length>50,{},{timeout:15000});
 console.log(await state.flashChart.evaluate(()=>{for(const s of widget.activeChart().getAllStudies())widget.activeChart().removeEntity(s.id);flashProbe.events=[];return {symbol:widget.activeChart().symbol(),count:providerRecoveryRows(widget.activeChart())?.length};}));
}finally{
 await state.flashPage.unroute('**/api/charts/data',state.flashSetupRoute);
 await state.flashPage.unroute('**/api/charts/history-loads',state.flashSetupRoute);
}
