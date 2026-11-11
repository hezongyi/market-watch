// Built mobile entry and actual licensed widget, with explicit API test doubles.
// This is browser evidence, never backend/Find X8/ntfy acceptance.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const dist=path.resolve('dist'),id='a'.repeat(64),ticker='MWC:'+id;
const requests=[],errors=[],checks=[],consoleErrors=[];
let logged=false,shellRevision=0,brokenInstall=false;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')) {
   let text='';for await(const chunk of req)text+=chunk;
   const query=text?JSON.parse(text):{};requests.push({path:url.pathname,method:req.method});
   const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
   if(url.pathname==='/api/session')return logged?json({csrf:'test-csrf',subject:'admin'}):json({detail:'未登录'},401);
   if(url.pathname==='/api/login'){logged=true;return json({csrf:'test-csrf',subject:'admin'});}
   if(url.pathname==='/api/logout'){logged=false;return json({ok:true});}
   if(url.pathname==='/api/market-data/series/page')return json({items:[{ticker,symbol:'TEST-COMPOSITE',description:'受控浏览器测试组合',series_kind:'composite'}]});
   if(url.pathname==='/api/advanced-charts/catalog')return json({});
   if(url.pathname==='/api/charts/history-capabilities')return json({protocol:1,version:'test',mode:'continuous',max_bars:20000,workspace_bars:100000,default_bars:1000,task_seconds:30});
   if(url.pathname==='/api/market-data/resolve')return json({symbol:'TEST-COMPOSITE',source:'composite',precision:2,calendar:'utc0',asset_type:'CRYPTO',frames:['M1','M5','H1','D1'],created:true,stream:false});
   if(url.pathname==='/api/charts/data'){
     const step={M1:60000,M5:300000,H1:3600000,D1:86400000}[query.timeframe] || 3600000;
     const end=Math.floor(Math.min(query.before || Date.now(),Date.now())/step)*step;
     const bars=Array.from({length:Math.min(query.limit || 100,500)},(_,i)=>{
       const start=end-(Math.min(query.limit || 100,500)-i)*step;
       return {start,end:start+step,open:'100.00',high:'102.00',low:'99.00',close:String(100+i%3),complete:true,revision:1};
     });
     return json({bars,has_more:false,pending:[],revision_id:'b'.repeat(64),input_revision:1,as_of:Date.now()});
   }
   if(url.pathname==='/api/market-data/quotes')return json((query.symbols || []).map(n=>({n,s:'ok',v:{lp:101,ch:1,chp:1}})));
   if(url.pathname.startsWith('/api/charts/indicator-demands/'))return json({ok:true});
   if(url.pathname==='/api/charts/stream/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: heartbeat\ndata: {}\n\n');return;}
   if(url.pathname.startsWith('/api/charts/stream/'))return json({ok:true});
   return json({detail:'Unexpected test API '+url.pathname},404);
 }
 if(url.pathname==='/readyz'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({time:Date.now()}));}
 let file=path.join(dist,decodeURIComponent(url.pathname));
 if(url.pathname==='/m'){res.writeHead(308,{Location:'/m/'});return res.end();}
 if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
 if(!fs.existsSync(file)&&url.pathname.startsWith('/m/'))file=path.join(dist,'m/index.html');
 if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
 const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml'};
 res.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store'});
 let body=fs.readFileSync(file);
 if(url.pathname==='/m/sw.js'&&shellRevision){body=Buffer.from(body.toString().replace(/const CACHE='([^']+)'/,(_,name)=>`const CACHE='${name}-test-${shellRevision}'`).replace('const FILES=[',brokenInstall?"const FILES=['/missing-mobile-shell-resource.js',":'const FILES=['));}
 if(/^chart\.[a-f0-9]+\.js$/.test(path.basename(file)))body=Buffer.from(`const Original=TradingView.widget;TradingView.widget=function(...args){const widget=new Original(...args);globalThis.MW_TEST_WIDGET=widget;return widget;};\n`+body);
 res.end(body);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
 const context=await browser.newContext({viewport:{width:412,height:915},isMobile:true,hasTouch:true});
 const page=await context.newPage();page.on('console',msg=>{if(msg.type()==='error')consoleErrors.push(msg.text().slice(0,1800));});page.on('pageerror',error=>{errors.push(error.message);console.error('PAGE ERROR',error.message);});
 try {
   await page.goto(base+'/m/');await expect(page.getByLabel('密码',{exact:true})).toBeVisible();
   await page.getByLabel('密码',{exact:true}).fill('test-only');await page.getByRole('button',{name:'登录',exact:true}).click();
   await expect(page.getByRole('navigation',{name:'主导航'})).toBeVisible();
   assert.equal(await page.getByRole('navigation',{name:'主导航'}).getByRole('link').count(),5);checks.push('login and five mobile navigation entries');
   await page.getByRole('link',{name:'数据',exact:true}).click();
   await page.getByRole('button',{name:/TEST-COMPOSITE/}).click();
   await expect(page.getByRole('button',{name:'指标',exact:true})).toBeEnabled({timeout:30000});
   await expect.poll(()=>page.evaluate(()=>Boolean(window.MW_TEST_WIDGET?.activeChart().dataReady())),{timeout:30000}).toBe(true);
   assert.equal(await page.evaluate(()=>window.MW_TEST_WIDGET.chartsCount()),1);checks.push('actual pinned widget loads controlled composite through shared market runtime');
   for(const viewport of [{width:375,height:812},{width:412,height:915},{width:915,height:412}]) {
     await page.setViewportSize(viewport);await page.evaluate(()=>document.documentElement.style.fontSize='150%');
     assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile chart must not overflow at 150% text');
   }
   await page.setViewportSize({width:412,height:915});await page.evaluate(()=>document.documentElement.style.fontSize='100%');
   await page.screenshot({path:process.env.MW_MOBILE_SCREENSHOT || '/tmp/mw-android-personal-v205-chart.png'});
   checks.push('375/412 widths and landscape at 150% text without horizontal overflow');
   const registered=await page.evaluate(()=>window.MW_TEST_WIDGET.getStudiesList().length);assert.ok(registered>50);checks.push('actual registered studies: '+registered);
   await page.getByRole('button',{name:'指标',exact:true}).click();
   await expect.poll(()=>page.frames().some(frame=>frame.url().startsWith('blob:'))).toBe(true);
   const frame=page.frames().find(frame=>frame.url().startsWith('blob:'));
   await expect(frame.getByRole('dialog').first()).toBeVisible({timeout:30000});
   assert.equal(await frame.locator('.mw-indicator-fallback').count(),0,'mobile must open the real native indicator UI');
   await page.evaluate(()=>window.dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));
   await expect(frame.getByRole('dialog').first()).toBeHidden();
   await expect(page).toHaveURL(/\/m\/chart$/);
   const study=await page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().createStudy('Relative Strength Index',false,false,{length:9}));
   assert.ok(study);await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().getPanes().length)).toBeGreaterThan(1);
   await page.evaluate(id=>window.MW_TEST_WIDGET.activeChart().showPropertiesDialog(id),study);
   const parameters=frame.locator('[data-name="indicator-properties-dialog"]');await expect(parameters).toBeVisible();
   const number=parameters.locator('input').first();await number.fill('14');
   page.once('dialog',dialog=>dialog.dismiss());
   await page.getByRole('link',{name:'更多',exact:true}).click();
   await expect(page).toHaveURL(/\/m\/chart$/);await expect(number).toHaveValue('14');
   await parameters.getByRole('button',{name:'取消',exact:true}).click();
   await expect.poll(()=>page.evaluate(id=>window.MW_TEST_WIDGET.activeChart().getStudyById(id).getInputValues().find(v=>v.id==='length').value,study)).toBe(9);
   checks.push('back closes top native dialog; declining parameter discard keeps input; cancel retains applied value');

   await page.getByRole('button',{name:'十字线',exact:true}).click();
   await expect(page.getByRole('button',{name:'十字线',exact:true})).toHaveAttribute('aria-pressed','true');
   checks.push('native indicator dialog, RSI subpane and touch tracking crosshair');
   await page.getByLabel('图表周期').selectOption('5');
   await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().resolution())).toBe('5');
   await expect.poll(()=>page.evaluate(async()=>{
     const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('mw-mobile',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
     return new Promise(resolve=>{const r=db.transaction('records').objectStore('records').get([location.origin,'admin',1,'chart']);r.onsuccess=()=>{db.close();resolve(r.result?.value?.state?.charts?.length || 0);};});
   }),{timeout:10000}).toBe(1);
   for(let i=0;i<20;i++){await page.getByRole('link',{name:'更多',exact:true}).click();await page.getByRole('link',{name:'图表',exact:true}).click();}
   assert.equal(await page.locator('.mobile-chart-canvas iframe').count(),1);checks.push('20 navigation switches retain one widget');
   await page.reload();await expect(page.getByRole('button',{name:'指标',exact:true})).toBeEnabled({timeout:30000});
   await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().getAllStudies().length)).toBe(1);
   assert.equal(await page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().getStudyById(window.MW_TEST_WIDGET.activeChart().getAllStudies()[0].id).getInputValues().find(v=>v.id==='length').value),9);
   checks.push('real native layout and RSI parameter restore from IDB');
   await page.evaluate(()=>navigator.serviceWorker.ready);
   await page.getByRole('link',{name:'数据',exact:true}).click();
   await context.setOffline(true);await page.reload();
   await expect(page.getByRole('button',{name:/TEST-COMPOSITE/})).toBeVisible({timeout:15000});checks.push('SW offline cold navigation displays last IDB series snapshot');
   await context.setOffline(false);await page.reload();
   await expect(page.getByRole('button',{name:/TEST-COMPOSITE/})).toBeVisible();
   await page.evaluate(()=>window.dispatchEvent(new Event('mw-session-expired')));
   await expect(page.getByLabel('密码',{exact:true})).toBeVisible();assert.equal(await page.locator('.mobile-chart-canvas iframe').count(),0);checks.push('explicit session expiry disposes widget and prompts login');
   await page.getByLabel('密码',{exact:true}).fill('unsent-input');shellRevision=1;
   await page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration('/m/');await registration.update();});
   await expect(page.getByRole('button',{name:'更新页面',exact:true})).toBeVisible();
   await page.getByRole('button',{name:'更新页面',exact:true}).click();
   await expect(page.getByLabel('密码',{exact:true})).toHaveValue('unsent-input');
   await expect(page.getByRole('alert')).toContainText('请先完成或放弃');
   await page.getByRole('button',{name:'关闭通知',exact:true}).click();await page.getByLabel('密码',{exact:true}).fill('');
   await page.getByRole('button',{name:'更新页面',exact:true}).click();
   await expect(page.getByRole('navigation',{name:'主导航'})).toBeVisible();
   await expect.poll(()=>page.evaluate(async()=>(await caches.keys()).some(key=>key.endsWith('-test-1')))).toBe(true);
   shellRevision=2;brokenInstall=true;
   await page.evaluate(async()=>{
     const registration=await navigator.serviceWorker.getRegistration('/m/');
     await new Promise(async resolve=>{registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker.addEventListener('statechange',()=>{if(worker.state==='redundant')resolve();});},{once:true});await registration.update();});
   });
   assert.ok(await page.evaluate(async()=>(await caches.keys()).some(key=>key.endsWith('-test-1'))));
   assert.equal(await page.evaluate(async()=>(await caches.keys()).some(key=>key.endsWith('-test-2'))),false);
   checks.push('shell update preserves unsubmitted input; explicit safe update works; incomplete install retains previous shell');
   await page.getByRole('link',{name:'更多',exact:true}).click();await context.setOffline(true);
   await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page.getByLabel('密码',{exact:true})).toBeVisible();
   await context.setOffline(false);await page.reload();await expect(page.getByLabel('密码',{exact:true})).toBeVisible();
   checks.push('offline logout clears cached profile and prevents automatic reuse of an unrevoked server cookie');
   const forbidden=requests.filter(row=>row.method==='POST'&&/advanced-charts\/(preferences|workspaces|native-charts)/.test(row.path));
   assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);
   console.log(JSON.stringify({evidence:'browser with API test doubles; actual licensed widget; no device/backend acceptance',checks,errors,forbiddenWrites:forbidden},null,2));
 } catch(error) {console.error('MOBILE FAILURE EVIDENCE',JSON.stringify({body:await page.locator('body').innerText(),consoleErrors,requests}));throw error;} finally {await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
