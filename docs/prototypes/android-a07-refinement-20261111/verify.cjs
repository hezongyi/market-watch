/* Design-only browser verification; no application build, API, deployment, or CI. */
const {chromium} = require('../../../web/node_modules/@playwright/test');
const {pathToFileURL} = require('url');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = __dirname;
const out = path.join(root,'evidence');
const results = { interactions:[], layouts:[], states:[], errors:[], network:[] };
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
(async()=>{
  const browser = await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  const context = await browser.newContext({viewport:{width:412,height:892},deviceScaleFactor:1});
  const page = await context.newPage();
  page.on('pageerror',e=>results.errors.push(String(e)));
  page.on('request',r=>{if(/^https?:/.test(r.url()))results.network.push(r.url())});
  const go = async query => { await page.goto(pathToFileURL(path.join(root,'preview.html')).href+'?'+query);await page.waitForFunction(()=>document.querySelector('#screen').children.length>0);await page.waitForTimeout(80); };
  const click = async action => page.locator(`[data-action="${action}"]:visible`).first().click();
  const check = (name,value=true) => {assert.ok(value,name);results.interactions.push(name)};
  const shot = async name => page.screenshot({path:path.join(out,'final-'+name+'.png')});
  const choose = async (id,value) => {
    await page.locator(`.select-control[data-id="${id}"]`).click();
    await page.locator(`[data-action="field-option"][data-value="${value}"]`).click();
    assert.equal(await page.locator('#'+id).inputValue(),value);
  };
  await go('page=alerts&sheet=create');
  await page.locator('#threshold').fill('2712.5');
  await page.locator('[data-action=mode][data-id="收盘"]').click();
  await choose('rule-frame','H4');await choose('relation','向下穿越');await choose('expiry','自定义');
  check('custom expiry reveals UTC input',await page.locator('#expiry-at').isVisible());
  await choose('expiry','1 周');await page.locator('#notify').uncheck();
  await click('close-sheet');check('unsaved close asks before discarding',await page.locator('#sheet-title').textContent()==='放弃本次修改？');
  await click('keep-editing');
  check('picker and nested back preserve all input',await page.locator('#threshold').inputValue()==='2712.5' && await page.locator('#rule-frame').inputValue()==='H4' && !await page.locator('#notify').isChecked());
  await page.locator('#rule-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#sheet-title')?.textContent==='规则已保存');
  await shot('saved');await click('close-sheet');
  check('save is waiting for takeover, not prematurely active',(await page.locator('.alert-card').first().textContent()).includes('等待接管'));

  await go('page=alerts&sheet=failure');await page.waitForSelector('.operation-feedback');
  await page.locator('#threshold').fill('2720');await click('demo-recover');await click('retry-submit');
  await page.waitForFunction(()=>document.querySelector('#sheet-title')?.textContent==='规则已保存');
  check('failed submission recovers without losing price',await page.evaluate(()=>state.rules[0].threshold===2720));

  await go('page=alerts&sheet=conflict');await page.waitForSelector('.operation-feedback');
  await page.locator('#threshold').fill('2735');await click('inspect-conflict');await click('sheet-back');
  check('conflict review back retains draft',await page.locator('#threshold').inputValue()==='2735');
  await page.locator('#rule-form button[type=submit]').click();await page.waitForSelector('.operation-feedback');
  await click('inspect-conflict');await click('confirm-reload');
  check('explicit conflict reload replaces draft',await page.locator('#threshold').inputValue()==='2700');

  await go('page=watch&sheet=search');await page.locator('#search-input').fill('日元');await click('add-watch');
  check('search adds the selected instrument',await page.evaluate(()=>state.watch.includes('jpy')));await click('close-sheet');
  await page.locator('#nav [data-id=center]').click();await page.locator('[data-action=data-detail]').first().click();
  await click('choose-frame');await page.locator('[data-action=open-frame]').first().click();
  check('data detail opens the chosen series and period',await page.evaluate(()=>state.page==='chart'&&state.selected==='btc'&&state.frame==='M1'));
  await click('crosshair');check('crosshair can be enabled',await page.locator('.demo-crosshair').isVisible());await page.keyboard.press('Escape');
  check('Escape exits crosshair',!await page.locator('.demo-crosshair').count());
  await click('indicators');await page.locator('#study-search').fill('RSI');await click('add-study');
  check('indicator search adds RSI',await page.evaluate(()=>state.indicators.includes('RSI')));
  await click('study-settings');await page.locator('#study-period').fill('21');await page.locator('#study-form button[type=submit]').click();
  check('indicator parameters persist through sheet return',await page.evaluate(()=>state.indicatorPeriods.RSI===21));

  await go('page=login');await page.locator('#password').fill('local-demo-only');await page.locator('#login-form button[type=submit]').click();
  await page.waitForFunction(()=>state.page==='watch');check('login demo returns to watch with zero network');
  await go('page=watch');await page.locator('[data-action=chart]').first().click();await page.locator('#nav [data-id=more]').click();await click('theme');await page.locator('[data-action=set-theme][data-id=light]').click();
  check('theme changes through actual settings',await page.locator('#device').getAttribute('data-theme')==='light');

  const pages=['watch','chart','alerts','center','more','login'];
  const sizes=[[375,812],[412,892],[892,412],[375,540]];
  for(const [width,height] of sizes)for(const theme of ['dark','light'])for(const dest of pages){
    await page.setViewportSize({width,height});await go(`page=${dest}&theme=${theme}`);
    const dims=await page.evaluate(()=>({body:document.body.scrollWidth,width:innerWidth,screen:document.querySelector('#screen').scrollWidth,client:document.querySelector('#screen').clientWidth,nav:document.querySelector('#nav').getBoundingClientRect().bottom}));
    assert.ok(dims.body<=dims.width+1 && dims.screen<=dims.client+1,`overflow ${dest} ${width} ${theme}: ${JSON.stringify(dims)}`);
    results.layouts.push({page:dest,width,height,theme,...dims});
    if(width===412)await shot(theme+'-'+dest);
  }
  for(const theme of ['dark','light'])for(const dest of pages){
    await page.setViewportSize({width:375,height:812});await go(`page=${dest}&theme=${theme}&scale=150`);
    const dims=await page.evaluate(()=>({body:document.body.scrollWidth,width:innerWidth,screen:document.querySelector('#screen').scrollWidth,client:document.querySelector('#screen').clientWidth}));
    assert.ok(dims.body<=dims.width+1 && dims.screen<=dims.client+1,`large-font overflow ${dest} ${theme}: ${JSON.stringify(dims)}`);
    results.layouts.push({page:dest,width:375,height:812,scale:150,theme,...dims});
    if(theme==='dark')await shot('large-'+dest);
  }
  await page.setViewportSize({width:375,height:812});
  const states=[['create','page=alerts&sheet=create'],['edit','page=alerts&sheet=edit'],['search','sheet=search'],['groups','sheet=groups'],['manage','sheet=manage'],['detail','page=center&sheet=detail'],['rule','page=alerts&sheet=rule'],['events','page=alerts&sheet=events'],['sources','page=center&sheet=sources'],['indicators','page=chart&sheet=indicators'],['connection','sheet=connection'],['expired','scene=expired'],['cold','scene=cold'],['loading','scene=loading'],['empty','scene=empty'],['chart-empty','page=chart&scene=empty'],['offline','scene=offline'],['offline-empty','scene=offline-empty'],['error','scene=error'],['stale','scene=stale'],['failure','page=alerts&sheet=failure'],['conflict','page=alerts&sheet=conflict'],['ntfy-off','page=alerts&scene=ntfy-off&sheet=create'],['capability','page=chart&sheet=capability'],['discard','sheet=discard'],['storage','page=chart&sheet=storage'],['notification','sheet=notification']];
  for(const [name,query] of states){await go(query);if(['failure','conflict'].includes(name))await page.waitForSelector('.operation-feedback');await shot(name);const dims=await page.evaluate(()=>({body:document.body.scrollWidth,sheet:document.querySelector('#sheet').scrollWidth,client:document.querySelector('#sheet').clientWidth,open:document.querySelector('#sheet').open}));assert.ok(dims.body<=375 && (!dims.open||dims.sheet<=dims.client+1),`state overflow ${name}`);if(name==='notification')check('event notice does not cover the first quote',await page.evaluate(()=>document.querySelector('.quote-row').getBoundingClientRect().top>=document.querySelector('#alert-notice').getBoundingClientRect().bottom));results.states.push({name,...dims});}
  // A reduced viewport approximates the available space above an Android keyboard.
  await page.setViewportSize({width:375,height:480});await go('page=alerts&sheet=create');await page.locator('#threshold').fill('2740');await page.locator('#rule-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#sheet-title')?.textContent==='规则已保存');check('submit remains reachable at 375x480 keyboard-like viewport');
  await page.setViewportSize({width:1440,height:1100});await page.goto(pathToFileURL(path.join(root,'index.html')).href);await page.waitForTimeout(300);await page.screenshot({path:path.join(out,'final-overview.png'),fullPage:true});await page.locator('#compare').click();await page.locator('#compare-page').selectOption('center');await page.waitForTimeout(200);check('overview comparison changes both panes',(await page.locator('#before').getAttribute('src')).includes('page=center')&&(await page.locator('#after').getAttribute('src')).includes('page=center'));
  assert.deepEqual(results.errors,[]);assert.deepEqual(results.network,[]);
  fs.writeFileSync(path.join(out,'browser-proof.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({interactions:results.interactions.length,layouts:results.layouts.length,states:results.states.length,errors:results.errors,network:results.network}));
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
