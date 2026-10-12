// Real task-owned Ubuntu Docker: no replacement datafeed, RPC or HTTP responses.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const base='http://127.0.0.1:20271',origin='http://127.0.0.1:20272';
const privateDir='/tmp/mw-pending-fixes-20261013-private';
(async()=>{
  const browser=await chromium.launch({executablePath:chromium.executablePath(),args:['--no-sandbox','--enable-precise-memory-info']});
  const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[],reads=[],checks=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',async response=>{
    if(response.url()!==base+'/api/charts/data')return;
    try {const query=response.request().postDataJSON(),data=await response.json();reads.push({query,data,status:response.status()});}catch{}
  });
  try {
    await page.goto(base+'/advanced-charts');
    await page.getByLabel('管理员密码').fill(fs.readFileSync(privateDir+'/password','utf8'));
    await page.getByRole('button',{name:'登录工作台'}).click();
    await expect(page.getByLabel('管理员密码')).toHaveCount(0);
    await expect.poll(()=>page.frames().some(frame=>frame.url().startsWith(origin+'/?')),{timeout:30000}).toBe(true);
    let host=page.frames().find(frame=>frame.url().startsWith(origin+'/?'));
    await host.waitForFunction(()=>ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:60000});
    await host.evaluate(()=>widget.setLayout('1'));
    await host.waitForFunction(()=>widget.chartsCount()===1&&widget.activeChart().dataReady(),null,{timeout:30000});
    await host.evaluate(()=>new Promise(resolve=>widget.activeChart().setSymbol('MWP:BTCUSDT',resolve)));
    await host.evaluate(()=>new Promise(resolve=>widget.activeChart().setResolution('5',resolve)));
    await host.evaluate(async()=>{
      for(const study of widget.activeChart().getAllStudies())widget.activeChart().removeEntity(study.id);
      window.pendingIds=[];
      for(const name of ['LWMA','SWING_SR_V1','SUPERTREND_PINE_V1'])pendingIds.push(await widget.activeChart().createStudy('守望 Python '+name,false,false));
    });
    const data=()=>host.evaluate(()=>pendingIds.map(id=>{
      const chart=widget.activeChart(),study=chart._chartWidget.model().model().dataSourceForId(id);
      return {size:study.data().size(),last:study.data().last()?.value,inputs:chart.getStudyById(id).getInputValues(),styles:chart.getStudyById(id).getStyleValues()};
    }));
    await expect.poll(async()=>(await data()).every(study=>study.size>100),{timeout:60000}).toBe(true);
    const first=await data();
    assert.equal(first[0].inputs.find(i=>i.id==='period').value,5);
    assert.equal(first[0].styles.styles.plot0.color.toUpperCase(),'#FFFFFF');
    await expect.poll(()=>reads.some(r=>r.query.indicators?.length>=3)).toBe(true);
    const lwma=reads.flatMap(r=>r.data.indicators || []).filter(i=>i.name==='LWMA').at(-1);
    assert.equal(first[0].last[1],lwma.series[0].values.at(-1).value);
    await expect(host.locator('.mw-swing-card')).toHaveCount(1,{timeout:15000});
    assert.equal(await host.locator('.mw-swing-information').evaluate(n=>n.getBoundingClientRect().height),0);
    checks.push('real PostgreSQL/Python multi-output reads and native result values','LWMA period5/white','Swing card reserves no top height');
    await host.evaluate(()=>widget.activeChart().getStudyById(pendingIds[0]).setVisible(false));
    await expect.poll(()=>host.evaluate(()=>indicatorCoordinator.diagnostics().consumers)).toBe(2);
    await host.evaluate(()=>widget.activeChart().getStudyById(pendingIds[0]).setVisible(true));
    await expect.poll(()=>host.evaluate(()=>indicatorCoordinator.diagnostics().consumers)).toBe(3);
    await host.evaluate(()=>widget.activeChart().getStudyById(pendingIds[0]).setInputValues([{id:'period',value:7}]));
    await expect.poll(()=>reads.some(r=>r.query.indicators?.some(s=>s.name==='LWMA'&&s.params.period===7)),{timeout:30000}).toBe(true);
    await expect.poll(async()=>(await data())[0].last?.[1],{timeout:30000}).toBe(reads.flatMap(r=>r.data.indicators || []).filter(i=>i.name==='LWMA'&&i.params.period===7).at(-1).series[0].values.at(-1).value);
    const before=(await data())[0].size;
    await host.evaluate(()=>widget.activeChart().getTimeScale().setRightOffset(-400));
    await expect.poll(async()=>(await data())[0].size>=before).toBe(true);
    checks.push('hide/show releases demand','parameter change retains Python agreement','cached navigation retains curves');
    await host.evaluate(()=>{MWSyncCoordinator.configure({date:false,time:false,barWidth:false});widget.setLayout('5h');});
    await host.waitForFunction(()=>widget.chartsCount()===5&&Array.from({length:5},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:60000});
    await host.evaluate(async()=>{
      window.fiveSwing=[];
      for(let i=0;i<5;i++){
        const chart=widget.chart(i);for(const study of chart.getAllStudies())chart.removeEntity(study.id);
        fiveSwing.push(await chart.createStudy('守望 Python SWING_SR_V1',false,false,{high_strength:5,low_strength:6,statistics_position:'below_name'}));
      }
    });
    await expect.poll(()=>host.evaluate(()=>fiveSwing.every((id,i)=>widget.chart(i)._chartWidget.model().model().dataSourceForId(id).data().size()>20)),{timeout:60000}).toBe(true);
    await expect(host.locator('.mw-swing-card')).toHaveCount(5,{timeout:15000});
    for(const theme of ['Light','Dark']){
      await host.evaluate(theme=>widget.changeTheme(theme),theme);
      await expect.poll(()=>host.evaluate(()=>widget.getTheme().toLowerCase())).toBe(theme.toLowerCase());
      await host.locator('.mw-swing-card').first().locator('summary').click();
      await expect(host.locator('.mw-swing-card').first()).toHaveAttribute('open','');
      await host.locator('.mw-swing-card').first().locator('summary').click();
      await host.evaluate(()=>widget.chart(2).maximizeChart());
      await expect.poll(()=>host.evaluate(()=>widget.chart(2).isMaximized())).toBe(true);
      await expect(host.locator('.mw-swing-card-stack').nth(2)).toBeVisible();
      await page.screenshot({path:privateDir+'/swing-maximized-'+theme.toLowerCase()+'.png'});
      await host.evaluate(()=>widget.chart(2).restoreChart());
    }
    assert.equal(await host.locator('.mw-swing-information').evaluate(n=>n.getBoundingClientRect().height),0);
    await host.evaluate(()=>widget.chart(1).getStudyById(fiveSwing[1]).setInputValues([{id:'show_average_spacing',value:false}]));
    await expect(host.locator('.mw-swing-card')).toHaveCount(4);
    await host.waitForFunction(()=>!MWNativeNavigation.busy()&&!rangeGuard?.busy()&&!edgeGuard?.busy(),null,{timeout:20000});
    await host.evaluate(()=>new Promise((resolve,reject)=>widget.saveChartToServer(resolve,reject)));
    await page.reload();
    await expect.poll(()=>page.frames().some(frame=>frame.url().startsWith(origin+'/?')),{timeout:30000}).toBe(true);
    host=page.frames().find(frame=>frame.url().startsWith(origin+'/?'));
    await host.waitForFunction(()=>ready&&!loading&&widget.chartsCount()===5&&Array.from({length:5},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:60000});
    await expect(host.locator('.mw-swing-card')).toHaveCount(4,{timeout:60000});
    await page.screenshot({path:privateDir+'/five-swing-restored.png'});
    const saved=await host.evaluate(()=>Array.from({length:5},(_,i)=>widget.chart(i).getAllStudies().map(s=>widget.chart(i).getStudyById(s.id).getInputValues())).flat());
    assert.ok(saved.every(inputs=>inputs.find(i=>i.id==='statistics_position').value==='bottom_left'));
    assert.ok(saved.some(inputs=>inputs.find(i=>i.id==='show_average_spacing').value===false));
    assert.ok(saved.every(inputs=>inputs.find(i=>i.id==='high_strength').value===5&&inputs.find(i=>i.id==='low_strength').value===6));
    checks.push('five Swing panes: light/dark, collapse, maximize','saved migration and hidden choice preserve strengths','real saved workspace reload');
    assert.deepEqual(errors,[]);
    const evidence={environment:'Ubuntu task-owned Docker mw-pending-fixes-20261013; actual HTTP/API/PostgreSQL/Python and licensed chart',passed:true,checks,
      requests:reads.length,batchedReads:reads.filter(r=>r.query.indicators?.length>=3).length,errors};
    fs.writeFileSync(privateDir+'/docker-browser.json',JSON.stringify(evidence,null,2));console.log('PASS Docker pending fixes',JSON.stringify(evidence));
  }catch(error){console.error('DOCKER_STATE',JSON.stringify({errors,reads:reads.map(r=>({status:r.status,frame:r.query.timeframe,names:r.query.indicators?.map(i=>i.name),progress:r.data.indicator_progress,error:r.data.detail})),body:await page.locator('body').innerText()}));throw error;}
  finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
