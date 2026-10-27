// Licensed widget + actual chart-runtime/datafeed + real shared EventSource.
// HTTP history and pushed prices are deterministic fixtures; no real supplier.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const ts = require('typescript');
const {chromium} = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
const library = process.env.MW_CHART_LIBRARY_PATH || path.join(root, 'advanced-host/charting_library');
const runtime = fs.readFileSync(path.join(root, 'advanced-host/chart-runtime.js'), 'utf8');
const transport = ts.transpileModule(fs.readFileSync(path.join(root, 'web/src/advanced/providerSubscriptions.ts'), 'utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
const fixture = `
const application={observe(value){
  if(value.type==='market-subscribe')globalThis.transport.subscribe(value.args);
  if(value.type==='market-unsubscribe')globalThis.transport.unsubscribe(value.args);
  if(value.type==='market-accept')void fetch('/api/charts/stream/accept',{method:'POST',body:JSON.stringify(value.args)});
},cancel(){}};
globalThis.adapter=(new Function('application',${JSON.stringify(runtime.replace(/return adapter;\s*$/, `
request=async ({op,args})=>{
  if(op==='serverTime')return Math.floor(Date.now()/1000);
  if(op==='quotes')return [];
  if(op==='resolve')return {symbol:args.instrument,source:'binance',calendar:'utc0',
    precision:4,frames:['M1'],timezone:'Etc/UTC',session:'24x7',stream:true};
  return {items:[],remaining:0};
};
query=async (symbol,res,args)=>{
  const response=await fetch('/fixture/history?'+new URLSearchParams({symbol,before:args.before || Date.now(),limit:args.limit || 300}));
  return response.json();
};
globalThis.fixtureRuntime={feed,attach(value){widget=value;ready=true;},
  subscriptions:()=>[...subscriptions.values()].map(sub=>({symbol:sub.symbol,res:sub.res,
    listener:sub.marketListener,generation:sub.marketGeneration,last:sub.last,recovering:sub.marketRecovering})),
  stop(){
    for(const id of [...subscriptions.keys()])feed.unsubscribeBars(id);
    for(const id of [...quoteSubscriptions.keys()])feed.unsubscribeQuotes(id);
  },
};
return adapter;
`))}))(application);
`;
(async()=>{
  const sockets=new Set(), requests=[];
  let connections=0, revision=1, historyReads=0;
  const last=Math.floor(Date.now()/60000)*60000-60000;
  const bar=(start,close)=>({start,end:start+60000,chart_time:start,open:1,high:Math.max(1.2,close),low:0.9,close,complete:true});
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/charts/stream/events'){
      connections++;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
      res.write('retry: 100\n: connected\n\n');sockets.add(res);req.on('close',()=>sockets.delete(res));return;
    }
    if(req.method==='POST'){
      let body='';for await(const chunk of req)body+=chunk;
      requests.push({path:url.pathname,body:JSON.parse(body)});res.writeHead(200,{'Content-Type':'application/json'}).end('{}');return;
    }
    if(url.pathname==='/fixture/history'){
      historyReads++;
      const before=Number(url.searchParams.get('before'));
      const count=Math.min(2000,Math.max(300,Number(url.searchParams.get('limit'))));
      const end=Math.min(last,Math.floor((before-1)/60000)*60000);
      const bars=Array.from({length:count},(_,index)=>bar(end-(count-index-1)*60000,revision===1 ? 1.1 : 1.17));
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({bars,indicators:[],has_more:false,
        calendar:'utc0',as_of:Date.now(),cache_revision:revision,origin:bars[0].start,
        history_check:{next_revision:String(revision),next_tail_revision:String(revision)}}));return;
    }
    if(url.pathname==='/fixture/runtime.js'){res.writeHead(200,{'Content-Type':'text/javascript'}).end(fixture);return;}
    let base, relative;
    if(url.pathname.startsWith('/vendor/')){base=library;relative=url.pathname.slice(8);}
    if(url.pathname.startsWith('/host/')){base=path.join(root,'advanced-host');relative=url.pathname.slice(6);}
    if(base){
      const file=path.resolve(base,relative);
      if(!file.startsWith(path.resolve(base)+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}
      const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'};
      res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res);return;
    }
    res.writeHead(200,{'Content-Type':'text/html'}).end(`<!doctype html><style>body{margin:0}#chart{height:650px;width:1000px}</style><div id="chart"></div>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.stack || error.message));
  const wait=async predicate=>{const until=Date.now()+20000;while(!predicate()){
    assert.ok(Date.now()<until,'native stream condition timed out');await new Promise(resolve=>setTimeout(resolve,25));}};
  const send=event=>{for(const socket of sockets)socket.write('data: '+JSON.stringify(event)+'\n\n');};
  try{
    await page.goto('http://127.0.0.1:'+server.address().port);
    for(const file of ['series.js','price-format.js','composite-display-batches.js','bar-range-mapping.js','viewports.js'])
      await page.addScriptTag({url:'/host/'+file});
    await page.addScriptTag({url:'/vendor/charting_library.js'});
    await page.addScriptTag({content:'globalThis.exports={};\n'+transport});
    await page.evaluate(()=>{
      globalThis.transport=exports.providerSubscriptions(async(path,body)=>{
        const response=await fetch('/api'+path,{method:'POST',body:JSON.stringify(body)});return response.json();
      },client=>new EventSource('/api/charts/stream/events?client='+client),
      event=>{void adapter.update({type:'market-event',event});},error=>{throw error;});
    });
    await page.addScriptTag({url:'/fixture/runtime.js'});
    const supplier='MWP:BTCUSDT';
    const composite=await page.evaluate(()=>MWSeries.encode('a'.repeat(64),'composite'));
    await page.evaluate(symbol=>{
      globalThis.testWidget=new TradingView.widget({container:'chart',symbol,interval:'1',
        library_path:'/vendor/',datafeed:fixtureRuntime.feed,locale:'zh',timezone:'Etc/UTC',
        width:1000,height:650,disabled_features:['use_localstorage_for_settings','header_widget','left_toolbar'],
      });
      testWidget.onChartReady(()=>{fixtureRuntime.attach(testWidget);globalThis.chartReady=true;});
    },supplier);
    await page.waitForFunction(()=>globalThis.chartReady);
    // Read the pinned v31 model used by the other native acceptance tests.
    // The production library intentionally omits the optional CSV export chunk.
    const latestClose=()=>page.evaluate(()=>{
      const bars=testWidget.activeChart()._chartWidget.model().model().mainSeries().bars();
      return bars.valueAt(bars.lastIndex())?.[4];
    });
    await page.waitForFunction(()=>testWidget.activeChart().dataReady() &&
      testWidget.activeChart()._chartWidget.model().model().mainSeries().bars().size()>0);
    for(const ticker of [supplier,composite]){
      if(ticker!==supplier)await page.evaluate(symbol=>new Promise(resolve=>testWidget.activeChart().setSymbol(symbol,resolve)),ticker);
      await wait(()=>requests.some(row=>row.path.endsWith('/subscribe')&&row.body.query.instrument===(ticker===supplier?'BTCUSDT':'a'.repeat(64))));
      const sub=await page.evaluate(ticker=>fixtureRuntime.subscriptions().find(sub=>sub.symbol===ticker),ticker);
      assert.ok(sub?.listener,'native subscription did not register');
      send({listener:sub.listener,generation:sub.generation,sequence:1,type:'bars',
        bars:[bar(last,1.19)]});
      const until=Date.now()+10000;
      while(await latestClose()!==1.19){assert.ok(Date.now()<until,'real widget never applied streamed callback');await page.waitForTimeout(30);}
      const before=historyReads;revision++;
      send({listener:sub.listener,generation:sub.generation,sequence:2,type:'reset',reason:'history_changed'});
      await wait(()=>historyReads>before);
      const end=Date.now()+18000;
      while(await latestClose()!==1.17){assert.ok(Date.now()<end,'reset did not reload authoritative history into real widget');await page.waitForTimeout(30);}
      await page.waitForFunction(()=>fixtureRuntime.subscriptions().every(sub=>!sub.recovering));
      send({listener:sub.listener,generation:sub.generation,sequence:99,type:'bars',bars:[bar(last,9)]});
      assert.equal(await latestClose(),1.17,'retired generation changed real widget');
    }
    for(const socket of sockets)socket.end();
    await wait(()=>connections===2);
    assert.equal(sockets.size,1);
    await page.evaluate(()=>fixtureRuntime.stop());await wait(()=>sockets.size===0);
    assert.ok(requests.every(row=>row.path.startsWith('/api/charts/stream/')));
    assert.deepEqual(errors,[]);
    console.log('PASS: licensed widget supplier/composite callbacks, reset→HTTP reload, switch, reconnect and cancel');
  }catch(error){
    console.error({errors,connections,historyReads,requests:requests.slice(-3),
      runtime:await page.evaluate(()=>JSON.stringify({ready:globalThis.chartReady,widget:!!globalThis.testWidget,
        symbol:globalThis.testWidget?.activeChart().symbol(),
        subscriptions:globalThis.fixtureRuntime?.subscriptions()})).catch(()=>null)});
    throw error;
  }finally{
    await browser.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
