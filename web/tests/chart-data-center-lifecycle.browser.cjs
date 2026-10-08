// Exact task/project only. Fault state applies solely to the task created here.
const {chromium,expect}=require('@playwright/test'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),art=path.join(root,'artifacts/data-center'),base='https://192.168.7.232:19943';
const project='mw-data-center-impl-20261008';
const compose='docker compose --env-file artifacts/data-center/compose.env -p '+project+' -f artifacts/data-center/compose.yaml';
const docker=cmd=>execFileSync('sg',['docker','-c',cmd],{cwd:root,stdio:['pipe','pipe','pipe']}).toString();
const report={environment:'Ubuntu isolated real APIs/PG; exact created-task failure state injection',passed:false,checks:[],errors:[]};
(async()=>{
 const b=await chromium.launch({executablePath:'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox']});const p=await b.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});p.on('pageerror',e=>report.errors.push(e.message));
 const dc=()=>p.frames().find(f=>f.url().includes('/chart-data-center?'));
 const get=async route=>{const r=await p.request.get(base+'/api/'+route);expect(r.ok(),await r.text()).toBeTruthy();return r.json()};
 const post=async(route,data)=>{const {csrf}=await get('session');const r=await p.request.post(base+'/api/'+route,{data,headers:{'X-CSRF-Token':csrf}});expect(r.ok(),await r.text()).toBeTruthy();return r.json()};
 const record=(name,data={})=>{console.log('PASS',name);report.checks.push({name,...data})};
 const own=JSON.parse(fs.readFileSync(path.join(art,'ui-created.json'))).dataset.id,protectedId=JSON.parse(fs.readFileSync(path.join(art,'created.json'))).dataset.id;
 let task,stopped=false;
 try {
  await p.goto(base+'/market-data/datasets/'+own+'?section=maintenance');await p.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(art,'login.json'))).password);await p.getByRole('button',{name:'登录工作台'}).click();await expect.poll(()=>!!dc(),{timeout:30000}).toBeTruthy();await expect(dc().getByRole('heading',{name:'GBPUSD',exact:true})).toBeVisible();
  docker(compose+' stop history-worker');stopped=true;
  await dc().getByLabel('任务类型',{exact:true}).selectOption('recheck');await dc().getByLabel('起始交易日期',{exact:true}).fill('2026-10-07');await dc().getByLabel('结束交易日期（不包含）',{exact:true}).fill('2026-10-08');
  const response=p.waitForResponse(r=>r.url().includes('/datasets/'+own+'/tasks')&&r.request().method()==='POST');await dc().getByRole('button',{name:'提交复查'}).click();task=(await (await response).json()).id;expect(task).toMatch(/^[a-f0-9-]{36}$/);
  await dc().getByRole('button',{name:'任务与记录',exact:true}).click();await dc().getByRole('button',{name:'全部任务',exact:true}).click();const row=dc().locator('#task-'+task);await expect(row).toBeVisible();await row.getByRole('button',{name:'暂停任务'}).click();await expect(row.getByRole('button',{name:'恢复任务'})).toBeVisible();await row.getByRole('button',{name:'恢复任务'}).click();await expect(row.getByRole('button',{name:'暂停任务'})).toBeVisible();
  docker("docker exec "+project+"-pg-1 psql -U data_center -d data_center -c \"UPDATE market_history_versions SET status='retrying', error='supplier_unavailable', next_at=9999999999999 WHERE id='"+task+"' AND dataset_id='"+own+"';\"");await dc().getByRole('button',{name:'刷新',exact:true}).click();await expect(row.getByRole('button',{name:'重试失败范围'})).toBeVisible();await row.getByRole('button',{name:'重试失败范围'}).click();await expect(row.getByRole('button',{name:'重试失败范围'})).toHaveCount(0);await row.getByRole('button',{name:'取消任务'}).click();await expect(row.getByRole('button',{name:'暂停任务'})).toHaveCount(0);
  record('range maintenance submits real task; UI pause/resume/retry/cancel work against exact PG fixture',{task});
  docker(compose+' start history-worker');stopped=false;
  await p.goto(base+'/market-data/datasets/'+protectedId+'?section=references');await expect.poll(()=>!!dc(),{timeout:30000}).toBeTruthy();await expect(dc().getByRole('heading',{name:'引用与历史回收'})).toBeVisible();await dc().getByRole('button',{name:'查看回收影响'}).click();await expect(dc().getByRole('button',{name:'删除所列数据'})).toBeDisabled();expect((await get('market-data/datasets/'+protectedId+'/references')).items.length).toBeGreaterThan(0);record('real workspace/composite references protect history deletion');
  await p.goto(base+'/market-data/datasets/'+own+'?section=maintenance');await expect.poll(()=>!!dc(),{timeout:30000}).toBeTruthy();await expect(dc().getByRole('heading',{name:'GBPUSD',exact:true})).toBeVisible();if(await dc().getByRole('button',{name:'暂停定时维护'}).count())await dc().getByRole('button',{name:'暂停定时维护'}).click();await expect(dc().getByRole('button',{name:'恢复维护'})).toBeVisible();await dc().getByRole('button',{name:'归档条目'}).click();await expect(dc().getByRole('button',{name:'取消归档'})).toBeVisible();
  await dc().getByRole('button',{name:'组合与引用',exact:true}).click();await dc().getByRole('button',{name:'查看回收影响'}).click();await expect(dc().getByRole('button',{name:'删除所列数据'})).toBeEnabled();await dc().getByRole('button',{name:'取消回收'}).click();await expect(dc().getByRole('button',{name:'查看回收影响'})).toBeFocused();await dc().getByRole('button',{name:'查看回收影响'}).click();await dc().getByRole('button',{name:'删除所列数据'}).click();await expect(dc().getByText(/已回收 \d+ 个版本的价格数据/)).toBeVisible();
  const refs=await get('market-data/datasets/'+own+'/references');expect(refs.impact.payload_totals.target_versions).toBe(0);record('archive, exact impact review, cancel focus and unreferenced history reclamation complete',{dataset:own});
  expect(report.errors).toEqual([]);report.passed=true;
 } finally {if(task&&!report.passed)await post('market-data/tasks/'+task+'/control',{action:'cancel'}).catch(()=>{});if(stopped)docker(compose+' start history-worker');fs.writeFileSync(path.join(art,'lifecycle-report.json'),JSON.stringify(report,null,2));await b.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
