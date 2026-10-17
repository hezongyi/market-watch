const fs=require('node:fs');
function readSource(id){const c=widget.activeChart(),n=c._chartWidget.model().model().dataSourceForId(id),rows=[];
 c._chartWidget.model().model().mainSeries().data().each((_,row)=>{rows.push(row.slice(0,6));});
 return {symbol:c.symbol(),res:c.resolution(),rows,inputs:c.getStudyById(id).getInputValues(),
  scope:MWNativeIndicatorResults.scope(c,id),last:n.data().last()?.value};}
// Serialize the function directly through Playwriter's page evaluator.
state.compositeBeforeReload=await state.compositeChart.evaluate(readSource,state.compositeSupertrend);
await state.compositePage.reload();await state.compositePage.waitForTimeout(1500);
state.compositeChart=state.compositePage.frames().find(f=>f.url().startsWith('https://127.0.0.1:17475/'));
await state.compositeChart.waitForFunction(()=>typeof widget!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),{},{timeout:15000});
state.compositeSupertrend=await state.compositeChart.evaluate(()=>widget.activeChart().getAllStudies().find(x=>x.name==='守望 Python SUPERTREND_PINE_V1')?.id);
await state.compositeChart.waitForFunction(id=>{const c=widget.activeChart(),s=MWNativeIndicatorResults.scope(c,id);if(!s?.coverage||s.transition)return false;
 const last=c._chartWidget.model().model().dataSourceForId(id).data().last()?.value;return Number.isFinite(last?.[1])||Number.isFinite(last?.[2]);},state.compositeSupertrend,{timeout:15000});
state.compositeAfterReload=await state.compositeChart.evaluate(readSource,state.compositeSupertrend);
const result={before:state.compositeBeforeReload,after:state.compositeAfterReload,
 helperLoaded:await state.compositeChart.evaluate(()=>typeof refreshProviderDisplayCredential),
 sameVisibleRows:JSON.stringify(state.compositeBeforeReload.rows)===JSON.stringify(state.compositeAfterReload.rows),
 sameLast:JSON.stringify(state.compositeBeforeReload.last)===JSON.stringify(state.compositeAfterReload.last)};
fs.writeFileSync('/tmp/mw-issue74-20261017/composite-reload-final.json',JSON.stringify(result,null,2));
await state.compositePage.screenshot({path:'/tmp/mw-issue74-20261017/composite-final-h4.png',scale:'css'});
console.log({symbol:result.after.symbol,bars:result.after.rows.length,sameVisibleRows:result.sameVisibleRows,sameLast:result.sameLast,helperLoaded:result.helperLoaded});
if(!result.sameLast)throw Error('Composite Supertrend changed after saved-layout reload');
