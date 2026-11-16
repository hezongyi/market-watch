// Deterministic faults use HTTP fixtures; never writes real rules or sends push.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {expect} = require('@playwright/test');
module.exports = async ({page,context,out,shot,close,refresh,choose,pick,errors,setRows,setEvents,event,datasetId,instrument,revision}) => {
  const checks = [];
  const detail = () => page.getByRole('dialog',{name:'规则详情',exact:true});
  // Capability failure is retriable without losing or recreating the editor.
  const caps = '**/api/chart-alerts/capabilities';
  await context.route(caps,route=>route.fulfill({status:503,json:{detail:'核验暂时不可用，请重试'}}));
  let form = await pick();
  await expect(form.getByRole('button',{name:'重新核验能力',exact:true})).toBeVisible();
  await expect(form.getByRole('button',{name:'创建告警',exact:true})).toBeDisabled();
  await shot('capability-error');
  await context.unroute(caps);
  await form.getByRole('button',{name:'重新核验能力',exact:true}).click();
  await expect(form.getByRole('button',{name:'创建告警',exact:true})).toBeEnabled();
  await close(form);
  checks.push('能力核验失败就地重试，保留编辑层');
  const now=Date.now();
  const row={id:'lifecycle-rule',name:'欧元美元提醒',version:1,control_revision:1,run:1,status:'active',health:'ready',count:0,max_triggers:1,effective_at:now-60000,created_at:now-60000,updated_at:now,
    config:{name:'欧元美元提醒',instrument,series_kind:'composite',source:'composite',timeframe:'M1',mode:'close',expires_at:null,notify_web:true,notify_ntfy:false,max_triggers:1,message:'',late_delivery:'log_only',association:null,calculation_version:'chart-python-v1',seam_policy:'reject',condition:{relation:'cross_up',left:{kind:'price'},right:{kind:'constant',value:'1.10'}},composite_revision_id:revision},
    condition_summary:'价格上穿 1.10000',market_identity:{dataset_id:datasetId,source:'dukascopy',description:'欧元美元'},display_identity:{code:'EURUSD'},runtime:{},
    execution:{state:'monitoring',taken_over_at:now-60000,last_checked_at:now,last_evaluated_at:now-10000}};
  setRows([row]);await refresh();
  await page.locator('.alert-rule-open').click();
  await detail().getByRole('button',{name:'编辑条件',exact:true}).click();
  form=page.getByRole('dialog',{name:'编辑告警',exact:true});
  await form.getByLabel('目标价格',{exact:true}).fill('1.11');
  let writes=0,readLost=true;
  await context.route('**/api/chart-alerts/lifecycle-rule/edit',route=>{
    writes++;const body=route.request().postDataJSON();row.config=body.config;row.version++;row.control_revision++;
    return route.fulfill({status:503,json:{detail:'模拟保存后响应丢失'}});
  });
  await context.route('**/api/chart-alerts/lifecycle-rule',route=>{
    if(readLost){readLost=false;return route.fulfill({status:500,json:{detail:'模拟首次回读失败'}});}
    return route.fulfill({json:row});
  });
  await form.getByRole('button',{name:'保存告警',exact:true}).click();
  await expect(form.getByRole('button',{name:'核查同一次提交',exact:true})).toBeVisible();
  await form.getByRole('button',{name:'核查同一次提交',exact:true}).click();
  await expect(form).toHaveCount(0);await expect(detail()).toBeVisible();
  assert.equal(writes,1,'unknown edit is resolved without a duplicate old-version write');
  await shot('resolved-edit');await close(detail());
  checks.push('保存及首次回读都丢失响应，再核查仍仅写入一次');
  async function filter(label){
    await page.getByRole('button',{name:'搜索规则',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'搜索规则',exact:true});
    await choose(dialog,'规则范围',label);
    await dialog.getByRole('button',{name:'查看规则',exact:true}).click();
    await expect(dialog).toHaveCount(0);
  }
  row.status='expired';row.config.expires_at=now-1;
  row.execution={...row.execution,state:'settling',settlement_pending:true};
  setRows([{...row}]);await refresh();
  await expect(page.locator('.alert-rule')).toContainText('结算中');
  await page.locator('.alert-rule-open').click();
  await expect(detail().getByRole('button',{name:'编辑条件',exact:true})).toHaveCount(0);
  await expect(detail().getByRole('button',{name:'恢复',exact:true})).toHaveCount(0);
  await shot('settling');await close(detail());
  await filter('已结束');
  await expect(page.locator('.alert-rule')).toHaveCount(0);
  row.status='completed';row.count=1;
  row.execution={state:'completed'};
  row.last_notification={event_id:'event-1',notification_id:'notification-1',status:'delivery_error',outbox_status:'blocked',ack_at:null};
  setRows([{...row}]);await refresh();await filter('需处理');
  await expect(page.locator('.alert-rule')).toContainText('次数已用完');
  await expect(page.locator('.alert-rule')).toContainText('推送认证失败');
  await shot('completed-delivery-error');
  checks.push('结算中不显示编辑恢复，结束规则的推送失败仍可从需处理发现');
  const e=event(0),blocked={...event(1),delivery_status:'blocked',notification_status:'delivery_error',delivery_attempts:1};
  setEvents([e,blocked]);
  await page.getByRole('tab',{name:'事件记录',exact:true}).click();
  await expect(page.locator('.alert-event-row').first()).toBeVisible();
  let detailReads=0;
  await context.route('**/api/chart-alerts/events/event-0',route=>{
    if(++detailReads<=3)return route.fulfill({status:503,json:{detail:'模拟临时读取中断'}});
    return route.fulfill({json:e});
  });
  await page.locator('.alert-event-row').first().click();
  let ev=page.getByRole('dialog',{name:'触发详情',exact:true});
  await expect(ev.getByRole('alert')).toContainText('模拟临时读取中断');
  await expect(ev.getByRole('alert')).toHaveCount(0,{timeout:20000});
  assert.ok(detailReads>=4);
  await context.unroute('**/api/chart-alerts/events/event-0');
  checks.push('详情短暂读取失败后自动恢复，清除读取错误而不清除操作失败');
  const observations='**/api/notification-center/observations';
  let ackCount=0;
  page.on('request',request=>{if(request.url().includes('/notifications/notification-0/ack'))ackCount++;});
  await context.route(observations,route=>route.fulfill({json:{ok:true}}));
  await ev.getByRole('button',{name:'处理本次提醒',exact:true}).click();
  await expect(ev.getByRole('alert')).toContainText('尚未确认全部处理结果');
  await expect(ev.getByRole('button',{name:'处理本次提醒',exact:true})).toBeEnabled();
  await shot('unconfirmed-handle');await context.unroute(observations);
  await ev.getByRole('button',{name:'处理本次提醒',exact:true}).click();
  await expect(ev.getByRole('button',{name:'处理本次提醒',exact:true})).toHaveCount(0);
  assert.equal(ackCount,1);await close(ev);
  checks.push('处理接口返回成功但服务器未完成时不假报成功，再试不重复确认');
  await page.locator('.alert-event-row').nth(1).click();
  ev=page.getByRole('dialog',{name:'触发详情',exact:true});
  await expect(ev.getByRole('button',{name:'重试推送',exact:true})).toBeVisible();
  await context.route('**/api/notifications/notification-1/retry',route=>{
    blocked.delivery_status='pending';blocked.notification_status='pending';blocked.delivery_attempts=2;
    blocked.device_received_at=Date.now();
    return route.fulfill({json:{status:'pending'}});
  });
  await ev.getByRole('button',{name:'重试推送',exact:true}).click();
  await expect(ev.getByText('设备已接收',{exact:true})).toBeVisible();
  await ev.getByRole('button',{name:'投递与判定详情',exact:true}).click();
  await expect(ev).toContainText('2 次');
  await shot('delivery-retry-device-receipt');await close(ev);
  checks.push('认证受阻通知可重试，对应设备回执和尝试次数真实回读');
  assert.deepEqual(errors,[]);
  const proof={passed:true,checks,errors};
  fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
};
