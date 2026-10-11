// Feasibility only: real licensed chart, synthetic quotes, in-process browser routes.
// No server, production access, backend writes or vendor file modifications.
const { chromium } = require(process.env.MW_PLAYWRIGHT || '@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const library = process.env.MW_PROBE_LIBRARY;
const output = process.env.MW_PROBE_OUTPUT || '/tmp/mw-native-alert-ui-probe';
if (!library) throw new Error('MW_PROBE_LIBRARY must point to the privately extracted library');
const fixture = `
const feed = {
 onReady: cb => setTimeout(()=>cb({supported_resolutions:['60'],supports_marks:false,supports_timescale_marks:false}),0),
 resolveSymbol: (name,cb) => setTimeout(()=>cb({name,ticker:name,description:name,type:'forex',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100000,has_intraday:true,supported_resolutions:['60']}),0),
 getBars: (symbol,res,p,cb) => setTimeout(()=>{const bars=[];for(let n=p.countBack;n>0;n--){const t=(Math.floor(p.to/3600)-n)*3600000;bars.push({time:t,open:1.12,high:1.125,low:1.115,close:1.121+Math.sin(n)*0.003});}cb(bars,{noData:false});},0),
 subscribeBars:()=>{},unsubscribeBars:()=>{},getQuotes:(symbols,cb)=>cb(symbols.map(n=>({n,s:'ok',v:{lp:1.12,ch:0,chp:0,short_name:n,exchange:'Fixture'}}))),subscribeQuotes:()=>{},unsubscribeQuotes:()=>{}
};
globalThis.widget=new TradingView.widget({container:'chart',library_path:'/charting_library/',datafeed:feed,symbol:'EURUSD',interval:'60',locale:'zh',autosize:true,theme:'Dark',widgetbar:{watchlist:true,details:true,datawindow:true,watchlist_settings:{default_symbols:['EURUSD']}},disabled_features:['use_localstorage_for_settings','create_volume_indicator_by_default'],enabled_features:['support_multicharts']});
widget.onChartReady(()=>globalThis.ready=true);
`;
(async () => {
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 const report={scope:'Ubuntu browser probe; real ZIP library; synthetic data; no deployed instance',cases:[],errors:[]};
 page.on('pageerror',e=>report.errors.push(String(e)));
 await page.route('https://native-alert-shell.invalid/**',async route=>{
  const u=new URL(route.request().url());
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><style>html,body,#chart{margin:0;height:100%;}</style></head><body><div id="chart"></div><script src="/charting_library/charting_library.js"></script><script src="/fixture.js"></script></body></html>'});
  if(u.pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:fixture});
  const file=path.resolve(library,u.pathname.replace(/^\/charting_library\//,''));
  if(!file.startsWith(path.resolve(library)+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:'Missing fixture asset'});
  return route.fulfill({path:file,...(file.endsWith('.js')?{contentType:'text/javascript'}:{})});
 });
 try {
  await page.goto('https://native-alert-shell.invalid/');
  await page.waitForFunction(()=>globalThis.ready);
  report.integration=await page.evaluate(async()=>{
   const api=await widget.widgetbar(),bar=api._widgetbar;
   if(!bar?.layout||!bar.widgetConfig?.alerts)throw new Error('v31 widgetbar contract mismatch');
   // Wait for original constructor registration before adding our renderer.
   bar.loadWidgets();await bar._configuration;
   globalThis.probeBar=bar;
   globalThis.probeLifecycle={constructed:0,destroyed:0};
   class AlertContent {
    constructor(props){
     probeLifecycle.constructed++;
     this.node=props.container.ownerDocument.createElement('div');
     this.node.dataset.name='mw-native-alert-probe';
     this.node.style.cssText='padding:16px;font:14px Arial;color:inherit';
     this.node.textContent='警报 / 日志 · 原生侧栏容器验证';
     props.container.appendChild(this.node);
    }
    destroy(){probeLifecycle.destroyed++;this.node.remove();}
   }
   bar.widgetConfig.alerts={...bar.widgetConfig.alerts,ctor:AlertContent};
   const original=bar.getLayoutState.bind(bar);
   bar.getLayoutState=()=>{const state=original();state.pages.splice(1,0,{name:'alerts',title:'警报',icon:'<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="15" r="9" fill="none" stroke="currentColor"/><path d="M14 9v6h4M4 5l4-3M20 2l4 3" fill="none" stroke="currentColor"/></svg>',widgets:[{type:'alerts'}]});return state;};
   bar.refreshFromTVSettings();bar.setPage('alerts');
   return {pages:bar.layout.pages.map(p=>p.name),nativeTabRenderer:bar.layout.tabRenderer.constructor.name};
  });
  const chart=page.frames().find(f=>f!==page.mainFrame());
  await chart.locator('[data-name="mw-native-alert-probe"]').waitFor({state:'visible'});
  const geometry=()=>page.evaluate(()=>({width:probeBar.resizerBridge.width.value(),page:probeBar.layout.getActivePage()?.name,minimized:probeBar.layout.minimized}));
  const first=await geometry();assert.equal(first.page,'alerts');
  report.cases.push('Custom content mounted in genuine widgetbar page alongside existing native pages');
  report.nativeTabs=await chart.locator('.widgetbar-tabs').innerText();
  await page.screenshot({path:path.join(output,'native-alert-sidebar-dark.png')});
  const handle=chart.locator('.widgetbar-handle');const box=await handle.boundingBox();assert.ok(box);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x-90,box.y+box.height/2,{steps:10});await page.mouse.up();
  await page.waitForFunction(old=>Math.abs(probeBar.resizerBridge.width.value()-old)>40,first.width);
  report.resize={before:first,after:await geometry()};
  report.cases.push('Real native drag handle changes sidebar width');
  await page.evaluate(async()=>{const api=await widget.widgetbar();api.showPage('object_tree');});
  assert.equal((await geometry()).page,'object_tree');
  await page.evaluate(()=>{probeBar.setPage('alerts');});
  await chart.locator('[data-name="mw-native-alert-probe"]').waitFor({state:'visible'});
  report.cases.push('Switch to existing object tree and back');
  await page.evaluate(()=>probeBar.layout.onTabClick(probeBar.layout.getActivePage()));
  assert.equal((await geometry()).minimized,true);
  await page.evaluate(()=>{probeBar.setPage('alerts');});
  assert.equal((await geometry()).minimized,false);
  report.cases.push('Native same-tab collapse and reopen');
  await page.evaluate(()=>widget.changeTheme('Light'));
  await page.screenshot({path:path.join(output,'native-alert-sidebar-light.png')});
  await page.evaluate(()=>widget.showNoticeDialog({title:'原生窗口验证',body:'原生标题、关闭和确认按钮；复杂表单组件尚未验证。',callback:()=>{}}));
  await chart.getByText('原生窗口验证',{exact:true}).waitFor({state:'visible'});
  await page.screenshot({path:path.join(output,'native-notice-shell.png')});
  report.cases.push('Public native notice dialog shell renders');
  await page.evaluate(()=>{widget.closePopupsAndDialogs();probeBar.refreshFromTVSettings();probeBar.setPage('alerts');});
  await chart.locator('[data-name="mw-native-alert-probe"]').waitFor({state:'visible'});
  report.lifecycle=await page.evaluate(()=>probeLifecycle);
  assert.ok(report.lifecycle.destroyed>=1);assert.ok(report.lifecycle.constructed>=2);
  assert.equal(await chart.locator('[data-name="mw-native-alert-probe"]').count(),1);
  report.cases.push('Native layout recreation destroys old renderer and mounts one new instance');
  assert.deepEqual(report.errors,[]);
  report.passed=true;
 }catch(e){report.passed=false;report.failure=String(e);await page.screenshot({path:path.join(output,'failure.png')});process.exitCode=1;}
 finally{fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
})();
