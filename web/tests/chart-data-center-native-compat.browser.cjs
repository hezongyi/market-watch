const fs=require('fs'),path=require('path'),{expect}=require('@playwright/test'),f=require('./chart-data-center-fixture.cjs');
const out=path.join(f.root,'artifacts/native-ui-implementation'),report={environment:'Ubuntu isolated Docker; actual licensed native dialogs',passed:false,checks:[],errors:[]};
(async()=>{const b=await f.launch(),p=await b.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});const {host,native}=f.frames(p),dc=()=>native().locator('.dc-window');
 p.on('pageerror',e=>{report.errors.push(e.message);console.log('PAGEERROR',e.message)});const record=name=>{report.checks.push({name});console.log('PASS',name)};
 const open=async route=>{await host().evaluate(route=>dataCenter.open(route),route);await expect(dc()).toBeVisible({timeout:20000})};
 const close=async()=>{await native().getByRole('button',{name:'关闭数据中心',exact:true}).click();await expect(dc()).toHaveCount(0)};
 try{
  if(process.env.LOCAL)await f.localNativeAssets(p);
  await p.goto(f.base+'/advanced-charts');await f.login(p);await expect.poll(()=>!!native(),{timeout:30000}).toBeTruthy();await host().waitForFunction(()=>ready,null,{timeout:60000});
  await open('/market-data?tab=platform&source=yahoo&query=');await expect(dc().locator('tbody tr').first()).toBeVisible();await close();
  // Hold host acceptance inside a test-only wrapper around the mount options.
  await native().evaluate(()=>{const original=MWNativeCenter.mount;window.centerHeld=[];window.centerAccept=null;MWNativeCenter.mount=(node,options)=>{const post=options.post;window.centerAccept=post;return original(node,{...options,post:m=>{if(m.type==='apply')centerHeld.push(m);else post(m);}});};});
  await open('/market-data?tab=platform&source=yahoo&query=');const buttons=dc().getByRole('button',{name:'打开平台图表',exact:true});await expect.poll(()=>buttons.count()).toBeGreaterThan(1);const count=await buttons.count();await buttons.first().click();
  await expect(dc().getByRole('button',{name:'正在打开…',exact:true})).toHaveCount(1);expect(await buttons.count()).toBe(count-1);await buttons.first().evaluate(n=>{n.click();n.click();});expect(await native().evaluate(()=>centerHeld.length)).toBe(1);
  // Reject the held request to inspect recovery without any chart load.
  await native().evaluate(()=>{const q=centerHeld[0];centerAccept({...q,target:'invalid-target'});});await expect(dc().locator('.dc-window-content > [role=alert]')).toContainText('目标图格');await expect(dc().getByRole('button',{name:'正在打开…',exact:true})).toHaveCount(0);await close();
  record('only selected row shows loading; double clicks are ignored; rejected acceptance restores row state');
  await p.reload();await expect.poll(()=>!!native(),{timeout:30000}).toBeTruthy();await host().waitForFunction(()=>ready,null,{timeout:60000});
  await open('/market-data?tab=platform&source=binance&query=BTC');await expect(dc().getByRole('searchbox',{name:'搜索品种',exact:true})).toBeVisible();
  await dc().getByRole('searchbox',{name:'搜索品种',exact:true}).focus();await p.keyboard.type('中文');expect(await dc().getByRole('searchbox',{name:'搜索品种',exact:true}).inputValue()).toContain('中文');
  for(const key of ['Tab','Shift+Tab'])for(let i=0;i<18;i++){await p.keyboard.press(key);const focused=await native().evaluate(()=>({inside:!!document.activeElement.closest('[data-name="mw-data-center-dialog"]'),html:document.activeElement.tagName+" "+document.activeElement.getAttribute("aria-label")}));expect(focused.inside,focused.html).toBe(true);}
  await dc().getByRole('button',{name:'来源',exact:true}).click();await expect(native().getByRole('listbox')).toBeVisible();await p.keyboard.press('Escape');await expect(native().getByRole('listbox')).toHaveCount(0);await expect(dc()).toBeVisible();await close();
  record('Tab/Shift+Tab stay in modal; native filter Escape closes menu only; Chinese text does not reach chart shortcuts');
  const initial=await host().evaluate(()=>new Promise(resolve=>widget.save(resolve)));
  for(const action of ['chartProperties','compareOrAdd','insertIndicator']){
   await host().evaluate(action=>widget.activeChart().executeActionById(action),action);
   await expect(native().locator('[role=dialog]')).toBeVisible({timeout:10000});await p.screenshot({path:path.join(out,`native-regression-${action}.png`)});
   const dialog=native().locator('[role=dialog]');await dialog.getByRole('button',{name:/关闭|取消/}).first().click();await expect(native().locator('[role=dialog]')).toHaveCount(0);
  }
  const after=await host().evaluate(()=>new Promise(resolve=>widget.save(resolve)));expect(after.charts.map(r=>r.chartProperties)).toEqual(initial.charts.map(r=>r.chartProperties));
  record('real chart settings cancel, compare and indicator dialogs still open/close without chart-property mutation');
  // Version mismatch must produce a working compatibility UI, not a half shell.
  await p.reload();await expect.poll(()=>!!native(),{timeout:30000}).toBeTruthy();await expect(native().getByRole('button',{name:'数据中心',exact:true})).toBeVisible({timeout:20000});
  await host().evaluate(()=>{window.realVersion=TradingView.version;TradingView.version=()=>"incompatible-test-version";});await native().getByRole('button',{name:'数据中心',exact:true}).click();
  const fallback=()=>p.frames().find(fr=>fr.url().includes('/chart-data-center?'));await expect.poll(()=>!!fallback(),{timeout:20000}).toBeTruthy();await expect(fallback().getByRole('heading',{name:'自建行情',exact:true})).toBeVisible();
  await fallback().getByRole('button',{name:'平台品种',exact:true}).click();await expect(fallback().getByRole('heading',{name:'平台品种',exact:true})).toBeVisible();await fallback().getByRole('button',{name:'关闭数据中心'}).click();await expect.poll(()=>!!fallback()).toBe(false);
  await host().evaluate(()=>{TradingView.version=realVersion;});await open('/market-data?tab=sources');await expect(dc().getByRole('heading',{name:'来源与能力'})).toBeVisible();await expect(dc().getByRole('alert')).toHaveCount(0);await close();
  record('version mismatch cleans up and opens functional compatibility window; corrected version retries native path');
  await p.reload();await expect.poll(()=>!!native(),{timeout:30000}).toBeTruthy();await expect(native().getByRole('button',{name:'数据中心',exact:true})).toBeVisible({timeout:20000});
  const missing=r=>r.abort();await p.route('**/data-center-native.css',missing);await native().getByRole('button',{name:'数据中心',exact:true}).click();await expect.poll(()=>!!fallback(),{timeout:20000}).toBe(true);await expect(fallback().getByRole('heading',{level:1})).toBeVisible();await fallback().getByRole('button',{name:'关闭数据中心'}).click();await expect.poll(()=>!!fallback()).toBe(false);await p.unroute('**/data-center-native.css',missing);await open('/market-data?tab=sources');await expect(dc().getByRole('heading',{name:'来源与能力'})).toBeVisible();await close();record('failed native asset uses compatibility window and successful retry remounts complete native UI');
  expect(report.errors).toEqual([]);report.passed=true;
 }catch(e){report.errors.push(e.message);await p.screenshot({path:path.join(out,'native-compat-failed.png')}).catch(()=>{});throw e;}
 finally{fs.writeFileSync(path.join(out,'native-compat-report.json'),JSON.stringify(report,null,2));await b.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
