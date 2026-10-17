const fs=require('node:fs');
state.realReviewDir='/tmp/mw-issue74-20261017/real-data-review';fs.mkdirSync(state.realReviewDir,{recursive:true});
state.realReviewResponses=[];state.realReviewErrors=[];state.realReviewPending=new Set();
state.realReviewCapture=response=>{
  const path=new URL(response.url()).pathname;
  if(!path.startsWith('/api/')||/session|login|settings|preferences/.test(path)||response.headers()['content-type']?.includes('text/event-stream'))return;
  const job=(async()=>{try{
    const q=response.request().method()==='POST'?response.request().postDataJSON():{};
    const d=await response.json();
    state.realReviewResponses.push({at:Date.now(),path,status:response.status(),
      query:Object.fromEntries(['instrument','series_kind','timeframe','indicators','limit','before','display_snapshot_id','provider_snapshot_id'].map(k=>[k,q?.[k]])),
      detail:response.status()>=400?d.detail:undefined,timings:d.timings_ms,barCount:d.bars?.length,
      first:d.bars?.[0],last:d.bars?.at(-1),page:Object.fromEntries(['series_kind','timeframe','cache_revision','origin','calculation_origin','revision_id','input_revision','provider_snapshot_id','display_snapshot_id','history_boundary','has_more','reserve_status','history_status'].map(k=>[k,d[k]])),
      indicators:d.indicators?.map(i=>({name:i.name,params:i.params,calculation:i.calculation,series:i.series?.map(s=>({key:s.key,count:s.values.length,finite:s.values.filter(v=>Number.isFinite(v.value)).length,last:s.values.at(-1)}))}))});
  }catch{}})();state.realReviewPending.add(job);job.finally(()=>state.realReviewPending.delete(job));
};
state.realReviewOnError=error=>state.realReviewErrors.push({at:Date.now(),message:error.message});
state.realPage.on('response',state.realReviewCapture);state.realPage.on('pageerror',state.realReviewOnError);
await state.realPage.screenshot({path:state.realReviewDir+'/00-initial-btc-h4.png',scale:'css'});
await state.realNative.getByRole('button',{name:'商品代码搜索',exact:true}).click();
console.log((await state.realNative.locator('body').ariaSnapshot()).slice(-14000));
