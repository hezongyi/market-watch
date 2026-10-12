// Live Ubuntu product; only the one marked catalogue failure is injected.
const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const p=await product(),r={environment:'Ubuntu mw-pro-charts-20261011',cases:[]};
 try {
  const cdp=await p.page.context().newCDPSession(p.page);
  for(const theme of ['Dark','Light']) {
   await p.host.evaluate(t=>widget.changeTheme(t),theme);
   for(const zoom of [1,1.25,1.5]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:Math.round(1600/zoom),height:Math.round(1000/zoom),deviceScaleFactor:zoom,mobile:false});
    const alert=p.ui.getByRole('button',{name:'警报',exact:true});
    await alert.focus();await p.page.keyboard.press('Enter');
    await p.expect(alert).toHaveAttribute('aria-pressed','true');
    const geometry=await alert.evaluate(n=>{const a=n.getBoundingClientRect(),b=n.querySelector('svg').getBoundingClientRect(),s=getComputedStyle(n);return {button:[a.width,a.height],svg:[b.width,b.height],center:[b.x+b.width/2-a.x,b.y+b.height/2-a.y],focus:n===document.activeElement,focusVisible:n.matches(':focus-visible'),outline:s.outline,shadow:s.boxShadow};});
    assert.deepEqual(geometry.button,[44,44]);assert.deepEqual(geometry.svg,[44,44]);assert.deepEqual(geometry.center,[22,22]);assert.ok(geometry.focus&&geometry.focusVisible);
    const decoration=await alert.evaluate(n=>{const s=getComputedStyle(n,'::before');return {outline:s.outline,content:s.content};});
    assert.ok(decoration.outline.includes('solid')&&decoration.content!=='none','visible native keyboard focus indicator');
    await p.page.keyboard.press('Enter');await p.expect(alert).toHaveAttribute('aria-pressed','false');
    r.cases.push({name:'keyboard sidebar toggle/selection/focus at browser-equivalent viewport and DPR zoom',theme,zoom,geometry,decoration});
   }
   await cdp.send('Emulation.clearDeviceMetricsOverride');
   await p.page.setViewportSize({width:768,height:600});
   await p.host.evaluate(()=>dataCenter.open('/market-data?tab=calendar'));await p.expect(p.center).toBeVisible();
   const hint=p.center.locator('[data-native-component="operationHint"]');
   await p.expect(hint).toContainText('展开品种');
   const hintBefore=await hint.boundingBox();
   const last=p.center.locator('.dc-calendar-row summary').last();await last.scrollIntoViewIfNeeded();await last.focus();await p.page.keyboard.press('Enter');
   const rowBox=await last.boundingBox(),hintBox=await hint.boundingBox();assert.ok(rowBox.y+rowBox.height<=hintBox.y,'last row clear of native hint');
   const focus=await last.evaluate(n=>({visible:n.matches(':focus-visible'),outline:getComputedStyle(n).outline}));assert.ok(focus.visible&&!focus.outline.includes('none'));
   await p.center.getByRole('button',{name:'任务与记录',exact:true}).click();await p.expect(hint).toContainText('刷新列表');
   const hintAfter=await hint.boundingBox();assert.equal(hintBefore.height,hintAfter.height);
   r.cases.push({name:'section hint changes without height jump; keyboard last row clear of footer',theme,hintBefore,hintAfter,rowBox,focus});
   await p.page.setViewportSize({width:375,height:600});
   const narrow=[];
   for(const name of ['交易日历','任务与记录','自建行情','来源状态','组合行情','平台行情']) {
    await p.center.getByRole('button',{name,exact:true}).click();await p.expect(hint).toBeVisible();
    const box=await hint.boundingBox();narrow.push({section:name,text:await hint.innerText(),box});
   }
   assert.equal(new Set(narrow.map(x=>x.box.height)).size,1,'narrow section hint height remains stable');
   r.cases.push({name:'375px all section hints retain native height',theme,narrow});
   await p.page.setViewportSize({width:768,height:600});
   await p.center.getByRole('button',{name:'任务与记录',exact:true}).click();
   let fault=true;
   await p.page.route('**/api/market-data/center/platform?*',route=>{
    if(fault){fault=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'isolated catalogue read failure'})});}
    return route.continue();
   });
   await p.center.getByRole('button',{name:'平台行情',exact:true}).click();
   await p.expect(p.center.getByRole('alert')).toContainText('读取失败');
   await p.expect(hint).toContainText('搜索或筛选品种');
   const retry=p.center.getByRole('button',{name:'重试',exact:true});
   await retry.focus();await p.page.keyboard.press('Enter');
   await p.expect(p.center.getByRole('alert')).toHaveCount(0);
   const detail=p.center.locator('[data-role="list-item"]').last().getByRole('button',{name:'详情',exact:true});
   await detail.scrollIntoViewIfNeeded();await detail.focus();await p.page.keyboard.press('Tab');await p.page.keyboard.press('Shift+Tab');
   const detailBox=await detail.boundingBox(),platformHint=await hint.boundingBox();assert.ok(detailBox.y+detailBox.height<=platformHint.y);
   const detailFocus=await detail.evaluate(n=>({focused:n===document.activeElement,visible:n.matches(':focus-visible'),outline:getComputedStyle(n).outline}));assert.ok(detailFocus.focused&&detailFocus.visible&&detailFocus.outline.includes('solid'));
   r.cases.push({name:'marked catalogue 503, real API keyboard retry, last native row focus clear of hint',theme,detailBox,platformHint,detailFocus});
   await p.page.unrouteAll({behavior:'wait'});
   await p.center.getByRole('button',{name:'关闭数据中心',exact:true}).click();
   await p.ui.getByRole('button',{name:'指标',exact:true}).click();
   const dialog=p.ui.locator('[data-name="indicators-dialog"]');
   await dialog.getByRole('button',{name:'我的 Python',exact:true}).click();
   const indicatorHint=dialog.locator('[class*="footer-"]').last();await p.expect(indicatorHint).toContainText('星标');
   const indicator=dialog.locator('.mw-native-study-row').last().getByRole('button',{name:/查看.*详情/});
   await indicator.scrollIntoViewIfNeeded();await indicator.focus();await p.page.keyboard.press('Tab');await p.page.keyboard.press('Shift+Tab');
   const indicatorBox=await indicator.boundingBox(),indicatorFooter=await indicatorHint.boundingBox();assert.ok(indicatorBox.y+indicatorBox.height<=indicatorFooter.y);
   const indicatorFocus=await indicator.evaluate(n=>({visible:n.matches(':focus-visible'),outline:getComputedStyle(n).outline}));
   r.cases.push({name:'last Python indicator and keyboard focus clear of native operation hint',theme,indicatorBox,indicatorFooter,indicatorFocus});
   assert.ok(indicatorFocus.visible&&indicatorFocus.outline.includes('solid'));
   await p.ui.getByRole('button',{name:'关闭指标窗口',exact:true}).click();
  }
  assert.deepEqual(p.errors,[]);r.passed=true;
 }catch(e){r.failure=e.stack;throw e;}finally{r.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-operation-hints.json',JSON.stringify(r,null,2));await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
