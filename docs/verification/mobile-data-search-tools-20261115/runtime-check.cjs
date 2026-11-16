// Ubuntu real APIs, read-only after authentication; no user datasets are changed.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,expect}=require(path.resolve(__dirname,'../../../web/node_modules/@playwright/test'));
const root=__dirname,base='https://127.0.0.1:18447';
fs.mkdirSync(root+'/runtime',{recursive:true});
(async()=>{const b=await chromium.launch();try{
 const c=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:375,height:880},isMobile:true,hasTouch:true});
 const credentials=JSON.parse(fs.readFileSync('/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/credentials.json'));
 assert((await c.request.post(base+'/api/login',{data:{password:credentials.login_password}})).ok());
 const page=await c.newPage(),errors=[],writes=[],queries=[],cases=[];let reads=0;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',r=>{const req=r.request(),p=new URL(req.url()).pathname;if(req.method()!=='GET'){writes.push({path:p,method:req.method()});return r.abort();}if(p.endsWith('/dataset-summaries'))reads++;return r.continue();});
 const dialog=()=>page.getByRole('dialog',{name:'筛选与工具',exact:true});
 const open=async()=>{await page.getByRole('button',{name:'筛选与数据工具',exact:true}).click();await expect(dialog()).toBeVisible();};
 const close=async()=>{await dialog().getByRole('button',{name:'关闭',exact:true}).click();await expect(dialog()).toHaveCount(0);};
 const shot=async name=>{await page.waitForTimeout(350);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:root+'/runtime/'+name+'.png'});};
 await page.goto(base+'/m/data');await expect(page.locator('.data-managed-row').first()).toBeVisible({timeout:30000});
 const all=await c.request.get(base+'/api/market-data/center/dataset-summaries?mobile=true&page_size=100');assert(all.ok());
 const saved=(await all.json()).items;
 const target=saved.find(r=>r.display_symbol==='EURUSD')||saved[0];assert(target);
 const code=target.display_symbol.toLowerCase(),source=target.identity.source;
 for(const query of [code,target.display_symbol==='EURUSD'?'欧元':target.instrument_name,source,code+' '+source.slice(0,2),target.mobile_identity.category]){
  await open();const before=reads;await dialog().getByRole('searchbox',{name:'搜索自建行情',exact:true}).fill(query);await page.waitForTimeout(300);assert.equal(reads,before);
  const response=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname.endsWith('/dataset-summaries')&&u.searchParams.get('query')===query;});
  await dialog().getByRole('button',{name:'查看行情',exact:true}).click();await expect(dialog()).toHaveCount(0);
  const res=await response;assert(res.ok());const value=await res.json();assert(value.total>0,query);
  await expect(page.locator('.data-managed-row')).toHaveCount(value.items.length);
  await expect(page.locator('.data-list-caption')).toContainText(query);
  queries.push({query,total:value.total,codes:value.items.map(r=>({code:r.display_symbol,source:r.identity.source}))});
  await shot('search-'+queries.length);
  await page.getByRole('button',{name:'清除筛选',exact:true}).click();await expect(page.locator('.data-list-caption')).toHaveCount(0);
 }
 for(const width of [375,412])for(const theme of ['light','dark'])for(const font of [14,21]){
  await page.setViewportSize({width,height:880});await page.evaluate(f=>document.documentElement.style.fontSize=f+'px',font);
  await page.getByRole('link',{name:'更多',exact:true}).click();if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();await page.getByRole('link',{name:'数据',exact:true}).click();
  await open();await dialog().getByRole('button',{name:'任务与来源',exact:true}).scrollIntoViewIfNeeded();
  const fields=await dialog().locator('[data-slot="input"],button[role="combobox"],button[type="submit"]').evaluateAll(nodes=>nodes.map(n=>({height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width})));assert(fields.every(v=>v.height>=44&&v.width>200));
  await shot(`tools-${width}-${theme}-${font}`);cases.push({width,theme,font,fields});await close();
 }
 await page.setViewportSize({width:375,height:480});await open();await dialog().getByRole('searchbox',{name:'搜索自建行情',exact:true}).focus();await dialog().getByRole('button',{name:'查看行情',exact:true}).scrollIntoViewIfNeeded();await shot('short-viewport');await close();
 await open();await dialog().getByRole('button',{name:'任务与来源',exact:true}).click();await expect(dialog()).toHaveCount(0);const tools=page.getByRole('dialog',{name:'任务与来源',exact:true});await expect(tools).toBeVisible();await shot('task-handoff');await tools.getByRole('button',{name:'关闭',exact:true}).click();await expect(tools).toHaveCount(0);
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 const proof={passed:true,host:'Ubuntu local Docker',project:'mw-managed-live-rollover-20261113',readOnly:true,queries,cases,screenshots:15,errors,writes};fs.writeFileSync(root+'/runtime-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1});
