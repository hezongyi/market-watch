// Deletes only the explicitly recorded dedicated real-content acceptance identity.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const artifacts=path.resolve(__dirname,'../../artifacts/data-integration'),base='http://127.0.0.1:16629';
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 const report={environment:'Ubuntu isolated market-watch-three-layer',passed:false,checks:[],errors:[]};
 page.on('pageerror',e=>report.errors.push(e.message));let workspace=null;
 const get=async route=>{const r=await page.request.get(base+'/api/'+route);expect(r.ok(),await r.text()).toBe(true);return r.json()};
 const post=async(route,data)=>{const {csrf}=await get('session');const r=await page.request.post(base+'/api/'+route,{data,headers:{'X-CSRF-Token':csrf}});expect(r.ok(),await r.text()).toBe(true);return r.json()};
 const setup=JSON.parse(fs.readFileSync(path.join(artifacts,'reclamation-review-sample.json'))),id=setup.dataset_id,version=setup.version_id;
 try{
  await expect.poll(async()=> (await page.request.get(base+'/readyz')).status(),{timeout:60000}).toBe(200);
  await page.goto(base+'/market-data');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await expect(page.getByRole('heading',{name:'数据中心',exact:true})).toBeVisible();
  const dataset=await get('market-data/center/datasets/'+id);expect(dataset.identity.calendar_version).toBe('acceptance-reclamation-review-utc0-v1');
  expect(dataset.maintenance.paused).toBe(true);expect(dataset.maintenance.archived).toBe(true);
  expect((await get('market-data/versions/'+version)).payload_available).toBe(true);
  await page.goto(base+'/market-data/datasets/'+id+'?section=references');await page.getByRole('button',{name:'查看回收影响',exact:true}).click();
  let review=page.getByRole('region',{name:'确认历史回收'});await expect(review).toBeVisible();await expect(review).toContainText(version);await expect(review).toContainText('EUR/USD');await expect(review).toContainText('UTC0');
  await expect(review).toContainText('保留');await expect(review.getByRole('button',{name:'删除所列数据'})).toBeEnabled();
  const initial=await get('market-data/datasets/'+id+'/references');expect(initial.impact.payload_totals.retained_shared_source_blobs).toBeGreaterThan(0);
  for(const width of [1024,1440,1920]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true)}
  await page.locator('.data-center').evaluate(el=>el.style.zoom='2');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);await page.locator('.data-center').evaluate(el=>el.style.zoom='');
  await page.getByRole('button',{name:'取消回收'}).click();await expect(page.getByRole('button',{name:'查看回收影响',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'查看回收影响',exact:true}).click();review=page.getByRole('region',{name:'确认历史回收'});
  // Real dependency is added after review; background polls must not replace
  // the reviewed token. The request still reaches the locked server check.
  workspace=await post('charts/workspaces',{name:'reclamation review race '+Date.now()});
  workspace=await post('charts/workspaces/'+workspace.id+'/save',{name:workspace.name,revision:workspace.revision,
   document:{...workspace.document,panels:[{...workspace.document.panels[0],instrument:dataset.instrument_id,timeframe:'M1',version_id:version}]}});
  const rejected=page.waitForResponse(r=>r.url().endsWith('/reclaim')&&r.request().method()==='POST');
  await review.getByRole('button',{name:'删除所列数据'}).click();const conflict=await rejected;expect(conflict.status()).toBe(409);expect((await conflict.json()).detail.code).toBe('RECLAMATION_CHANGED');
  await expect(page.getByRole('alert').filter({hasText:'所列数据未删除'})).toBeFocused();await expect(page.getByRole('region',{name:'确认历史回收'})).toHaveCount(0);
  await expect(page.getByText('保存的图表工作区',{exact:true})).toBeVisible();expect((await get('market-data/versions/'+version)).payload_available).toBe(true);
  report.checks.push('exact identity/version/ranges/period/shared-byte review; three widths/200% content zoom; cancel restores focus; real post-review reference returns409 and preserves prices with latest dependency');
  await post('charts/workspaces/'+workspace.id+'/delete',{revision:workspace.revision});workspace=null;
  await page.getByRole('button',{name:'查看回收影响',exact:true}).click();review=page.getByRole('region',{name:'确认历史回收'});await expect(review.getByRole('button',{name:'删除所列数据'})).toBeEnabled();
  await page.screenshot({path:path.join(artifacts,'reclamation-review-real.png'),fullPage:true});
  const deleted=page.waitForResponse(r=>r.url().endsWith('/reclaim')&&r.request().method()==='POST');
  await review.getByRole('button',{name:'删除所列数据'}).click();const response=await deleted;expect(response.status()).toBe(200);const cleared=await response.json();expect(cleared.versions).toBe(1);
  await expect(page.getByRole('status')).toContainText('已回收 1 个版本');expect((await get('market-data/versions/'+version)).payload_available).toBe(false);
  const parent=await get('market-data/versions/'+setup.parent_version_id);expect(parent.payload_available).toBe(true);expect(parent.manifest.checksum).toBe(setup.parent_checksum);
  report.checks.push('explicit fresh review deletes only dedicated acceptance payload; original real source parent remains readable/checksum unchanged; shared blobs retained');
  report.reclamation=cleared;expect(report.errors).toEqual([]);report.passed=true;
 }catch(e){report.failure=String(e);throw e}
 finally{if(workspace){await post('charts/workspaces/'+workspace.id+'/delete',{revision:workspace.revision});report.cleanup='only owned workspace removed';}fs.writeFileSync(path.join(artifacts,'reclamation-review-real-browser.json'),JSON.stringify(report,null,2)+'\n');await browser.close()}
 console.log(JSON.stringify({passed:report.passed,checks:report.checks}));
})().catch(e=>{console.error(e);process.exitCode=1});
