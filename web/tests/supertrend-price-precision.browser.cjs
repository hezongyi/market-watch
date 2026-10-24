// Actual native legend labels must use the same formatter as the chart.
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process');
const {readOnlyAcceptance}=require('./helpers/readOnlyAcceptance.cjs');
const root=path.resolve(__dirname,'../..'),out=process.env.MW_TEST_ARTIFACT_DIR||path.join(root,'artifacts/supertrend-precision');
fs.mkdirSync(out,{recursive:true});
const fixture=JSON.parse(execFileSync(path.join(root,'.venv/bin/python'),[path.join(__dirname,'fixtures/supertrend-precision-feed.py')],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'backend')}}));
const name='守望 Python SUPERTREND_PINE_V1';
const report={passed:false,cases:[],samples:[],errors:[]};
function html(baseline){return `<!doctype html><html><body style="margin:0"><div id="chart" style="height:100vh"></div>
<script src="/advanced-host/charting_library/charting_library.js"></script>
<script>${baseline?execFileSync('git',['show','13dda972:advanced-host/indicators.js'],{cwd:root}):fs.readFileSync(path.join(root,'advanced-host/indicators.js'))}</script>
<script>
const fixture=${JSON.stringify(fixture)},q=new URLSearchParams(location.search);
const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['240']}),0),
 resolveSymbol:(s,cb)=>setTimeout(()=>cb({name:s,ticker:s,description:s,type:'forex',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:10**(s.includes('THREE')?3:s.includes('TWO')?2:5),has_intraday:true,supported_resolutions:['240'],format:'price'}),0),
 getBars:(s,r,p,cb)=>{const key=s.ticker.startsWith('MWPY_')?JSON.parse(atob(s.ticker.slice(5))).key:null;
 const values=key?fixture.result.series.find(v=>v.key===key).values:null;
 const bars=fixture.bars.map((b,i)=>{const v=values?.[i];return key?{time:b.start,open:v.value??0,high:v.value??0,low:v.value??0,close:v.value??0,volume:v.value==null?0:v.break_before?2:1}:{time:b.start,...b,volume:1}}).filter(b=>b.time<p.to*1000).slice(-p.countBack);
 setTimeout(()=>cb(bars,{noData:!bars.length}),0)},subscribeBars(){},unsubscribeBars(){}};
let ready=false;
const widget=new TradingView.widget({container:'chart',library_path:'/advanced-host/charting_library/',symbol:'EURUSD',interval:'240',autosize:true,theme:'Dark',locale:'zh',datafeed:feed,
 disabled_features:['use_localstorage_for_settings','create_volume_indicator_by_default'],enabled_features:['study_templates','support_multicharts'],
 save_load_adapter:{getAllStudyTemplates:async()=>[],getStudyTemplateContent:async()=>'',saveStudyTemplate:async()=>{},removeStudyTemplate:async()=>{}},
 custom_formatters:{priceFormatterFactory:(s,t)=>q.has('custom')&&t==='default'?{format:v=>'FX '+Number(v).toFixed(5)}:null},
 custom_indicators_getter:p=>Promise.resolve(pythonStudies(p,fixture.catalog))});
widget.onChartReady(async()=>{await widget.activeChart().createStudy('${name}',false,false);ready=true});
</script></body></html>`;}
(async()=>{
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname==='/fixture'){res.setHeader('Content-Type','text/html');return res.end(html(url.searchParams.has('baseline')))}
  const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'application/octet-stream');
  fs.createReadStream(file).on('error',()=>{res.writeHead(404);res.end()}).pipe(res);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({args:['--no-sandbox']});
 const open=async(query='')=>{const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>report.errors.push(e.message));await page.goto(origin+'/fixture?'+query);await page.waitForFunction(()=>ready&&widget.activeChart().dataReady());return page};
 const inspect=async(page)=>page.evaluate(()=>{
  const c=widget.activeChart(),id=c.getAllStudies()[0].id,doc=document.querySelector('iframe').contentDocument;
  const raw=Object.fromEntries(fixture.result.series.map(s=>[s.key,s.values.at(-1).value]));
  return {symbol:c.symbol(),labels:Array.from(doc.querySelectorAll('[data-entity-id="'+id+'"] [data-test-id-value-title]')).filter(n=>n.getClientRects().length&&['Up Trend','Down Trend'].includes(n.dataset.testIdValueTitle)).map(n=>{const key=n.dataset.testIdValueTitle==='Up Trend'?'up':'down';return {plot:key,text:n.textContent,expected:raw[key]==null?'∅':c.priceFormatter().format(raw[key])}}),styles:c.getStudyById(id).getStyleValues(),inputs:c.getStudyById(id).getInputValues()};
 });
 const check=async(page,label)=>{
  await page.mouse.move(1435,5);
  await expect.poll(async()=>{const s=await inspect(page);return s.labels.length===2&&s.labels.every(v=>v.text===v.expected)},{timeout:10000,message:label+' native labels follow chart formatter'}).toBe(true);
  report.samples.push({label,...await inspect(page)});report.cases.push(label);console.log('PASS',label);
 };
 try{
  let page=await open('baseline');
  await expect.poll(async()=>{const s=await inspect(page);return s.labels.some(v=>/\d/.test(v.text))}).toBe(true);
  report.legacy=await inspect(page);
  const legacy=await page.evaluate(async()=>{const c=widget.activeChart(),s=c.getStudyById(c.getAllStudies()[0].id);s.setInputValues([{id:'showsignals',value:false}]);s.applyOverrides({'Up Trend.color':'#123456','Down Trend.linewidth':4});return {workspace:await new Promise(r=>widget.save(r)),template:c.createStudyTemplate({saveSymbol:false,saveInterval:false})}});
  await page.close();
  page=await open();await check(page,'EURUSD five decimals');
  await page.screenshot({path:path.join(out,'eurusd-five-decimals.png')});
  for(const symbol of ['FX_THREE','FX_TWO','EURUSD']){await page.evaluate(s=>new Promise(r=>widget.activeChart().setSymbol(s,r)),symbol);await check(page,'switch '+symbol)}
  for(const tick of ['1000,1,false','100000,1,false','default']){await page.evaluate(t=>widget.activeChart().applyOverrides({'mainSeriesProperties.minTick':t}),tick);await check(page,'chart precision '+tick)}
  for(const [kind,value] of Object.entries(legacy)){
   await page.evaluate(({kind,value})=>kind==='workspace'?widget.load(value):widget.activeChart().applyStudyTemplate(value),{kind,value});
   await expect.poll(async()=>(await inspect(page)).styles.styles.up.color).toBe('#123456');
   await check(page,'legacy '+kind+' restore');const s=await inspect(page);assert.equal(s.styles.styles.up.color,'#123456');assert.equal(s.styles.styles.down.linewidth,4);assert.equal(s.inputs.find(i=>i.id==='showsignals').value,false);
  }
  const saved=await page.evaluate(()=>new Promise(r=>widget.save(r)));await page.evaluate(s=>widget.load(s),saved);await check(page,'second save and reload');
  await page.close();page=await open('custom');await check(page,'custom main formatter');await page.close();
  if(process.env.MW_TEST_BASE_URL){
   const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}});await readOnlyAcceptance(context,report);
   const app=await context.newPage();app.on('pageerror',e=>report.errors.push(e.message));
   await app.goto(process.env.MW_TEST_BASE_URL+'/advanced-charts/mw75-real');
   await app.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(process.env.MW_TEST_CREDENTIALS_FILE)).login_password);await app.locator('button.auth-submit').click();
   await expect.poll(()=>app.frames().some(f=>f.url().startsWith(process.env.MW_TEST_CHART_URL)&&f.url().includes('/?')),{timeout:90000}).toBe(true);
   const host=app.frames().find(f=>f.url().startsWith(process.env.MW_TEST_CHART_URL)&&f.url().includes('/?'));
   await host.waitForFunction(()=>{try{return widget.activeChart().dataReady()}catch{return false}},null,{timeout:120000});
   assert.equal(await(await app.request.get(process.env.MW_TEST_CHART_URL+'/indicators.js')).text(),fs.readFileSync(path.join(root,'advanced-host/indicators.js'),'utf8'));
   await host.evaluate(async()=>{const c=widget.activeChart();c.removeAllStudies();await new Promise(r=>c.setSymbol('MWP:EURUSD',r));await c.createStudy('守望 Python SUPERTREND_PINE_V1',false,false)});
   const live=async()=>host.evaluate(()=>{const c=widget.activeChart(),doc=document.querySelector('iframe').contentDocument,id=c.getAllStudies()[0].id;return {symbol:c.symbol(),labels:Array.from(doc.querySelectorAll('[data-entity-id="'+id+'"] [data-test-id-value-title]')).filter(n=>n.getClientRects().length&&['Up Trend','Down Trend'].includes(n.dataset.testIdValueTitle)).map(n=>n.textContent),chartSample:c.priceFormatter().format(1.12345678)}});
   await expect.poll(async()=>{const s=await live();return s.labels.some(t=>/^1\.\d{5}$/.test(t))},{timeout:120000}).toBe(true);
   report.application=await live();await app.screenshot({path:path.join(out,'mwa-eurusd-supertrend.png')});report.cases.push('mwa actual EURUSD five decimal labels and exact candidate');await context.close();
  }
  assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(e){report.failure=e.stack;report.diagnostic=await Promise.all(browser.contexts().flatMap(c=>c.pages()).map(p=>p.evaluate(()=>({text:document.querySelector('iframe')?.contentDocument?.body.innerText.slice(0,1500),labels:Array.from(document.querySelector('iframe')?.contentDocument?.querySelectorAll('[data-test-id-value-title]')||[]).map(n=>({plot:n.dataset.testIdValueTitle,text:n.textContent}))})).catch(()=>null)));throw e}
 finally{fs.writeFileSync(path.join(out,'supertrend-price-precision.json'),JSON.stringify(report,null,2));await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
