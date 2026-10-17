const fs=require('node:fs');state.compositeSmoke=[];
await state.compositePage.bringToFront();
for(const res of ['60','15','240']){
 await state.compositeChart.evaluate(r=>widget.activeChart().setResolution(r),res);
 await state.compositeChart.waitForFunction(({res,id})=>{
  const c=widget.activeChart(),s=MWNativeIndicatorResults.scope(c,id);
  if(c.resolution()!==res||!s?.coverage||s.transition||s.resolution!==res)return false;
  const n=c._chartWidget.model().model().dataSourceForId(id);let trend=0;
  n.data().each((_,row)=>{if(Number.isFinite(row[1])||Number.isFinite(row[2]))trend++;});
  return trend>0;
 },{res,id:state.compositeSupertrend},{timeout:20000});
 const result=await state.compositeChart.evaluate(id=>{const c=widget.activeChart(),n=c._chartWidget.model().model().dataSourceForId(id),finite={};
  n.data().each((_,row)=>{row.forEach((v,i)=>{if(i&&Number.isFinite(v))finite[i]=(finite[i]||0)+1;});});
  return {symbol:c.symbol(),res:c.resolution(),bars:c._chartWidget.model().model().mainSeries().data().size(),finite,last:n.data().last()?.value,scope:MWNativeIndicatorResults.scope(c,id)};
 },state.compositeSupertrend);
 state.compositeSmoke.push(result);console.log({res,bars:result.bars,up:result.finite[1],down:result.finite[2]});
 fs.writeFileSync('/tmp/mw-issue74-20261017/composite-real-smoke.json',JSON.stringify(state.compositeSmoke,null,2));
}
