// Production-built host + real bridge + native engine. Playwright routes all
// files and supplies in-memory parent RPCs; no listening service or database.
const { chromium } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const assets = process.env.MAXIMIZE_ASSETS;
assert.ok(assets, "Set MAXIMIZE_ASSETS to a privately built advanced-host asset directory");
const origin = "https://mw-maximize-bridge.invalid";
const output = process.env.MAXIMIZE_BRIDGE_OUTPUT || "/tmp/mw-chart-maximize-bridge.json";
const report = { environment:"Ubuntu Playwright routed built host with real bridge and synthetic parent RPC", cases:[], errors:[] };
let row = { id:"maximize-bridge", name:"Double-click bridge fixture", revision:0,
  document:{engine:"tv31",schemaVersion:1,symbol:"MWP:BTCUSDT",series_kind:"provider",interval:"60"} };
const preferences = [];
async function rpc(m) {
  if(m.type==='loaded') return {type:'init',document:row.document,workspace:row,catalog:{},preferences,
    history_capabilities:{protocol:1,mode:'continuous',max_bars:200000,workspace_bars:4000000,response_bytes:134217728}};
  if(m.id==null) return;
  const q=m.query,args=q?.args || {};
  let result={};
  if(m.type==='workspace') {
    if(q.op==='list') result=[{...row,symbol:row.document.symbol,resolution:row.document.interval}];
    if(q.op==='load') result={...row,content:JSON.stringify(row.document.state)};
    if(q.op==='save') {
      assert.equal(args.revision,row.revision);
      row={...row,name:args.name,revision:row.revision+1,document:{...row.document,
        state:JSON.parse(args.content),symbol:args.symbol,interval:args.resolution}};
      result={...row,symbol:args.symbol,resolution:args.resolution};
    }
  } else if(m.type==='preferences' && q.op==='save') {
    result={...args,id:String(preferences.length+1),revision:args.revision+1};
    const index=preferences.findIndex(p=>p.kind===args.kind&&p.name===args.name&&p.tool===args.tool);
    if(index>=0)preferences.splice(index,1);
    preferences.push(result);
  } else if(q?.op==='resolve') result={source:'binance',calendar:'utc0',precision:2,basis:'last',volume_kind:'unavailable'};
  else if(['quotes','search','list'].includes(q?.op)||m.type==='watchlist')result=[];
  else if(q?.op==='viewport')result={closed:false};
  return {type:'result',id:m.id,result};
}
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    '/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1600,height:1000}});
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('requestfailed',r=>report.errors.push(r.url()+': '+r.failure()?.errorText));
  await page.clock.setFixedTime(new Date('2026-09-29T00:00:00Z'));
  await page.exposeFunction('fixtureMessage',rpc);
  await page.addInitScript(()=>{
    addEventListener('DOMContentLoaded',()=>{
      if(!globalThis.TradingView?.widget)return;
      TradingView.widget=new Proxy(TradingView.widget,{construct(target,[options]){
        const feed=options.datafeed;
        feed.getServerTime=cb=>cb(Date.UTC(2026,8,29)/1000);
        feed.getBars=(s,r,p,cb)=>{
          const step=({ '1D':86400,'1W':604800,'1M':2592000 }[r]||Number(r)*60)*1000;
          const end=Math.floor(p.to*1000/step)*step;
          setTimeout(()=>cb(Array.from({length:p.countBack},(_,i)=>({
            time:end-(p.countBack-i)*step,open:100,high:102,low:99,close:101,
          })),{noData:false}),0);
        };
        feed.subscribeBars=()=>{};feed.unsubscribeBars=()=>{};
        return Reflect.construct(target,[options],target);
      }});
    });
  });
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin)return route.fulfill({status:204,body:''});
    if(url.pathname==='/parent')return route.fulfill({contentType:'text/html',body:
      `<!doctype html><body style="margin:0"><iframe style="width:100vw;height:100vh;border:0" src="/?parent=${encodeURIComponent(origin)}"></iframe><script>
        addEventListener('message',async e=>{const m=e.data;if(m?.channel!=='mw-chart-v1')return;
          const value=await fixtureMessage(m);
          if(value)e.source.postMessage({channel:'mw-chart-v1',...value},location.origin);
        });</script>`});
    const file=path.resolve(assets,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    assert.ok(file.startsWith(path.resolve(assets)+path.sep));
    if(!fs.existsSync(file))return route.fulfill({status:404});
    const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'};
    return route.fulfill({contentType:mime[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
  });
  let host,native;
  const settle=async()=>{
    await host.waitForFunction(()=>ready&&!loading&&!nativeSaving&&!rangeGuard?.busy()&&!edgeGuard?.busy()
      &&!MWChartMaximize.resizing()&&Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:30000});
    await host.evaluate(()=>new Promise(resolve=>{
      let previous,stable=0;
      const check=()=>{
        const current=JSON.stringify(Array.from({length:widget.chartsCount()},(_,i)=>{
          const c=widget.chart(i);return [c.getTimeScale().width(),c.getVisibleRange(),c.getTimeScale().barSpacing()];
        }));
        stable=current===previous?stable+1:0;previous=current;
        if(stable>=3)resolve();else requestAnimationFrame(check);
      };requestAnimationFrame(check);
    }));
  };
  const open=async()=>{
    await page.goto(origin+'/parent');
    await page.frameLocator('iframe').locator('#chart').waitFor();
    host=page.frames().find(f=>f.url().includes('/?parent='));
    assert.ok(host);
    await settle();
    native=page.frames().find(f=>f.parentFrame()===host);
    assert.ok(native);
  };
  const state=()=>host.evaluate(()=>({layout:widget.layout(),sync:MWSyncCoordinator.snapshot(),
    charts:Array.from({length:widget.chartsCount()},(_,i)=>{
      const c=widget.chart(i);return {symbol:c.symbol(),resolution:c.resolution(),range:c.getVisibleRange(),
        spacing:c.getTimeScale().barSpacing(),max:c.isMaximized(),studies:c.getAllStudies(),shapes:c.getAllShapes()};
    })}));
  const double=async i=>{
    const p=await host.evaluate(i=>{
      const pane=widget.chart(i)._chartWidget.paneWidgets().find(p=>p.containsMainSeries());
      const r=pane.canvasElement().getBoundingClientRect();
      for(let y=60;y<r.height-30;y+=10)for(let x=80;x<r.width-30;x+=10)
        if(pane._dataSourceAtPoint(x,y)===null&&pane.canvasElement().ownerDocument.elementFromPoint(r.x+x,r.y+y)?.tagName==='CANVAS')
          return {x:r.x+x,y:r.y+y};
      throw Error('No blank native canvas coordinate');
    },i);
    const b=await(await native.frameElement()).boundingBox();
    await page.mouse.dblclick(p.x+b.x,p.y+b.y);
    await settle();
  };
  const record=name=>{report.cases.push({name});console.log('PASS',name);};
  try {
    await open();
    report.hostAsset=await host.evaluate(()=>[...document.scripts].map(s=>s.src).find(s=>/host\.[a-f0-9]+\.js$/.test(s))?.split('/').at(-1));
    assert.ok(report.hostAsset);
    assert.equal(await host.evaluate(()=>autoSave.enabled),false);
    await host.evaluate(()=>{
      widget.setLayout('4');
    });
    await settle();
    await host.evaluate(()=>widget.chart(2).createStudy('Relative Strength Index',false,false));
    await settle();
    for(const mode of ['none','barWidth','date']) {
      await host.evaluate(mode=>MWSyncCoordinator.configure({date:mode==='date',barWidth:mode==='barWidth',time:false}),mode);
      await settle();
      const before=await state();
      await double(2);
      assert.ok((await state()).charts[2].max);
      await page.waitForTimeout(550);
      await double(2);
      assert.deepEqual(await state(),before);
      record(mode+' compiled host bridge + RSI double-click round trip');
    }
    await host.evaluate(()=>new Promise((resolve,reject)=>widget.saveChartToServer(resolve,reject)));
    assert.ok(row.document.state);
    await open();
    const restored=await state();
    assert.equal(restored.layout,'4');
    assert.ok(restored.charts.every(c=>!c.max));
    assert.equal(restored.charts[2].studies[0].name,'Relative Strength Index');
    await double(1);
    assert.ok((await state()).charts[1].max);
    await page.waitForTimeout(550);
    await double(1);
    assert.ok((await state()).charts.every(c=>!c.max));
    record('saved workspace reload rebinds compiled host gesture to current charts');
    assert.deepEqual(report.errors,[]);
  } finally {
    report.lastState=await state().catch(()=>null);
    fs.writeFileSync(output,JSON.stringify(report,null,2));
    await browser.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1});
