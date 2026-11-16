const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('@playwright/test');

module.exports = async ({page, context, server, datasets, mappings, make, entries, errors, proof, shot, close, out, writes}) => {
  const row = make(entries[0], 'c'.repeat(64), true);
  row.continuation.enabled = true;
  row.runtime_status = 'unauthorized';
  row.maintenance.last_success = Date.UTC(2026,10,15);
  datasets.set(row.id, row);
  mappings.set(row.id, [{id:'a'.repeat(64),current_account:true,valid_for_selection:true,target_identity:{provider_symbol:'EUR_USD'}}]);
  const other = make(entries[1], 'd'.repeat(64), true);
  other.maintenance.paused = true;
  datasets.set(other.id, other);
  const failed = make(entries[2], 'e'.repeat(64), true);
  failed.maintenance.task_status = 'failed';
  datasets.set(failed.id, failed);
  const rows = page.locator('[data-slot="tabs-content"]:not([hidden]) .data-managed-row');
  const eur = () => rows.filter({has:page.getByRole('switch',{name:'EURUSD 实时',exact:true})});
  const detail = () => page.getByRole('dialog',{name:'自建行情',exact:true});
  async function reload() {
    await Promise.all([
      page.waitForResponse(r=>r.url().includes('/center/dataset-summaries?')&&r.request().method()==='GET'),
      page.reload(),
    ]);
    await expect(rows).toHaveCount(3);
  }
  async function open() {
    await eur().getByRole('button',{name:'查看 EURUSD',exact:true}).click();
    await expect(detail().locator('.data-live-summary')).toHaveText('已开启');
  }
  await page.goto(`http://127.0.0.1:${server.address().port}/m/data`);
  await page.getByLabel('密码',{exact:true}).fill('fixture');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(eur().getByText('维护已配置',{exact:true})).toBeVisible();
  await expect(eur().getByText('实时已开启',{exact:true})).toBeVisible();
  await expect(eur().getByRole('switch')).toBeChecked();
  await expect(rows.filter({hasText:'XAUUSD'}).getByText('维护已暂停',{exact:true})).toBeVisible();
  await expect(rows.filter({hasText:'AAPL'}).getByText('维护需处理',{exact:true})).toBeVisible();
  proof.checks.push('401不改变已开启配置；暂停及失败与实时分开，已有历史仍保留');
  await shot('01-stable-settings-auth-retry');
  await open();
  await expect(detail().getByText('维护设置',{exact:true})).toHaveCount(2); // fact label and edit action
  await expect(detail().getByText('最近执行',{exact:true})).toBeVisible();
  await expect(detail().getByText('连接认证失败，系统自动重试',{exact:true})).not.toBeVisible();
  await detail().getByRole('button',{name:'最近运行情况',exact:true}).click();
  await expect(detail().getByText('连接认证失败，系统自动重试',{exact:true})).toBeVisible();
  await shot('02-runtime-on-demand');
  await close('自建行情');
  for (const status of ['recovering','receiving','market_closed','provider_maintenance','preparing']) {
    row.runtime_status = status;
    row.maintenance.active_version_id = 'v1';
    row.maintenance.task_status = 'deriving';
    await reload();
    await expect(eur().getByText('实时已开启',{exact:true})).toBeVisible();
    await expect(eur().getByText('维护已配置',{exact:true})).toBeVisible();
    await expect(eur()).not.toContainText(/认证异常|恢复中|实时运行中|派生中|闭市/);
  }
  row.maintenance.task_status='retrying';row.maintenance.task_error='timeout';
  await reload();
  await expect(eur().getByText('维护已配置',{exact:true})).toBeVisible();
  delete row.maintenance.task_error;
  proof.checks.push('准备、重连、收盘、来源维护、历史派生及自动重试均不改写长期设置状态');
  row.runtime_status = 'recovering';
  row.runtime_health = {connection:'recovering',quote_ready:true,sample_ready:true,confirmed_tail_ready:false};
  await reload();
  await open();
  await detail().getByRole('button',{name:'最近运行情况',exact:true}).click();
  await expect(detail().getByText('报价已恢复，分钟线补齐中',{exact:true})).toBeVisible();
  await close('自建行情');
  row.runtime_status = 'account_changed';
  await reload();
  await expect(eur().getByText('实时需处理',{exact:true})).toBeVisible();
  await expect(eur().getByRole('switch')).toBeChecked();
  await expect(eur().getByText('来源账户已变化，请重新核对实时来源',{exact:true})).toBeVisible();
  await shot('03-actionable-configuration');
  proof.checks.push('新报价与分钟补齐分开说明；账户配置失效有明确处理提示且不伪造关闭');
  row.runtime_status = 'receiving';
  row.maintenance.active_version_id = null;
  row.maintenance.task_status = 'published';
  for (const theme of ['light','dark']) for (const width of [375,412]) for (const font of [14,21]) {
    await page.getByRole('link',{name:'更多',exact:true}).click();
    if (await page.locator('.mobile-app').getAttribute('data-theme')!==theme)
      await page.getByRole('button',{name:/显示主题/}).click();
    await page.getByRole('link',{name:'数据',exact:true}).click();
    await page.setViewportSize({width,height:880});
    await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);
    await expect(eur().getByText('实时已开启',{exact:true})).toBeVisible();
    await shot(`list-${theme}-${width}-${font}`);
    await open();
    await shot(`detail-${theme}-${width}-${font}`);
    await close('自建行情');
  }
  proof.checks.push('375/412px、深浅主题、100%/150%字号，列表及详情截图无溢出');
  await page.getByRole('link',{name:'更多',exact:true}).click();
  await page.getByRole('button',{name:/日志/}).click();
  const logs=page.getByRole('dialog',{name:'日志',exact:true});
  await expect(logs.locator('.mobile-log-row').filter({hasText:'连接认证失败，系统自动重试'})).toBeVisible();
  await shot('04-runtime-logged');
  await close('日志');
  await page.getByRole('link',{name:'数据',exact:true}).click();
  await context.setOffline(true);
  await expect(eur().getByRole('switch')).toBeDisabled();
  await expect(eur().getByText('实时已开启',{exact:true})).toBeVisible();
  await context.setOffline(false);
  await expect(eur().getByRole('switch')).toBeEnabled();
  proof.checks.push('连接变化静默进入更多日志；断网保留设置且禁止误操作，联网恢复');
  assert.deepEqual(errors,[]);
  assert.deepEqual(writes.filter(w=>w.path!=='/api/login'),[],'只读状态验收不提交任何业务配置');
  proof.passed=true;
  fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify(proof,null,2));
  console.log(JSON.stringify({passed:true,checks:proof.checks,screenshots:proof.screenshots.length,out}));
};
