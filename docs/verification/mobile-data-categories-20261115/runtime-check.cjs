const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium,expect}=require(path.resolve(__dirname,'../../../web/node_modules/@playwright/test'));
const root=__dirname,base=process.env.MOBILE_DATA_ORIGIN || 'https://127.0.0.1:18447';
fs.mkdirSync(root+'/runtime',{recursive:true});
(async()=>{const b=await chromium.launch();try{
 const c=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:412,height:880},isMobile:true,hasTouch:true});
 const creds=JSON.parse(fs.readFileSync('/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/credentials.json'));
 assert((await c.request.post(base+'/api/login',{data:{password:creds.login_password}})).ok());
 const p=await c.newPage(),errors=[],failures=[],writes=[],shots=[],categories=[];let gate=null;
 p.on('pageerror',e=>errors.push(e.message));p.on('response',r=>{if(r.status()>=500&&r.url().includes('/api/'))failures.push({path:new URL(r.url()).pathname,status:r.status()})});
 await p.route('**/api/**',async route=>{if(route.request().method()!=='GET'){writes.push({path:new URL(route.request().url()).pathname,method:route.request().method()});return route.abort();}if(gate&&route.request().url().includes('/center/dataset-summaries'))await gate;return route.continue();});
 async function shot(name){await p.waitForTimeout(400);const g=await p.locator('.data-managed-scroll').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,height:el.clientHeight,top:el.scrollTop}));assert(g.height>250&&g.scrollWidth<=g.width+1,name+' list geometry '+JSON.stringify(g));assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' page overflow');await p.screenshot({path:root+'/runtime/'+name+'.png'});shots.push({name,...g});}
 const fetch=async query=>{const r=await c.request.get(base+'/api/market-data/center/dataset-summaries?mobile=true&include_categories=true&page_size=25&'+query);assert(r.ok(),r.status());return r.json()};
 const all=await fetch('page=1');let allRows=[...all.items];for(let n=2;n<=Math.ceil(all.total/25);n++)allRows.push(...(await fetch('page='+n)).items);
 const grouped=[];
 for(const category of all.categories){let group=await fetch('category='+category.value+'&page=1');const rows=[...group.items];for(let n=2;n<=Math.ceil(group.total/25);n++)rows.push(...(await fetch('category='+category.value+'&page='+n)).items);assert.equal(rows.length,group.total);grouped.push(...rows.map(r=>r.id));categories.push({...category,total:group.total,samples:rows.slice(0,3).map(r=>({id:r.id,code:r.display_symbol,asset_class:r.asset_class,source:r.identity.source,badge:r.mobile_identity.category}))});}
 assert.equal(new Set(grouped).size,grouped.length);assert.deepEqual(new Set(grouped),new Set(allRows.map(r=>r.id)));
 await p.goto(base+'/m/data');await expect(p.getByRole('tab',{name:'全部',exact:true})).toBeVisible();await expect(p.locator('.data-managed-row').first()).toBeVisible();
 const nav=()=>p.getByRole('tab',{name:'外汇',exact:true});const fx=all.categories.some(r=>r.value==='forex');
 for(const theme of ['light','dark'])for(const width of [375,412])for(const font of [14,21]){
  await p.getByRole('link',{name:'更多',exact:true}).click();if(await p.locator('.mobile-app').getAttribute('data-theme')!==theme)await p.getByRole('button',{name:/显示主题/}).click();await p.getByRole('link',{name:'数据',exact:true}).click();await p.setViewportSize({width,height:880});await p.evaluate(f=>document.documentElement.style.fontSize=f+'px',font);
  await p.getByRole('tab',{name:'全部',exact:true}).click();await expect(p.locator('.data-managed-row').first()).toBeVisible();await p.locator('.data-managed-scroll').evaluate(el=>el.scrollTop=0);await shot(`all-${theme}-${width}-${font}`);
  if(fx){await nav().click();await expect(p.locator('.data-managed-row').first()).toBeVisible();assert((await p.locator('.data-managed-row .market-badge').allTextContents()).every(t=>t==='外汇'));await shot(`forex-${theme}-${width}-${font}`);}
 }
 await p.setViewportSize({width:412,height:880});await p.evaluate(()=>document.documentElement.style.fontSize='14px');
 for(const category of all.categories){await p.getByRole('tab',{name:category.label,exact:true}).click();await expect(p.locator('.data-managed-row').first()).toBeVisible();await p.locator('.data-managed-scroll').evaluate(el=>el.scrollTop=0);await shot('category-'+category.value);}
 if(fx)await nav().click();await expect(p.locator('.data-managed-row').first()).toBeVisible();await p.locator('.data-managed-scroll').evaluate(el=>el.scrollTop=0);
 let release;gate=new Promise(r=>release=r);await p.locator('.data-managed-scroll').evaluate(el=>{const touch=(type,y)=>el.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[new Touch({identifier:1,target:el,clientX:100,clientY:y})]}));touch('touchstart',180);touch('touchmove',335);touch('touchend',335)});
 await expect(p.getByText('正在刷新…',{exact:true})).toBeVisible();await shot('pull-refresh');release();gate=null;await expect(p.getByText('正在刷新…',{exact:true})).toHaveCount(0);await shot('pull-settled');
 await p.getByRole('button',{name:'筛选与数据工具',exact:true}).click();await p.waitForTimeout(400);await p.screenshot({path:root+'/runtime/filter.png'});await p.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
 assert.equal((await c.request.get(base+'/readyz')).status(),200);assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);assert.deepEqual(writes,[]);
 const proof={passed:true,host:'Ubuntu local Docker',project:'mw-managed-live-rollover-20261113',readOnly:true,total:all.total,categories,partitionComplete:true,screenshots:shots,errors,failures,writes};fs.writeFileSync(root+'/runtime-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify({passed:true,total:all.total,categories:categories.map(({value,total})=>({value,total})),screenshots:shots.length+1,errors,failures,writes}));
}finally{await b.close()}})().catch(e=>{console.error(e);process.exitCode=1});
