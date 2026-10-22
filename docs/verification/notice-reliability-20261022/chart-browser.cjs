const fs=require('fs'),assert=require('assert/strict');
const {chromium,expect}=require('/home/quant/repos/market-watch/web/node_modules/@playwright/test');
const base='https://192.168.7.232:18280',origin='https://192.168.7.232:18281',workspace='7d72eead-6be5-41a4-b3d5-bfdfff98b2bb';
const report={blockedWrites:[],blockedNoticeWrites:[],started:new Date().toISOString(),checks:[],errors:[],responses:[]};
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});const context=await browser.newContext({ignoreHTTPSErrors:true});const page=await context.newPage();
let host;
const pending=new Set();page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(!r.url().includes('/api/charts/data'))return;const p=(async()=>{try{const q=r.request().postDataJSON();if(!q.indicators?.length)return;const d=await r.json();report.responses.push({at:Date.now(),query:q,status:r.status(),snapshot:d.display_snapshot_id,revision:d.input_revision,progress:d.indicator_progress,error:d.detail,indicators:d.indicators?.map(i=>({name:i.name,params:i.params,calculation:i.calculation,presentation:i.name==='SWING_SR_V1'?i.presentation:undefined,plots:i.series?.map(s=>({key:s.key,rows:s.values?.length,finite:s.values?.filter(p=>Number.isFinite(p.value)).length}))}))});}catch{}})();pending.add(p);p.finally(()=>pending.delete(p));});
await require(process.cwd()+'/web/tests/helpers/readOnlyAcceptance.cjs').readOnlyAcceptance(context,report);
const get=async path=>{const r=await context.request.get(base+path);assert.equal(r.status(),200,path);return r.json();};
const connect=async()=>{await expect.poll(()=>page.frames().some(f=>f.url().startsWith(origin+'/')),{timeout:90000}).toBe(true);host=page.frames().find(f=>f.url().startsWith(origin+'/'));await host.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget?.activeChart(),null,{timeout:90000});};
const wait=async()=>{await expect.poll(()=>host.evaluate(()=>widget.activeChart().dataReady()),{timeout:90000}).toBe(true);};
const sample=async ids=>host.evaluate(ids=>{const c=widget.activeChart();return {symbol:c.symbol(),resolution:c.resolution(),range:c.getVisibleRange(),cards:[...document.querySelectorAll('.mw-swing-row')].map(e=>e.textContent),studies:ids.map(({id,name})=>{const s=c._chartWidget.model().model().dataSourceForId(id),rows=[];s?.data()?.each((i,r)=>{rows.push(r);});return {id,name,rows:rows.length,finite:rows.filter(r=>r.slice(1).some(Number.isFinite)).length,last:rows.at(-1)};})};},ids);
const run=async(ticker,res)=>{
 console.log('START',ticker,res);const start=Date.now(),responseStart=report.responses.length;
 await host.evaluate(t=>{const c=widget.activeChart();for(const s of c.getAllStudies())c.removeEntity(s.id);if(!MWSeries.same(c.symbol(),t))c.setSymbol(t);},ticker);
 await expect.poll(()=>host.evaluate(t=>MWSeries.same(widget.activeChart().symbol(),t)&&widget.activeChart().dataReady(),ticker),{timeout:90000}).toBe(true);
 await host.evaluate(r=>{if(widget.activeChart().resolution()!==r)widget.activeChart().setResolution(r);},res);await expect.poll(()=>host.evaluate(r=>widget.activeChart().resolution()===r&&widget.activeChart().dataReady(),res),{timeout:90000}).toBe(true);
 const ids=[];for(const name of ['SWING_SR_V1','EMA','RSI'])ids.push({name,id:await host.evaluate(n=>widget.activeChart().createStudy('守望 Python '+n,false,false,{}),name)});
 await expect.poll(async()=>{const s=await sample(ids);return s.studies.every(x=>x.rows>0);},{timeout:150000,intervals:[1000,2000,3000]}).toBe(true);
 await page.waitForTimeout(2000);
 const s=await sample(ids);
 await expect(page.locator('[aria-label="图格指标状态"]')).toHaveCount(0);
 assert.ok(s.studies.every(x=>x.finite>0),'all three studies need actual plot values');
 const result={ticker,res,ms:Date.now()-start,...s,statusWindowAbsent:true};
 report.checks.push(result);console.log(JSON.stringify({ticker,res,ms:result.ms,finite:s.studies.map(x=>x.finite)}));
 return ids;
};
try{
 await page.setViewportSize({width:1440,height:900});
 await page.goto(base+'/advanced-charts/'+workspace,{timeout:90000});
 await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('/home/quant/repos/.mwa-composite-mapping-20261021/browser-login.json')).password);
 await page.locator('button.auth-submit').click();await connect();await host.evaluate(()=>autoSave?.dispose());
 const before=await get('/api/advanced-charts/workspaces/'+workspace);
 await run('MWH:63bc01d4-3943-45cc-93a5-b04c3caaab16','1D');
 const ids=await run('MWC:8c490df00408ed7102d9106e2ad6d3991d3e6488de0b0905d92a2ec052343cbb','1D');
 report.layouts=[];
 for(const theme of ['Light','Dark']){
  await host.evaluate(async({theme,parentOrigin})=>{await widget.changeTheme(theme,{disableUndo:true});window.parent.postMessage({type:'theme-changed',theme},parentOrigin);},{theme,parentOrigin:base});
  await expect(page.locator('.advanced-workspace')).toHaveAttribute('data-theme',theme.toLowerCase());
  for(const width of [1440,390,375]){
   await page.setViewportSize({width,height:900});await page.waitForTimeout(200);
   await expect(page.locator('[aria-label="图格指标状态"]')).toHaveCount(0);
   report.layouts.push({theme,width,statusWindowAbsent:true});
   if(width===1440||width===390)await page.screenshot({path:'/tmp/mwa-notice-reliability-20261022/'+theme.toLowerCase()+'-'+width+'.png'});
  }
 }
 await page.setViewportSize({width:1440,height:900});
 await connect();await wait();console.log('CHECK layouts complete');
 const native=host.childFrames()[0];
 await native.getByRole('button',{name:'图表菜单',exact:true}).click();
 await native.getByRole('button',{name:'历史加载详情',exact:true}).click();
 const detail=page.getByRole('dialog',{name:'历史加载详情'});await expect(detail).toBeVisible();
 report.historyDetailsText=await detail.innerText();assert.ok(report.historyDetailsText.trim().length>10);
 await page.getByRole('button',{name:'关闭历史加载详情',exact:true}).click();
 console.log('CHECK history details complete');
 const layout=await host.evaluate(()=>Promise.race([new Promise(resolve=>widget.save(resolve)),new Promise((_,reject)=>setTimeout(()=>reject(Error('Native layout snapshot timed out')),20000))]));console.log('CHECK layout saved');
 await page.reload({timeout:90000});await connect();await host.evaluate(()=>autoSave?.dispose());await wait();
 console.log('CHECK reloaded');await host.evaluate(s=>widget.load(s),layout);
 await expect.poll(async()=>{const sample=await host.evaluate(()=>{const c=widget.activeChart();return c.getAllStudies().every(x=>{let n=0;c._chartWidget.model().model().dataSourceForId(x.id)?.data()?.each((i,r)=>{if(r.slice(1).some(Number.isFinite))n++;});return n>0;})&&c.getAllStudies().length===3;});return sample;},{timeout:90000}).toBe(true);
 await expect(page.locator('[aria-label="图格指标状态"]')).toHaveCount(0);
 report.reloadPassed=true;
 const after=await get('/api/advanced-charts/workspaces/'+workspace);report.workspaceCheck={beforeRevision:before.revision,afterRevision:after.revision,changed:Object.keys(before).filter(k=>JSON.stringify(before[k])!==JSON.stringify(after[k]))};report.workspaceUnchanged=JSON.stringify(before)===JSON.stringify(after);report.externalWorkspaceChange=!report.workspaceUnchanged;
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(e){report.failure=e.stack;process.exitCode=1;await page.screenshot({path:'/tmp/mwa-notice-reliability-20261022/failure.png'}).catch(()=>{});}
finally{await Promise.race([Promise.allSettled([...pending]),new Promise(r=>setTimeout(r,5000))]);
 const result={started:report.started,checks:report.checks,layouts:report.layouts,historyDetailsText:report.historyDetailsText,reloadPassed:report.reloadPassed,workspaceUnchanged:report.workspaceUnchanged,workspaceCheck:report.workspaceCheck,blockedWrites:report.blockedWrites,blockedNoticeWrites:report.blockedNoticeWrites,errors:report.errors,passed:report.passed,failure:report.failure,httpErrors:report.responses.filter(r=>r.status>=400).map(r=>({status:r.status,error:r.error}))};
 fs.writeFileSync('/tmp/mwa-notice-reliability-20261022/chart-browser.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify({passed:report.passed,failure:report.failure,errors:report.errors}));await browser.close();}})();
