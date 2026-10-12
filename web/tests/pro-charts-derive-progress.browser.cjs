// Committed PG progress, real task controls and the mounted product details UI.
const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process');
const source='docs/verification/pro-charts-20261011/derive-progress-runtime.py';
function run(mode,id) {
 const args=['python','-',mode];if(id){assert.match(id,/^[a-f0-9-]{36}$/);args.push(id);}
 const output=cp.execFileSync('sg',['docker','-c','docker compose -p mw-pro-charts-20261011 -f docs/verification/pro-charts-20261011/compose.yaml exec -T api '+args.join(' ')],{input:fs.readFileSync(source),timeout:60000,encoding:'utf8'});
 return JSON.parse(output.trim().split('\n').at(-1));
}
(async()=>{
 const seeded=run('seed'),p=await product(),r={environment:'Ubuntu mw-pro-charts-20261011',seeded,cases:[]};
 const url='http://localhost:19997/api/market-data/versions/'+seeded.version;
 const refresh=async()=>{await p.center.getByRole('button',{name:'刷新列表',exact:true}).click();await p.expect(p.center.locator('#task-'+seeded.version)).toBeVisible();await p.center.locator('#task-'+seeded.version).getByRole('button',{name:'查看任务详情',exact:true}).click();};
 try {
  // Seed can already have an earlier committed page from a prior debug run.
  run('advance',seeded.version);
  await p.host.evaluate(dataset=>dataCenter.open('/market-data?tab=tasks&status=all&dataset_id='+dataset),seeded.dataset);await p.expect(p.center).toBeVisible();
  const row=p.center.locator('#task-'+seeded.version);await p.expect(row).toContainText('周期发布');
  await row.getByRole('button',{name:'查看任务详情',exact:true}).click();
  await p.expect(p.center.getByRole('heading',{name:'周期派生',exact:true})).toBeVisible();
  await p.expect(p.center.getByText(/行观测（各周期合计）/)).toBeVisible();
  await p.expect(p.center.getByText(/按近期处理速度估算/)).toBeVisible();
  const before=await(await p.page.request.get(url)).json();assert.ok(before.derivation.estimated_remaining_seconds>0);
  r.cases.push({name:'actual committed counts and recent ETA rendered in task details',progress:before.derivation});
  const pause=p.page.waitForResponse(x=>x.url().endsWith('/tasks/'+seeded.version+'/control')&&x.request().method()==='POST');
  await row.getByRole('button',{name:'暂停任务',exact:true}).click();assert.equal((await pause).status(),200);
  await p.expect(row.getByRole('button',{name:'恢复任务',exact:true})).toBeVisible({timeout:15000});
  assert.equal((await(await p.page.request.get(url)).json()).derivation.estimated_remaining_seconds,null);
  await p.expect(p.center.getByText(/按近期处理速度估算/)).toHaveCount(0);
  const resume=p.page.waitForResponse(x=>x.url().endsWith('/tasks/'+seeded.version+'/control')&&x.request().method()==='POST');
  await row.getByRole('button',{name:'恢复任务',exact:true}).click();assert.equal((await resume).status(),200);
  const resumed=await(await p.page.request.get(url)).json();assert.equal(resumed.derivation.estimated_remaining_seconds,null);
  run('advance',seeded.version);await refresh();await p.expect(p.center.getByText(/按近期处理速度估算/)).toBeVisible();
  r.cases.push({name:'actual page pause/resume clears ETA until newly committed service',pausedEta:null,resumedEta:resumed.derivation.estimated_remaining_seconds});
  const completed=run('finish',seeded.version);await refresh();
  assert.equal(completed.progress.published_periods,2);assert.equal(completed.progress.estimated_remaining_seconds,0);
  await p.expect(p.center.getByText('历史读取完成；已发布 2/2 个周期。',{exact:true})).toBeVisible();
  await p.expect(p.center.getByText(/按近期处理速度估算/)).toHaveCount(0);
  r.cases.push({name:'actual completion shows every period and no obsolete ETA',progress:completed.progress});
  assert.deepEqual(p.errors,[]);r.passed=true;
 }catch(e){r.failure=e.stack;throw e;}finally{r.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-derive-progress.json',JSON.stringify(r,null,2));await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
