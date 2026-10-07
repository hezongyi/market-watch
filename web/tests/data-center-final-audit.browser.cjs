// Read-only real pages plus explicitly disclosed network-failure injection.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const artifacts=path.resolve(__dirname,'../../artifacts/data-integration');
const base='http://127.0.0.1:16629';

async function contrast(page){return page.locator('.data-center').evaluate(root=>{
 const rgba=value=>{const m=value.match(/^rgba?\(([^)]+)\)$/);return m?m[1].split(',').map(Number):null};
 const over=(a,b)=>{const alpha=a[3]??1;return a.slice(0,3).map((v,i)=>v*alpha+b[i]*(1-alpha))};
 const luminance=c=>c.reduce((sum,v,i)=>{const s=v/255;return sum+[.2126,.7152,.0722][i]*(s<=.04045?s/12.92:((s+.055)/1.055)**2.4)},0);
 const failures=[],skips=[];let samples=0,minimum=Infinity;
 for(const el of root.querySelectorAll('*')){
  if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))continue;
  const box=el.getBoundingClientRect(),style=getComputedStyle(el);
  if(!box.width||!box.height||style.visibility==='hidden'||el.closest('[disabled]'))continue;
  let current=el,layers=[],opaque=false,skip=false;
  while(current){const s=getComputedStyle(current),bg=rgba(s.backgroundColor);
   if(s.backgroundImage!=='none'||Number(s.opacity)!==1||!bg){skip=true;break}
   layers.push(bg);if((bg[3]??1)===1){opaque=true;break}current=current.parentElement;
  }
  const fg=rgba(style.color);
  if(skip||!fg){skips.push(el.textContent.trim().slice(0,60));continue}
  let background=[255,255,255];for(const layer of layers.reverse())background=over(layer,background);
  const a=luminance(over(fg,background)),b=luminance(background),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  const size=parseFloat(style.fontSize),large=size>=24||(size>=18.66&&Number(style.fontWeight)>=700),required=large?3:4.5;
  samples++;minimum=Math.min(minimum,ratio);
  if(ratio+.001<required)failures.push({text:el.textContent.trim().slice(0,90),color:style.color,background,ratio,size,required,opaque});
 }
 return {samples,minimum,failures,skips,meaning:'Computed visible DOM text only; excludes canvas, disabled controls and unresolved layered/gradient backgrounds.'};
})}

