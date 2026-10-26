const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {request}=require('@playwright/test');
(async()=>{
 const base=process.env.MW_HISTORY_MODES_BASE_URL, out=process.env.MW_HISTORY_MODES_OUTPUT;
 const ctx=await request.newContext({baseURL:base,ignoreHTTPSErrors:false,timeout:120000});
 const report={started:new Date().toISOString(),passed:false,cases:[]};
 const api=async(route,data)=>{const r=await ctx[data===undefined?'get':'post']('/api'+route,data===undefined?{}:{data,headers:{'X-CSRF-Token':csrf}});if(!r.ok())throw Error(`${route} HTTP ${r.status()} ${(await r.text()).slice(0,800)}`);return r.json()};
 let csrf;
 try{
  assert((await ctx.post('/api/login',{data:JSON.parse(fs.readFileSync(process.env.MW_HISTORY_MODES_AUTH_FILE))})).ok());
  csrf=(await api('/session')).csrf;
  const hash=s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,32);
  for(const [name,id] of [['sina-a','AKSHARE:'+hash('SZSE:000001')],['sina-hk','AKSHARE:'+hash('HKEX:00700')],['tencent-a','TENCENT:SZSE:000001'],['yahoo-us','YAHOO:'+hash('AAPL')]]){
   console.log('Platform',name);
   const meta=await api('/market-data/resolve',{instrument:id,series_kind:'provider',timeframe:'D1'});
   const body={instrument:id,series_kind:'provider',timeframe:'D1',limit:100,before:Date.now(),client:'equity-qfq-acceptance'};
   const started=Date.now();let page=await api('/charts/data',body);
   for(let n=0;!page.bars?.length&&n<18;n++){await new Promise(r=>setTimeout(r,2000));page=await api('/charts/data',body)}
   assert(page.bars?.length>0,JSON.stringify(page).slice(0,800));
   const repeat=await api('/charts/data',body);assert.deepEqual(repeat.bars,page.bars);
   const record={name,id,source_family:meta.source_family,adjustment:meta.adjustment,description:meta.price_description,rows:page.bars.length,first:page.bars[0],last:page.bars.at(-1),elapsed_ms:Date.now()-started,cache_repeat:true};
   if(name!=='yahoo-us')assert.equal(meta.adjustment,'qfq');
   if(name!=='yahoo-us'){
    const quotes=await api('/market-data/quotes',{symbols:['MWP:'+id]});
    const quote=quotes[0];
    assert.equal(quote.s,'ok',JSON.stringify(quote));
    assert.equal(quote.resolution,'D1');assert.equal(quote.time_type,'source_d1');
    assert.equal(quote.v.resolution,'D1');assert.equal(quote.v.time_type,'source_d1');
    assert(quote.v.lp>0);record.quote=quote;
   }
   report.cases.push(record);fs.writeFileSync(out,JSON.stringify(report,null,2));
  }
  report.passed=true;
 }catch(e){report.error=e.message;process.exitCode=1;console.log(e.message)}finally{report.finished=new Date().toISOString();fs.writeFileSync(out,JSON.stringify(report,null,2));await ctx.dispose();console.log({passed:report.passed,cases:report.cases.length})}
})();
