const {root, configuration, fixtureServer, nativePage, application, chromium, expect, fs, path} = require('./swing-notice-support.cjs');
const assert = require('node:assert/strict');
(async () => {
  const config = configuration(), server = await fixtureServer();
  const browser = await chromium.launch({args:['--no-sandbox']});
  const result = {source:'synthetic deterministic candles / real Python calculator / licensed native chart; real Docker application smoke', cases:[], passed:false};
  const record = name => {result.cases.push(name);console.log('PASS',name);};
  const savedStudy = state => state.charts[0].panes.flatMap(p=>p.sources).find(s=>s.type==='Study' && s.metaInfo?.id?.startsWith('MWPythonSWING'));
  try {
    // Generate compatibility inputs through unmodified v1.28.0 APIs, never handcraft saved native state.
    let page = await nativePage(browser, server.url+'/fixture.html?baseline&precision=2');
    const legacy = await page.evaluate(async () => {
      const c=widget.activeChart(), s=c.getStudyById(studyId);
      s.setInputValues([{id:'high_strength',value:3},{id:'low_strength',value:7},{id:'show_average_spacing',value:false}]);
      s.applyOverrides({'high.color':'#123456','high.linewidth':4,'high_left.visible':false,precision:3});
      return {workspace:await new Promise(r=>widget.save(r)),template:c.createStudyTemplate({saveSymbol:false,saveInterval:false}),styles:s.getStyleValues(),inputs:s.getInputValues()};
    });
    assert.equal(savedStudy(legacy.workspace).state.precision,3);
    fs.writeFileSync(path.join(root,'artifacts/swing-legacy-workspace.json'),JSON.stringify(legacy.workspace));
    fs.writeFileSync(path.join(root,'artifacts/swing-legacy-template.json'),JSON.stringify(legacy.template));
    await page.close();record('v1.28.0 real save/template input with precision override and nondefault settings');
    const inspect = () => page.evaluate(() => {
      const c=widget.activeChart(),s=c.getStudyById(c.getAllStudies()[0].id),doc=document.querySelector('iframe').contentDocument;
      const text=doc.body.innerText, raw=fixture.result.presentation.current;
      const legend=Array.from(doc.querySelectorAll('[data-entity-id="'+c.getAllStudies()[0].id+'"] [data-test-id-value-title]')).filter(n=>n.getClientRects().length).map(n=>({plot:n.dataset.testIdValueTitle,text:n.textContent}));
      return {legend,styles:s.getStyleValues().styles, main:[c.priceFormatter().format(raw.high.price),c.priceFormatter().format(raw.low.price)], text, inputs:s.getInputValues(),shapes:c.getAllShapes().map(x=>c.getShapeById(x.id).getPoints())};
    });
    const checkLabels = async () => {
      await expect.poll(async()=>{const s=await inspect(),names=['high','high_left','low','low_left'];const expected=[[0,1],[2,3]].map(pair=>pair.find(i=>s.styles['plot'+i].visible!==false)).filter(i=>i!==undefined).map(i=>names[i]);return JSON.stringify(s.legend.map(x=>x.plot))===JSON.stringify(expected);}).toBe(true);
      const state=await inspect();
      for(const pair of [[0,1],[2,3]]) {
        const owner=pair.find(i=>state.styles['plot'+i].visible!==false);
        for(const i of pair) assert.equal(state.styles['plot'+i].display&12,i===owner?12:0);
      }
      return state;
    };
    for(const query of ['precision=2','precision=3','precision=5','precision=2&custom']) {
      page=await nativePage(browser,server.url+'/fixture.html?'+query);
      await expect.poll(async()=>{const s=await inspect();return s.main.every(t=>s.text.includes(t));}).toBe(true);
      let state=await checkLabels();assert.deepEqual(state.legend.map(x=>x.plot),['high','low']);assert.deepEqual(state.legend.map(x=>x.text),state.main);assert.equal(Object.keys(state.styles).length,4);assert.equal(state.shapes.length,2);
      await page.screenshot({path:path.join(config.output,'swing-'+query.replaceAll(/[^a-z0-9]/g,'-')+'.png')});
      record('formatter and native labels '+query);
      if(query==='precision=2') {
        for(const [tick,places] of [['1000,1,false',3],['100000,1,false',5],['default',2]]) {
          await page.evaluate(t=>widget.activeChart().applyOverrides({'mainSeriesProperties.minTick':t}),tick);
          await expect.poll(async()=>{const s=await inspect();return s.main.every(t=>s.text.includes(t)&&t.split('.').at(-1).length===places);}).toBe(true);
        }record('manual precision 3/5 then automatic');
        for(const symbol of ['XAUUSD_THREE','MWC:XAUUSD_FIVE','XAUUSD']) {
          await page.evaluate(s=>new Promise(r=>widget.activeChart().setSymbol(s,r)),symbol);
          await expect.poll(async()=>{const s=await inspect();return s.main.every(t=>s.text.includes(t));}).toBe(true);
        }record('symbol and series identity switching');
        for(const hidden of [0,1,2,3]) {
          await page.evaluate(i=>{const s=widget.activeChart().getStudyById(studyId);for(const [n,name] of ['high','high_left','low','low_left'].entries())s.applyOverrides({[name+'.visible']:n!==i});display.refresh();},hidden);
          const s=await checkLabels();assert.equal(s.styles['plot'+hidden].visible,false);
        }
        await page.evaluate(()=>{const s=widget.activeChart().getStudyById(studyId);s.applyOverrides({'high.visible':false,'high_left.visible':false});display.refresh();});
        state=await checkLabels();assert.equal(state.styles.plot0.visible,false);assert.equal(state.styles.plot1.visible,false);
        await page.evaluate(()=>{widget.activeChart().getStudyById(studyId).applyOverrides({'high.visible':true,'high_left.visible':true,'low.visible':false,'low_left.visible':false});display.refresh();});
        state=await checkLabels();assert.equal(state.styles.plot2.visible,false);assert.equal(state.styles.plot3.visible,false);
        await page.evaluate(()=>{widget.activeChart().getStudyById(studyId).applyOverrides({'high.visible':false,'high_left.visible':false});display.refresh();});
        assert.deepEqual((await checkLabels()).legend,[]);
        record('each plot hidden / both plots hidden preserve visibility and transfer labels');
        await page.evaluate(()=>{snapshots.clear();const s=widget.activeChart().getStudyById(studyId);s.setInputValues([{id:'show_average_spacing',value:false}]);s.applyOverrides({'high.visible':true,'high_left.visible':true,'low.visible':false,'low_left.visible':true});display.refresh();});
        await checkLabels();record('normalization with statistics off and no snapshot');
        for(const kind of ['workspace','template']) {
          await page.evaluate(({kind,value})=>{if(kind==='workspace')widget.load(value);else widget.activeChart().applyStudyTemplate(value);},{kind,value:legacy[kind]});
          await expect.poll(async()=>{const s=await inspect();return s.styles.plot0.color==='#123456' && s.styles.plot1.visible===false;},{timeout:15000}).toBe(true);
          await page.waitForTimeout(400);const restored=await checkLabels();
          assert.equal(restored.styles.plot0.linewidth,4);assert.deepEqual(restored.inputs,legacy.inputs);
          const saved=await page.evaluate(()=>new Promise(r=>widget.save(r)));
          assert.equal(savedStudy(saved).state.precision,'default');
          await page.evaluate(s=>widget.load(s),saved);await page.waitForTimeout(500);
          const twice=await checkLabels();
          assert.equal(twice.styles.plot0.color,'#123456');assert.equal(twice.styles.plot0.linewidth,4);
          assert.equal(twice.styles.plot1.visible,false);assert.deepEqual(twice.inputs,legacy.inputs);
          record('legacy '+kind+' restore and second save/reload preserve settings');
        }
        await page.evaluate(async()=>{await widget.activeChart().createStudy('守望 Python SWING_SR_V1',false,false);widget.setLayout('2h');});
        await page.waitForFunction(()=>widget.chartsCount()===2);
        await page.evaluate(()=>widget.chart(1).createStudy('守望 Python SWING_SR_V1',false,false));
        await expect.poll(()=>page.evaluate(()=>Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i).getAllStudies().length).every(n=>n>=1))).toBe(true);
        await page.waitForTimeout(500);
        const independent=await page.evaluate(()=>Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i).getAllStudies().map(x=>widget.chart(i).getStudyById(x.id).getStyleValues().styles)));
        for(const chart of independent) for(const styles of chart) {
          assert.equal(Object.values(styles).filter(s=>s.visible!==false&&(s.display&12)===12).length,2);
        }
        await page.evaluate(async()=>{widget.symbolSync().setValue(false);await new Promise(r=>widget.chart(1).setSymbol('XAUUSD_THREE',r));});
        await expect.poll(()=>page.evaluate(()=>[widget.chart(0).priceFormatter().format(2700.12345),widget.chart(1).priceFormatter().format(2700.12345)]),{timeout:15000}).toEqual(['2,700.12','2,700.123']);
        await expect.poll(async()=>{
          result.independentCharts=await page.evaluate(()=>{
          return Array.from({length:widget.chartsCount()},(_,i)=>{
            const chart=widget.chart(i);
            const container=chart._chartWidget.paneWidgets().find(pane=>pane.containsMainSeries()).canvasElement().closest('.chart-container');
            return chart.getAllStudies().map(study=>{
              const inputs=Object.fromEntries(chart.getStudyById(study.id).getInputValues().map(item=>[item.id,item.value]));
              const params={high_strength:inputs.high_strength,low_strength:inputs.low_strength};
              const result=fixture.variants[JSON.stringify(params)]||fixture.result;
              const expected=['high','low'].map(side=>chart.priceFormatter().format(result.presentation.current[side].price));
              const values=Array.from(container.querySelectorAll('[data-entity-id="'+study.id+'"] [data-test-id-value-title]')).filter(n=>n.getClientRects().length).map(n=>n.textContent);
              return {chart:i,study:study.id,expected,values};
            });
          }).flat();
          });
          return result.independentCharts.every(row=>JSON.stringify(row.values)===JSON.stringify(row.expected));
        },{timeout:15000}).toBe(true);
        record('multiple study instances and two native charts with independent precision');
      }
      await page.close();
    }
    const app=await application(browser,config);
    for(const file of ['indicators.js','swing-sr-display.js']) {
      const response=await app.page.request.get(config.chart+'/'+file);
      assert.equal(response.status(),200);assert.equal(await response.text(),fs.readFileSync(path.join(root,'advanced-host',file),'utf8'),'running candidate asset '+file);
    }
    const id=await app.host.evaluate(()=>widget.activeChart().createStudy('守望 Python SWING_SR_V1',false,false));
    await expect.poll(()=>app.host.evaluate(id=>{const styles=widget.activeChart().getStudyById(id).getStyleValues().styles;return Object.values(styles).filter(s=>(s.display&12)===12).length;},id),{timeout:30000}).toBe(2);
    const rendered=app.native().locator('[data-entity-id="'+id+'"] [data-test-id-value-title]:visible');
    await expect(rendered).toHaveCount(2,{timeout:60000});
    await expect.poll(async()=> (await rendered.allTextContents()).every(text=>/[0-9]/.test(text)),{timeout:90000}).toBe(true);
    result.liveSwing={values:await rendered.allTextContents(),styles:await app.host.evaluate(id=>widget.activeChart().getStudyById(id).getStyleValues(),id)};
    const actual=await app.host.evaluate(()=>({charts:widget.chartsCount(),studies:Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i).getAllStudies().map(x=>({name:x.name,styles:widget.chart(i).getStudyById(x.id).getStyleValues().styles}))),format:widget.activeChart().priceFormatter().format(2700.12345)}));
    result.application=actual;
    // Keep the actual workspace's provider series identity when changing the
    // instrument. Bare XAUUSD selects the separate managed dataset.
    await app.host.evaluate(()=>new Promise(r=>widget.activeChart().setSymbol('MWP:XAUUSD',r)));
    await expect.poll(async()=>{const values=await rendered.allTextContents();return values.length===2 && values.every(text=>Number(text.replaceAll(',',''))>100);},{timeout:120000}).toBe(true);
    const goldValues=await rendered.allTextContents();
    const goldFormatted=await app.host.evaluate(values=>values.map(text=>widget.activeChart().priceFormatter().format(Number(text.replaceAll(',','')))),goldValues);
    assert.deepEqual(goldValues,goldFormatted,'actual XAUUSD Swing text uses the current main formatter');
    result.liveXAUUSD={values:goldValues,mainFormatted:goldFormatted};
    record('mw-acceptance actual EURUSD/XAUUSD Swing rendering and exact candidate assets');
    await app.page.screenshot({path:path.join(config.output,'swing-mwa.png')});await app.context.close();
    result.passed=true;
  } catch(error) {result.failure=error.stack;throw error;}
  finally {fs.writeFileSync(path.join(config.output,'swing-price-presentation.json'),JSON.stringify(result,null,2));await browser.close();await server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
