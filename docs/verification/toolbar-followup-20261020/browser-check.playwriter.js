const assert=require('assert').strict,fs=require('node:fs');
const dir='/home/quant/repos/market-watch-issue75-integrated-20261019/docs/verification/toolbar-followup-20261020';
if(state.toolbarErrorListener)state.page.off('pageerror',state.toolbarErrorListener);
state.toolbarResults={cases:[],errors:[]};
const errors=state.toolbarResults.errors;
state.page.on('pageerror',state.toolbarErrorListener=e=>errors.push(e.message));
await state.page.setViewportSize({width:1600,height:1000});
await state.page.reload({waitUntil:'domcontentloaded'});
await state.page.frameLocator('iframe[data-workspace-id]').frameLocator('iframe').locator('.nc-system-entry').waitFor();
state.host=state.page.frames().find(f=>f.url().startsWith('https://192.168.7.232:18281/'));
await state.host.waitForFunction(()=>typeof noticeUI!=='undefined'&&noticeUI);
state.native=state.page.frames().find(f=>f.url().startsWith('blob:'));
const entry=state.native.locator('.nc-system-entry');
await entry.waitFor();
const read=async l=>l.evaluate(e=>({color:getComputedStyle(e).color,background:getComputedStyle(e,'::before').backgroundColor,content:getComputedStyle(e,'::before').content,width:e.getBoundingClientRect().width}));
for(const theme of ['Light','Dark']){
 await state.host.evaluate(t=>widget.changeTheme(t),theme);
 const results={theme};
 for(const [name,l] of [['settings',state.native.locator('#header-toolbar-properties')],['system',entry]]){
  await state.page.mouse.move(500,300);const before=await read(l);await l.hover();const after=await read(l);
  assert.notEqual(before.background,after.background,name+' hover must change background');results[name]={before,after};
 }
 assert.equal(results.system.after.background,results.settings.after.background);
 assert.equal(results.system.after.width,38);
 results.geometry=await entry.evaluate(e=>{const toolbar=e.closest('.innerWrap-OhqNVIYA'),snap=toolbar.querySelector('#header-toolbar-screenshot');const r=e.getBoundingClientRect(),s=snap.getBoundingClientRect();const icon=e.querySelector('svg').getBoundingClientRect(),other=snap.querySelector('svg').getBoundingClientRect();const separator=e.closest('.group-MBOVGQRI').previousElementSibling;return {gap:r.left-s.right,centerDistance:(icon.left+icon.right-other.left-other.right)/2,separatorWidth:separator.getBoundingClientRect().width,separatorDisplay:getComputedStyle(separator).display};});
 assert.equal(results.geometry.gap,0);assert.equal(results.geometry.centerDistance,38);assert.equal(results.geometry.separatorWidth,0);
 await state.page.screenshot({path:dir+'/'+theme.toLowerCase()+'-hover.png',scale:'css',clip:{x:1360,y:0,width:240,height:85}});
 state.toolbarResults.cases.push(results);
}
await state.host.evaluate(()=>widget.changeTheme('Light'));
const order=await entry.evaluate(e=>{const toolbar=e.closest('.innerWrap-OhqNVIYA'),indicator=toolbar.querySelector('.mw-indicator-button'),template=toolbar.querySelector('#header-toolbar-study-templates');const a=indicator.getBoundingClientRect(),b=template.getBoundingClientRect();return {indicatorLeft:a.left,indicatorRight:a.right,templateLeft:b.left,gap:b.left-a.right};});
assert.equal(order.gap,0);state.toolbarResults.cases.push({name:'template immediately after indicators',...order});
await state.native.locator('#header-toolbar-study-templates').getByRole('button',{name:'指标模板',exact:true}).click();
await state.native.locator('[data-name="indicator-templates-menu"]').waitFor();
await state.native.locator('[data-name="indicator-templates-menu"]').press('Escape');
await state.native.locator('[data-name="indicator-templates-menu"]').waitFor({state:'hidden'});
await state.page.screenshot({path:dir+'/indicator-template-order.png',scale:'css',clip:{x:500,y:0,width:400,height:85}});
for(const key of ['Enter',' ']){
 await entry.focus();await entry.press(key);
 await state.native.locator('.nc-panel').waitFor();
 assert.equal(await entry.getAttribute('aria-expanded'),'true');
 await state.native.getByRole('button',{name:'关闭系统消息',exact:true}).press('Escape');
 await state.native.locator('.nc-panel').waitFor({state:'hidden'});
 assert.equal(await entry.getAttribute('aria-expanded'),'false');
 assert(await entry.evaluate(e=>e.ownerDocument.activeElement===e),'Escape restores entry focus');
 state.toolbarResults.cases.push({name:'keyboard open/close',key,focusRestored:true});
}
try{
 for(const count of [0,1,120]){
  await state.host.evaluate(n=>noticeUI.update({...noticeState,unread:n}),count);
  const badge=entry.locator('.nc-entry-count');
  assert.equal(await badge.isHidden(),count===0);assert.equal(await badge.innerText(),count>99?'99+':String(count));
  assert.equal(await entry.evaluate(e=>e.getBoundingClientRect().width),38);
 }
 state.toolbarResults.cases.push({name:'synthetic local unread counts',counts:[0,1,120],noServerWrites:true});
 await entry.hover();await state.page.screenshot({path:dir+'/unread-badge.png',scale:'css',clip:{x:1500,y:0,width:100,height:85}});
}finally{await state.host.evaluate(()=>noticeUI.update(noticeState));}
await state.host.evaluate(()=>widget.changeTheme('Dark'));
await state.page.setViewportSize({width:760,height:900});
await entry.waitFor();await entry.hover();
const narrow=await entry.evaluate(e=>({width:e.getBoundingClientRect().width,x:e.getBoundingClientRect().x,right:e.getBoundingClientRect().right,background:getComputedStyle(e,'::before').backgroundColor}));
assert.equal(narrow.width,38);assert(narrow.right<=761,'allow native toolbar subpixel rounding of less than one CSS pixel');
await entry.focus();await entry.press('Enter');await state.native.locator('.nc-panel').waitFor();
await state.page.screenshot({path:dir+'/dark-narrow.png',scale:'css'});
await state.native.getByRole('button',{name:'关闭系统消息',exact:true}).click();
state.toolbarResults.cases.push({name:'dark narrow toolbar',...narrow});
await state.page.setViewportSize({width:1600,height:1000});await state.host.evaluate(()=>widget.changeTheme('Light'));
await state.page.reload({waitUntil:'domcontentloaded'});
await state.page.frameLocator('iframe[data-workspace-id]').frameLocator('iframe').locator('.nc-system-entry').waitFor();
state.host=state.page.frames().find(f=>f.url().startsWith('https://192.168.7.232:18281/'));
await state.host.waitForFunction(()=>typeof noticeUI!=='undefined'&&noticeUI);
state.native=state.page.frames().find(f=>f.url().startsWith('blob:'));
await state.native.locator('.nc-system-entry').waitFor();
const reload=await state.native.locator('.nc-system-entry').evaluate(e=>{const toolbar=e.closest('.innerWrap-OhqNVIYA');return {buttons:toolbar.querySelectorAll('.nc-system-entry').length,width:e.getBoundingClientRect().width,templateAfterIndicator:toolbar.querySelector('#header-toolbar-study-templates').getBoundingClientRect().left>=toolbar.querySelector('.mw-indicator-button').getBoundingClientRect().right};});
assert.equal(reload.buttons,1);assert.equal(reload.width,38);assert(reload.templateAfterIndicator);
state.toolbarResults.cases.push({name:'reload lifecycle',...reload});
assert.deepEqual(errors,[]);state.toolbarResults.passed=true;
fs.writeFileSync(dir+'/browser-results.json',JSON.stringify(state.toolbarResults,null,2));
state.page.off('pageerror',state.toolbarErrorListener);
console.log(JSON.stringify(state.toolbarResults,null,2));
