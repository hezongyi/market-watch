const fs=require('node:fs');
const result=await state.accountChart.evaluate(id=>{const c=widget.activeChart();const s=id?MWNativeIndicatorResults.scope(c,id):null;return {symbol:c.symbol(),res:c.resolution(),bars:c._chartWidget.model().model().mainSeries().data().size(),study:id?{id,last:c._chartWidget.model().model().dataSourceForId(id).data().last()?.value,scope:s}:null};},state.accountStudy||null);
fs.writeFileSync('/tmp/mw-issue74-20261017/account-v6-'+(state.accountRun||'plain-1')+'-scope.json',JSON.stringify(result,null,2));console.log(result);
if(result.study&&(!result.study.scope?.coverage||result.study.scope?.transition||!(Number.isFinite(result.study.last?.[1])||Number.isFinite(result.study.last?.[2]))))throw Error('Current Supertrend coverage missing');
