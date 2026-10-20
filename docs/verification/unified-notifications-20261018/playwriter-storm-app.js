state.storm={synthetic_browser_intake:true,real_business_producer:false,started:Date.now()};
state.storm.result=await state.app.evaluate(async()=>{
 const session=await(await fetch('/api/session')).json();
 const run=crypto.randomUUID(),profile=crypto.randomUUID(),started=performance.now();
 let index=0;const results=[];
 await Promise.all(Array.from({length:20},async()=>{
  while(index<160){const i=index++,id='b:'+crypto.randomUUID();
   const event={event_id:id,profile,source_kind:'data_center',attempt_id:run+':'+i,occurred_at:Date.now(),code:'MW75_SYNTHETIC_STORM_'+i,severity:i===40?'critical':'info',title:i===40?'MW75 synthetic critical':'MW75 synthetic storm '+i,message:'D1 synthetic intake load; not a real producer failure',context:{workspace_id:'mw75-a',instrument:'EURUSD',test_run:run},evidence:{synthetic:true}};
   const at=performance.now();const r=await fetch('/api/notification-center/events',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify(event)});
   results.push({index:i,id,status:r.status,retryAfter:r.headers.get('Retry-After'),elapsedMs:Math.round(performance.now()-at)});
  }
 }));
 return {run,elapsedMs:Math.round(performance.now()-started),counts:results.reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{}),critical:results.find(r=>r.index===40),rateLimited:results.filter(r=>r.status===429).map(r=>({retryAfter:r.retryAfter})),maxRequestMs:Math.max(...results.map(r=>r.elapsedMs))};
});
console.log(state.storm.result);
