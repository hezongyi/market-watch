const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const p=await product(),r={environment:'Ubuntu mw-pro-charts-20261011',delivery:'web-only; no external outbox',cases:[]};
 try {
  const committed=JSON.parse(fs.readFileSync('docs/verification/pro-charts-20261011/notification-runtime.json','utf8'));
  const events=await(await p.page.request.get('http://localhost:19997/api/chart-alerts/events')).json();
  for(const expected of committed.cases) {
   const event=events.find(e=>e.id===expected.signal_id);assert.ok(event);assert.equal(event.message,expected.message);assert.equal(event.delivery_status,'web_only');assert.match(event.display_label,/EURUSD · 组合行情 · bid/);assert.equal(event.evidence.config.condition.right.value,expected.threshold);r.cases.push({name:'persisted PG signal/notification read through actual event API',event});
  }
  await p.ui.getByRole('button',{name:'警报',exact:true}).click();await p.ui.getByRole('tab',{name:'日志',exact:true}).click();
  const summaries=p.ui.locator('.chart-alert-card .alert-row-subtitle');await p.expect(summaries.first()).toBeVisible();const text=await summaries.allTextContents();assert.ok(text.some(t=>t.includes('EURUSD · 组合行情 · bid')));assert.ok(text.every(t=>!t.includes('85eb595180ed9491')));r.cases.push({name:'actual native log panel displays readable saved identity',summaries:text});
  assert.deepEqual(p.errors,[]);r.passed=true;
 }catch(e){r.failure=e.stack;throw e;}finally{r.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-notifications.json',JSON.stringify(r,null,2));await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
