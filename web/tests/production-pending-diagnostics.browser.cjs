// Actual built Docker web/API. Invalid synthetic version identities deliberately
// exercise HTTP classification and encoded-path redaction without writing data.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const base='http://127.0.0.1:20271',out='/tmp/mw-pending-fixes-20261013-private';
(async()=>{
 const browser=await chromium.launch({executablePath:chromium.executablePath(),args:['--no-sandbox']});
 const page=await browser.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try {
  await page.goto(base+'/replay');
  await page.getByLabel('管理员密码').fill(fs.readFileSync(out+'/password','utf8'));
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.getByLabel('管理员密码')).toHaveCount(0);
  await page.goto(base+'/replay?dataset_version=OANDA%3AEUR_USD&account=secret');
  await expect.poll(()=>page.evaluate(()=>window.MWChartRequestDiagnostics?.()
   .some(row=>row.path==='/market-data/versions/:id'&&row.outcome==='http'&&row.status===404))).toBe(true);
  const diagnostics=await page.evaluate(()=>window.MWChartRequestDiagnostics());
  assert.ok(diagnostics.length>0&&diagnostics.length<=100);
  for(const row of diagnostics){
   assert.ok(!row.path.includes('?'));
   assert.ok(!/OANDA|EUR_USD|secret|account=/.test(row.path));
   assert.ok(row.elapsedMs>=0&&row.attempt>=1);
  }
  const copyIsolated=await page.evaluate(()=>{
   const rows=window.MWChartRequestDiagnostics();rows[0].path='mutated';
   return window.MWChartRequestDiagnostics()[0].path!=='mutated';
  });
  assert.equal(copyIsolated,true);assert.deepEqual(errors,[]);
  const evidence={environment:'Ubuntu task-owned Docker mw-pending-fixes-20261013, built web and actual API',passed:true,
   checks:['encoded synthetic series identity redacted in built diagnostic path','query omitted','HTTP 404 classified without retry','bounded diagnostic copy isolated from caller mutation','no pageerrors'],
   failedVersionRead:diagnostics.find(row=>row.path==='/market-data/versions/:id'),pageerrors:errors};
  assert.equal(evidence.failedVersionRead.attempt,1);
  fs.writeFileSync(out+'/docker-diagnostics.json',JSON.stringify(evidence,null,2));
  console.log('PASS Docker diagnostics',JSON.stringify(evidence));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