(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 const page=await context.newPage(),errors=[],writes=[];
 const report={environment:'Ubuntu isolated market-watch-three-layer',passed:false,checks:[],pages:[],errors};
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname)});
 const get=async route=>{const r=await page.request.get(base+'/api/'+route);expect(r.ok()).toBe(true);return r.json()};
 try{
  await page.goto(base+'/market-data');
  await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.getByRole('heading',{name:'数据中心',exact:true})).toBeVisible();
  const datasets=(await get('market-data/center/datasets?query=EURUSD&page_size=100')).items;
  const d=datasets.find(r=>r.identity.calendar_version==='user-forex-ny17-v1'&&r.identity.source==='dukascopy');expect(d).toBeTruthy();
  const original='/market-data/datasets/'+d.id;
  const composite=JSON.parse(fs.readFileSync(path.join(artifacts,'cross-source-setup.json'))).records[0].composite_id;
  const longPage=await get('market-data/center/platform?source=dukascopy&page_size=100');
  const longItem=[...longPage.items].sort((a,b)=>b.label.length-a.label.length)[0];
  expect(longItem).toBeTruthy();
  const routes=['/market-data','/market-data?tab=platform&query=EURUSD','/market-data?tab=tasks',
   original,original+'?section=coverage',original+'?section=versions',original+'?section=maintenance',
   original+'?section=references','/market-data/composites/'+composite,
   '/market-data/composites/'+composite+'?section=usage','/market-data/datasets/new','/market-data?tab=platform&source=dukascopy&query='+encodeURIComponent(longItem.label)];
  const writesBefore=writes.length;
  for(const route of routes){
   await page.goto(base+route);await expect(page.locator('.data-center h1')).toBeVisible({timeout:30000});
   await expect(page.getByRole('status').filter({hasText:'正在读取数据…'})).toHaveCount(0,{timeout:30000});
   for(const width of [1024,1440,1920]){
    await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);
   }
   await page.setViewportSize({width:1024,height:1000});
   await page.locator('.data-center').evaluate(el=>el.style.zoom='2');
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);
   await page.locator('.data-center').evaluate(el=>el.style.zoom='');
   const color=await contrast(page);report.pages.push({route,contrast:color});
  }
  expect(writes.slice(writesBefore)).toEqual([]);
  report.checks.push('actual list/detail/coverage/version/maintenance/reference/composite/create pages: three desktop widths, 200% content zoom, reduced motion and no management writes');
  await page.goto(base+'/market-data');await expect(page.getByText(/快照：/)).toBeVisible();
  await page.getByLabel('资产类别').selectOption('metal');
  const metal=await get('market-data/center/datasets?asset_class=metal&page_size=25');
  await expect(page.locator('.dc-table tbody tr')).toHaveCount(metal.items.length);
  expect(metal.items.every(d=>d.asset_class==='metal')).toBe(true);
  await page.reload();await expect(page.getByLabel('资产类别')).toHaveValue('metal');
  const backRow=page.locator('.dc-table tbody tr').first();const backId=await backRow.getAttribute('id');
  await backRow.getByRole('link',{name:'查看',exact:true}).click();
  await page.getByRole('button',{name:'发布版本',exact:true}).click();
  await page.getByRole('link',{name:'返回数据中心列表',exact:true}).click();
  await expect(page.getByLabel('资产类别')).toHaveValue('metal');
  await expect(page.locator('#'+backId)).toBeFocused();
  report.checks.push('detail tab change and explicit return preserve originating center filter/page and focus the original stable row once');
  await page.getByLabel('资产类别').selectOption('');
  const all=await get('market-data/center/datasets?page_size=25');
  await expect(page.locator('.dc-table tbody tr')).toHaveCount(all.items.length);
  report.checks.push('asset category uses actual pre-pagination API filter and survives URL reload; actual catalog long label readable');
  const selector=page.getByLabel('搜索品种'),source=page.getByRole('combobox',{name:/^来源/});await selector.focus();await page.keyboard.press('Tab');await expect(source).toBeFocused();
  const visibleFocus=await source.evaluate(el=>{const s=getComputedStyle(el);return s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>=2});expect(visibleFocus).toBe(true);
  // Failure injection returns 503 after a successful real snapshot; no fake data.
  await page.route('**/api/market-data/center/datasets?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'controlled audit unavailable'})}));
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('controlled audit unavailable');
  await expect(page.getByText(/快照：.*刷新失败/)).toBeVisible();await expect(page.locator('.dc-table tbody tr').first()).toBeVisible();
  await page.unroute('**/api/market-data/center/datasets?*');await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByRole('alert')).toHaveCount(0);
  report.checks.push('keyboard visible focus; controlled HTTP503 retains real list snapshot and explicit stale notice, refresh recovers');
  await page.goto(base+original+'?section=maintenance');await expect(page.getByRole('button',{name:'保存维护设置'})).toBeVisible();
  const zone=page.getByLabel('维护时区');if(await zone.isVisible())await zone.fill('Europe/London');
  const frequency=page.getByLabel('更新频率');await frequency.selectOption('daily');
  await page.getByLabel('维护时区').fill('Europe/London');await page.getByLabel('维护时区').focus();
  await expect(page.getByLabel('维护时区')).toHaveValue('Europe/London');
  // Wait for one periodic background snapshot without changing form or focus.
  await page.waitForResponse(r=>r.url().includes('/api/market-data/center/datasets/'+d.id)&&r.request().method()==='GET',{timeout:15000});
  await expect(page.getByLabel('维护时区')).toHaveValue('Europe/London');await expect(page.getByLabel('维护时区')).toBeFocused();
  await context.setOffline(true);await page.getByRole('button',{name:'保存维护设置'}).click();
  await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByLabel('维护时区')).toHaveValue('Europe/London');
  await context.setOffline(false);
  report.checks.push('periodic real snapshots preserve edited maintenance form and focus; offline submit preserves fields');
  await page.goto(base+'/market-data?tab=composite&query=EURUSD');
  const combinedRow=page.locator('.table-scroll tbody tr').first();
  await expect(combinedRow).toBeVisible({timeout:30000});const combinedId=await combinedRow.getAttribute('id');
  await combinedRow.getByRole('link',{name:'查看详情',exact:true}).click();
  await page.getByRole('link',{name:'返回组合行情',exact:true}).click();
  await expect(page.getByLabel('搜索品种')).toHaveValue('EURUSD');
  await expect(page.locator('#'+combinedId)).toBeFocused();
  report.checks.push('composite list/detail return preserves exact filter and original row without collection writes');
  await page.goto(base+'/market-data/datasets/new');
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  const fieldSummary=page.getByRole('alert');await expect(fieldSummary).toBeFocused();
  await expect(fieldSummary.getByRole('link')).toHaveCount(3);
  expect(await fieldSummary.evaluate(el=>getComputedStyle(el).outlineStyle!=='none')).toBe(true);
  await fieldSummary.getByRole('link',{name:/填写1–10/}).click();await expect(page.locator('#create-logical')).toBeFocused();
  const fieldContrast=await contrast(page);report.pages.push({route:'create multiple-field-error state',contrast:fieldContrast});
  const targets=await page.locator('.data-center button, .data-center select, .dc-source summary').evaluateAll(elements=>elements.map(el=>{
    const b=el.getBoundingClientRect();return {name:el.textContent.trim().slice(0,60),width:b.width,height:b.height};
  }).filter(b=>b.width&&b.height));
  expect(targets.filter(b=>b.width<24||b.height<24)).toEqual([]);
  report.checks.push('multiple creation errors have14px inline instructions, linked summary with visible programmatic focus; visible buttons/select/source summary at least24CSSpx');
  await page.screenshot({path:path.join(artifacts,'data-center-final-audit.png'),fullPage:true});
  const low=report.pages.flatMap(p=>p.contrast.failures.map(f=>({route:p.route,...f})));
  report.contrastFailures=low;expect(low).toEqual([]);expect(errors).toEqual([]);report.passed=true;
 }catch(e){report.failure=String(e);throw e}
 finally{fs.writeFileSync(path.join(artifacts,'data-center-final-audit.json'),JSON.stringify(report,null,2)+'\n');await browser.close()}
 console.log(JSON.stringify({passed:report.passed,checks:report.checks,contrastSamples:report.pages.reduce((n,p)=>n+p.contrast.samples,0)}));
})().catch(e=>{console.error(e);process.exitCode=1});
