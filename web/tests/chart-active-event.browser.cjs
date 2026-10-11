// Ubuntu Chromium; real licensed widget; synthetic prices; no deployed instance.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const library = path.resolve(process.env.MW_PROBE_LIBRARY || path.join(root, 'advanced-host/charting_library'));
const source = fs.readFileSync(path.join(root, 'advanced-host/bridge.js'), 'utf8');
const binding = source.slice(source.indexOf('const timezoneBindings = new Map();'), source.indexOf('\nfunction marketQuery('));
const fixture = `
let callbacks=0;
const refreshQuotePresentation=()=>callbacks++;
${binding}
const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['60']}),0),resolveSymbol:(name,cb)=>setTimeout(()=>cb({name,ticker:name,description:name,type:'forex',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100000,has_intraday:true,supported_resolutions:['60']}),0),getBars:(s,r,p,cb)=>setTimeout(()=>cb(Array.from({length:p.countBack},(_,i)=>({time:(Math.floor(p.to/3600)-p.countBack+i)*3600000,open:1.12,high:1.13,low:1.11,close:1.12})),{noData:false}),0),subscribeBars:()=>{},unsubscribeBars:()=>{}};
let widget,ready=false,failure;
function boot(state){
 ready=false;
 widget=new TradingView.widget({container:'chart',library_path:'/charting_library/',datafeed:feed,symbol:'EURUSD',interval:'60',locale:'en',autosize:true,saved_data:state,enabled_features:['support_multicharts'],disabled_features:['use_localstorage_for_settings','create_volume_indicator_by_default']});
 widget.onChartReady(()=>{try{bindActiveChartEvent();bindActiveChartEvent();ready=true;}catch(e){failure=String(e);}});
}
boot();
`;
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.route('https://active-event.invalid/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><style>html,body,#chart{margin:0;width:100%;height:100%}</style><div id="chart"></div><script src="/charting_library/charting_library.js"></script><script>${fixture}</script>`});
   const relative=p.replace(/^\/charting_library\//,'');
   const file=path.resolve(library,relative);
   if(!file.startsWith(library+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream'});
  });
  await page.goto('https://active-event.invalid/');
  await expect.poll(()=>page.evaluate(()=>ready||failure),{timeout:15000}).toBeTruthy();
  assert.equal(await page.evaluate(()=>failure),undefined,'First subscriber must not cancel an uncreated native event');
  await page.evaluate(()=>widget.setLayout('2h'));
  await expect.poll(()=>page.evaluate(()=>widget.chartsCount())).toBe(2);
  await page.evaluate(()=>{callbacks=0;bindActiveChartEvent();bindActiveChartEvent();});
  await page.evaluate(()=>widget.setActiveChart(1));
  await expect.poll(()=>page.evaluate(()=>widget.activeChartIndex())).toBe(1);
  assert.equal(await page.evaluate(()=>callbacks),1,'Repeated layout bindings must retain one callback');
  const state=await page.evaluate(()=>new Promise(resolve=>widget.save(resolve)));
  await page.evaluate(state=>{unbindActiveChartEvent();widget.remove();boot(state);},state);
  await expect.poll(()=>page.evaluate(()=>ready||failure),{timeout:15000}).toBeTruthy();
  assert.equal(await page.evaluate(()=>failure),undefined,'Saved layout restores without interrupting initialization');
  await page.evaluate(()=>{unbindActiveChartEvent();unbindActiveChartEvent();});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,scope:'Actual licensed widget on Ubuntu; synthetic prices',cases:['First native subscriber initializes','Repeated binding produces one callback','Saved two-chart layout reinitializes','Repeated disposal is safe'],errors}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
