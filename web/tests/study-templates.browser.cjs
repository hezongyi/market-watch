// Real native dialogs and preferences API, task-local Ubuntu acceptance only.
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const APP = 'https://localhost:16443', CHART = 'https://127.0.0.1:16444';
(async () => {
  const browser = await chromium.launch({headless:true,
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
  const page = await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  async function chartFrame(target) {
    await target.goto(APP+'/advanced-charts');
    await target.frameLocator('iframe[title="专业图表工作区"]').locator('#chart').waitFor();
    const chart=target.frames().find(frame=>frame.url().startsWith(CHART+'/'));
    await chart.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:60000});
    await chart.childFrames()[0].getByRole('button',{name:'保存或应用指标模板',exact:true}).waitFor();
    return chart;
  }
  async function rows() {return page.evaluate(async()=>(await(await fetch('/api/advanced-charts/preferences')).json()).filter(row=>row.kind==='study'));}
  const name='模板交互验收 '+Date.now();
  let created=false;
  try {
    await page.goto(APP+'/');
    await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('/tmp/mw-swing-sr-20261012-private/credentials.json')).password);
    await page.getByRole('button',{name:'登录工作台'}).click();
    await page.waitForFunction(()=>!document.querySelector('input[type=password]'));
    const chart=await chartFrame(page), ui=chart.childFrames()[0];
    console.log('Template acceptance: chart ready');
    async function menuItem(title) {
      await ui.getByRole('button',{name:'保存或应用指标模板',exact:true}).click();
      await ui.getByText(title,{exact:true}).filter({visible:true}).click();
    }
    async function saveTemplate() {
      await menuItem('保存指标模板');
      await ui.locator('input[maxlength="64"]').fill(name);
      await ui.locator('input[maxlength="64"]').press('Enter');
    }
    console.log('Template acceptance: saving');
    await saveTemplate();
    await ui.locator('dialog.mw-study-template-save').waitFor({state:'hidden'});
    created=true;
    const original=(await rows()).find(row=>row.name===name);
    assert.ok(original);
    await chart.evaluate(()=>{
      const c=widget.activeChart(),id=c.getAllStudies().find(item=>item.name.includes('SWING_SR_V1')).id;
      c.getStudyById(id).setInputValues([{id:'high_strength',value:3},{id:'low_strength',value:7}]);
    });
    await chart.waitForFunction(()=>document.querySelector('.mw-swing-row')?.textContent.includes('Swing 3 7'));
    console.log('Template acceptance: saving');
    await saveTemplate();
    await ui.getByText('覆盖指标模板',{exact:true}).waitFor();
    await ui.getByRole('button',{name:'否',exact:true}).click({timeout:5000});
    await ui.locator('dialog.mw-study-template-save').waitFor({state:'visible'});
    assert.deepEqual((await rows()).find(row=>row.name===name),original,'cancel preserves template');
    await ui.locator('input[maxlength="64"]').press('Enter');
    await ui.getByRole('button',{name:'是',exact:true}).click({timeout:5000});
    await ui.locator('dialog.mw-study-template-save').waitFor({state:'hidden'});
    const changed=(await rows()).find(row=>row.name===name);
    assert.ok(changed.revision>original.revision);
    assert.notEqual(changed.content.value,original.content.value);
    const mobile=await browser.newContext({ignoreHTTPSErrors:true,hasTouch:true,isMobile:true,viewport:{width:1280,height:950}});
    await mobile.addCookies(await page.context().cookies());
    const mobilePage=await mobile.newPage();
    const mobileChart=await chartFrame(mobilePage), mobileUI=mobileChart.childFrames()[0];
    assert.equal(await mobileChart.evaluate(()=>nativeReadonly),true);
    await mobileUI.getByRole('button',{name:'保存或应用指标模板',exact:true}).click();
    await mobileUI.getByText(name,{exact:true}).filter({visible:true}).waitFor();
    assert.equal(await mobileUI.getByText('保存指标模板',{exact:true}).filter({visible:true}).count(),0);
    assert.equal(await mobileUI.getByText('删除 '+name,{exact:true}).filter({visible:true}).count(),0);
    await mobile.close();
    await menuItem('删除 '+name);
    await ui.getByRole('button',{name:'否',exact:true}).click();
    assert.ok((await rows()).some(row=>row.name===name));
    await menuItem('删除 '+name);
    await ui.getByRole('button',{name:'是',exact:true}).click();
    await page.waitForFunction(async name=>!(await(await fetch('/api/advanced-charts/preferences')).json()).some(row=>row.kind==='study'&&row.name===name),name);
    created=false;
    await chart.evaluate(()=>studyTemplates.dispose());
    assert.equal(await ui.locator('dialog.mw-study-template-save').count(),0);
    assert.equal(await ui.getByRole('button',{name:'保存或应用指标模板',exact:true}).count(),0);
    await page.reload();
    const restored=await chartFrame(page);
    assert.equal(await restored.childFrames()[0].locator('dialog.mw-study-template-save').count(),1);
    await restored.waitForFunction(()=>document.querySelector('.mw-swing-row')?.textContent.includes('Swing 5 5'));
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(ROOT,'artifacts/study-templates-acceptance.json'),JSON.stringify({passed:true,
      app:APP,checks:['save','overwrite cancel','overwrite confirm','coarse-pointer readonly','delete cancel','delete confirm','dispose and reload'],errors},null,2));
    console.log('Study template native dialogs: overwrite, delete, readonly, dispose/reload passed');
  } finally {
    if(created) {
      const chart=page.frames().find(frame=>frame.url().startsWith(CHART+'/'));
      await chart?.evaluate(async name=>prefs.templates.removeStudyTemplate({name}),name).catch(()=>{});
    }
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1});
