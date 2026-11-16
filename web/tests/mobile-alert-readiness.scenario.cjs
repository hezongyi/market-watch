// Built app status transitions, using explicit HTTP fixtures and no real writes.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {expect}=require('@playwright/test');
module.exports=async({page,context,out,shot,close,refresh,errors,setRows,setHealth,datasetId,instrument,revision})=>{
  const now=Date.now();
  const row={id:'rule-readiness',name:'欧元美元上穿',version:1,control_revision:1,run:1,status:'active',health:'ready',count:0,max_triggers:3,effective_at:now-120000,created_at:now-120000,updated_at:now,
    config:{name:'欧元美元上穿',instrument,series_kind:'composite',source:'composite',timeframe:'H1',mode:'close',expires_at:null,notify_web:true,notify_ntfy:false,condition:{relation:'cross_up',left:{kind:'price'},right:{kind:'constant',value:'1.10'}},composite_revision_id:revision},
    condition_summary:'价格上穿 1.10000',market_identity:{dataset_id:datasetId,source:'dukascopy'},display_identity:{code:'EURUSD'},runtime:{},
    execution:{state:'monitoring',taken_over_at:now-100000,last_checked_at:now,last_evaluated_at:now-60000,last_outcome:'evaluated'}};
  const normal={...row.execution}, checks=[];
  const healthy=()=>({enabled:true,loop:{state:'idle',heartbeat_at:Date.now()}});
  const list=()=>page.locator('.alert-rule');
  const detail=()=>page.getByRole('dialog',{name:'规则详情',exact:true});
  async function state(health,execution,label){
    row.execution={...normal,last_checked_at:Date.now(),...execution};setRows([{...row}]);setHealth(health);
    await expect.poll(async()=>{await refresh();return list().locator('.alert-rule-status > span').textContent();}).toBe(label);
    await expect(list().getByRole('switch')).toBeChecked();
  }
  // An older, slow healthy response cannot overwrite a newer service failure.
  await state(healthy,{},'监控中');
  let oldRead=false;
  setHealth(()=>{oldRead=true;return {...healthy(),_delay:1200};});
  await refresh();await expect.poll(()=>oldRead).toBe(true);
  setHealth(()=>({enabled:false,loop:{state:'unknown'}}));await refresh();
  await expect(list()).toContainText('服务未开启');
  await page.waitForTimeout(1400);
  await expect(list()).toContainText('服务未开启');
  checks.push('旧的慢健康响应不能覆盖较新的服务异常');
  for(const [theme,width,font] of [['light',375,14],['dark',412,21]]){
    await page.getByRole('link',{name:'更多',exact:true}).click();
    if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();
    await page.setViewportSize({width,height:880});await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);
    await page.locator('a[href="/m/alerts"]').click();
    await state(()=>({enabled:false,loop:{state:'unknown'}}),{state:'preparing',reason_code:'awaiting_worker',taken_over_at:null,last_checked_at:null,last_evaluated_at:null},'服务未开启');
    await shot(`disabled-${theme}`);
    await list().locator('.alert-rule-open').click();
    await expect(detail()).toContainText('当前不会判定或触发');
    await expect(detail().getByRole('button',{name:'去数据详情',exact:true})).toHaveCount(0);
    await shot(`disabled-detail-${theme}`);await close(detail());
    await state(healthy,{},'监控中');await expect(list()).toContainText('最近检查');await shot(`monitoring-${theme}`);
    await list().locator('.alert-rule-open').click();
    await expect(detail()).toContainText('已完成判定');
    await expect(detail().getByRole('button',{name:'排查信息',exact:true})).toHaveAttribute('aria-expanded','false');
    await shot(`monitoring-detail-${theme}`);await close(detail());
    await state(healthy,{state:'preparing',reason_code:'awaiting_worker',taken_over_at:null,last_checked_at:null},'尚未接管');
    await shot(`not-taken-over-${theme}`);
    await state(healthy,{last_checked_at:Date.now()-90000},'判定未推进');await shot(`stalled-rule-${theme}`);
    await state(()=>({enabled:true,loop:{state:'stale',heartbeat_at:Date.now()-90000}}),{},'监控已中断');await shot(`service-stale-${theme}`);
    await state(healthy,{state:'recovering',message:'行情连接中断，等待来源恢复。'},'等待数据');await shot(`waiting-data-${theme}`);
    await state(healthy,{state:'closed'},'休市');await shot(`closed-${theme}`);
    await state(healthy,{state:'monitoring',phone_configuration:{reason_code:'phone_topic_missing',message:'手机通知未配置 topic，请在通知设置中完成配置。'}},'监控中');
    row.config.notify_ntfy=true;setRows([{...row}]);await refresh();
    await expect(list()).toContainText('手机通知未配置');await list().locator('.alert-rule-open').click();
    await expect(detail().getByRole('button',{name:'检查通知设置',exact:true})).toBeVisible();await shot(`phone-issue-${theme}`);await close(detail());
    row.config.notify_ntfy=false;await state(healthy,{last_outcome:'initial_baseline'},'监控中');await list().locator('.alert-rule-open').click();
    await expect(detail()).toContainText('基准已建立');await shot(`baseline-${theme}`);await close(detail());
    await state(healthy,{},'监控中');await context.setOffline(true);
    await expect(list()).toContainText('离线待确认');await expect(list().getByRole('switch')).toBeDisabled();await shot(`offline-${theme}`);
    await context.setOffline(false);await refresh();await expect(list()).toContainText('监控中');
    checks.push(`${width}px ${theme} ${font}px：未开启、接管、正常、规则停滞、心跳过期、恢复、休市、推送错误、基准、离线及联网恢复`);
  }
  assert.deepEqual(errors,[]);
  const proof={passed:true,checks,screenshots:fs.readdirSync(out).filter(f=>f.endsWith('.png')),errors};
  fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
};
