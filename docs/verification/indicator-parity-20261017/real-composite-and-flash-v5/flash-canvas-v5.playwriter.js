const fs=require('node:fs');
await state.flashPage.bringToFront();
state.flashEvents=[];let injected=false;
state.flashExpiryRoute=async route=>{const q=route.request().postDataJSON();if(!injected&&q.provider_snapshot_id&&q.indicators?.length){injected=true;q.provider_snapshot_id='cb891ef36cb238bea44ff56c8d3c3226ce3046b59db87b5395684e3f1ff9b9eb';return route.continue({postData:JSON.stringify(q)});}return route.continue();};
await state.flashPage.route('**/api/charts/data',state.flashExpiryRoute);
await state.flashNative.evaluate(()=>{
 globalThis.candlePaint={samples:[],until:Date.now()+20000};
 function sample(){if(Date.now()>candlePaint.until)return;
  const c=document.querySelector('canvas'),data=c.getContext('2d').getImageData(0,70,c.width,c.height-70).data;
  let colored=0;for(let i=0;i<data.length;i+=4)if(data[i+3]>100&&((data[i]>180&&data[i+1]<110&&data[i+2]<140)||(data[i]<80&&data[i+1]>100&&data[i+2]>65)))colored++;
  candlePaint.samples.push({at:Date.now(),colored});requestAnimationFrame(sample);
 }sample();
});
try{
 await state.flashChart.evaluate(()=>widget.activeChart().createStudy('守望 Python LWMA',false,false,{period:23}));
 await state.flashPage.waitForTimeout(6500);
 const paint=await state.flashNative.evaluate(()=>candlePaint.samples);
 const result={injected,network:state.flashEvents,paint,baseline:paint[0]?.colored,min:Math.min(...paint.map(x=>x.colored))};
 result.blank=result.min<result.baseline*.15;result.resets=await state.flashChart.evaluate(()=>flashProbe.events);result.status=await state.flashChart.evaluate(()=>{const c=widget.activeChart();const id=c.getAllStudies().find(x=>x.name==='守望 Python LWMA')?.id;return {binding:indicatorBindings.get(indicatorKey(c.symbol(),c.resolution())),scope:id?MWNativeIndicatorResults.scope(c,id):null};});
 fs.writeFileSync('/tmp/mw-issue74-20261017/flash-canvas-v5.json',JSON.stringify(result,null,2));
 console.log({injected,baseline:result.baseline,min:result.min,blank:result.blank,frames:paint.length,resets:result.resets,scopeReady:!!result.status.scope?.coverage,errors:state.flashEvents.filter(x=>x.status>=400)});
 if(!injected||!result.network.some(x=>x.status===422&&x.detail?.code==='DISPLAY_SNAPSHOT_EXPIRED'))throw Error('INVALID: expiry trigger was not exercised');
 if(result.resets.length)throw Error('RED: unchanged provider recovery reset the main chart');
 if(!result.status.scope?.coverage)throw Error('RED: indicator did not accept renewed credential');
 if(result.blank)throw Error('RED: existing candle paint disappeared during expired-snapshot recovery after adding indicator');
}finally{await state.flashPage.unroute('**/api/charts/data',state.flashExpiryRoute);}
