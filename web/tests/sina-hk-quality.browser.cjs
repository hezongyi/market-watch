// Real legacy Sina HK chart/quality notice acceptance; no intercepted market data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {chromium,expect}=require('@playwright/test');
const base=process.env.MW_BASE_URL,output=process.env.MW_OUTPUT;
assert(base && output && process.env.MW_ACCEPTANCE_CREDENTIALS_FILE);
const config=JSON.parse(fs.readFileSync(process.env.MW_ACCEPTANCE_CREDENTIALS_FILE));
const cert=new crypto.X509Certificate(fs.readFileSync(config.tls_cert_file || config.ca_file));
const spki=crypto.createHash('sha256').update(cert.publicKey.export({format:'der',type:'spki'})).digest('base64');
fs.mkdirSync(output,{recursive:true});
const report={passed:false,errors:[]};
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args:['--no-sandbox','--ignore-certificate-errors-spki-list='+spki]});
 const context=await browser.newContext({viewport:{width:1600,height:1000}});
 await context.addInitScript(()=>document.addEventListener('load',event=>{
  if(!event.target?.src?.endsWith('/charting_library.js') || !window.TradingView?.widget)return;
  const ctor=TradingView.widget;
  TradingView.widget=new Proxy(ctor,{construct(target,args,newTarget){
   const feed=args[0].datafeed,getBars=feed.getBars.bind(feed);
   window.__hkDelivered={};
   feed.getBars=(info,resolution,parameters,onResult,onError)=>getBars(info,resolution,parameters,(bars,meta)=>{
    if(bars.length)window.__hkDelivered[info.ticker.toUpperCase()+'|'+resolution]={rows:bars.length,first:bars[0],last:bars.at(-1)};
    onResult(bars,meta);
   },onError);
   const widget=Reflect.construct(target,args,newTarget);window.__hkWidget=widget;return widget;
  }});
 },true));
 const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
 try {
  await page.goto(base+'/login');
  const workspace=await page.evaluate(async ({password,workspaceId})=>{
   const login=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
   if(!login.ok)throw Error('login failed');const {csrf}=await login.json();
   if(workspaceId)return {id:workspaceId};
   const response=await fetch('/api/advanced-charts/workspaces',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
    body:JSON.stringify({name:'新浪港股异常隔离验收',symbol:'MWP:AKSHARE:430fea2075d156a988cc93abda28cb5e'})});
   if(!response.ok)throw Error('create acceptance workspace failed');return response.json();
  },{password:config.login_password,workspaceId:process.env.MW_WORKSPACE_ID});
  report.workspace=workspace.id;
  const directory='/market-data?tab=platform&source=akshare&query=00700';
  await page.goto(base+'/advanced-charts/'+workspace.id+'?data_center='+encodeURIComponent(directory));
  await expect.poll(()=>page.frames().some(f=>f.url().startsWith('blob:')),{timeout:90000}).toBe(true);
  const frame=page.frames().find(f=>f.url().startsWith('blob:'));
  const row='platform-akshare-430fea2075d156a988cc93abda28cb5e';
  await frame.locator('[id="'+row+'-details"]').click({timeout:90000});
  await expect(frame.locator('.dc-window')).toContainText('图表排除异常记录并保留审计，不补价');
  await expect(frame.locator('.dc-window')).toContainText('前复权');
  await frame.locator('.dc-window').screenshot({path:path.join(output,'00700-quality-notice.png')});
  report.quality_notice=true;
  await frame.getByRole('button',{name:'关闭详情',exact:true}).click();
  await frame.locator('[id="'+row+'-open"]').click();
  const ready=async()=>{
   await page.waitForFunction(()=>{
    try{const chart=window.__hkWidget?.activeChart(),range=chart?.getVisibleRange();
     return chart?.symbol().toUpperCase()==='MWP:AKSHARE:430FEA2075D156A988CC93ABDA28CB5E' &&
      chart.resolution()==='1D' && chart.dataReady() && range?.to>range?.from &&
      window.__hkDelivered[chart.symbol().toUpperCase()+'|1D']?.rows>1;
    }catch{return false;}
   },{}, {timeout:120000});
  };
  await ready();
  report.chart=await page.evaluate(()=>{const chart=window.__hkWidget.activeChart();return {
   symbol:chart.symbol(),resolution:chart.resolution(),ready:chart.dataReady(),range:chart.getVisibleRange(),
   delivered:window.__hkDelivered[chart.symbol().toUpperCase()+'|1D']};});
  await page.screenshot({path:path.join(output,'00700-chart.png'),clip:{x:50,y:40,width:1180,height:915}});
  await page.reload();await ready();report.restored=true;
  assert.deepEqual(report.errors,[]);report.passed=true;
 } catch(error){report.errors.push(error.message);report.diagnostic=await page.evaluate(()=>{try{const c=window.__hkWidget?.activeChart();return {symbol:c?.symbol(),resolution:c?.resolution(),ready:c?.dataReady(),range:c?.getVisibleRange(),delivered_keys:Object.keys(window.__hkDelivered||{})};}catch{return null;}}).catch(()=>null);await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}
 finally{
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  await context.close();await browser.close();console.log(JSON.stringify(report));
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
