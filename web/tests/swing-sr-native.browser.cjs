// Local file capability probe. This does not replace Docker application acceptance.
const {chromium}=require('@playwright/test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,
  executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args:['--no-sandbox','--allow-file-access-from-files']});
 const page=await browser.newPage({viewport:{width:1600,height:950}});
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error') {console.log('CONSOLE',m.text().slice(0,350));
  if(m.text().startsWith('DISPLAY')) errors.push(m.text());}});
 try {
  await page.goto('file://'+path.resolve(__dirname,'fixtures/swing-sr-native.html'));
  await page.waitForFunction(()=>ready && widget.activeChart().dataReady(),null,{timeout:45000});
  await page.waitForFunction(()=>document.querySelector('.mw-swing-row')?.textContent.includes('高点 15根'),null,{timeout:20000});
  await page.waitForFunction(()=>widget.activeChart().getAllShapes().length===2,null,{timeout:20000});
  const state=await page.evaluate(()=>({studies:widget.activeChart().getAllStudies(),
   shapes:widget.activeChart().getAllShapes().map(shape=>({id:shape.id,points:widget.activeChart().getShapeById(shape.id).getPoints()})),
   inputs:widget.activeChart().getStudyById(studyId).getInputValues(),text:document.querySelector('.mw-swing-row').textContent}));
  assert.equal(state.shapes.length,2);
  assert.ok(state.shapes.every(shape=>shape.points.length===2 && shape.points[0].price===shape.points[1].price));
  assert.ok(state.text.includes('低点 16根'));
  const projection=await page.evaluate(()=>captureDrawingProjection(widget));
  assert.equal(projection.charts[0].drawings.length,0,'derived bridges must be excluded from the application projection');
  const userShape=await page.evaluate(()=>widget.activeChart().createShape({price:1.12},{shape:'horizontal_line'}));
  const userProjection=await page.evaluate(()=>captureDrawingProjection(widget));
  assert.deepEqual(userProjection.charts[0].drawings.map(drawing=>drawing.id),[userShape],'ordinary user drawings remain projected');
  await page.evaluate(id=>widget.activeChart().removeEntity(id),userShape);
  const saved=await page.evaluate(()=>new Promise(resolve=>widget.save(resolve)));
  assert.ok(state.shapes.every(shape=>!JSON.stringify(saved).includes(shape.id)),'derived bridges must not enter native workspace state');
  await page.screenshot({path:path.resolve(__dirname,'../../artifacts/swing-native-dark.png')});
  await page.evaluate(()=>widget.activeChart().getStudyById(studyId).setInputValues([{id:'statistics_position',value:'bottom_left'}]));
  await page.waitForFunction(()=>document.querySelector('.mw-swing-card'));
  const bounds=await page.evaluate(()=>{const row=document.querySelector('.mw-swing-card'),root=document.getElementById('chart');
   return {card:row.getBoundingClientRect().toJSON(),pane:swingPaneBounds(widget.activeChart(),root),root:root.getBoundingClientRect().toJSON()};});
  assert.ok(bounds.card.top>=bounds.root.top+bounds.pane.top);
  assert.ok(bounds.card.bottom<=bounds.root.top+bounds.pane.top+bounds.pane.height);
  await page.screenshot({path:path.resolve(__dirname,'../../artifacts/swing-native-card.png')});
  await page.evaluate(()=>widget.activeChart().getStudyById(studyId).setInputValues([{id:'show_average_spacing',value:false}]));
  await page.waitForFunction(()=>!document.querySelector('.mw-swing-row'));
  assert.equal(await page.evaluate(()=>widget.activeChart().getAllShapes().length),2);
  await page.evaluate(()=>widget.activeChart().getStudyById(studyId).setInputValues([{id:'show_average_spacing',value:true}]));
  await page.waitForFunction(()=>document.querySelector('.mw-swing-card'));
  await page.evaluate(()=>{globalThis.template=widget.activeChart().createStudyTemplate({saveSymbol:false,saveInterval:false});
   widget.activeChart().removeEntity(studyId);});
  await page.waitForFunction(()=>!document.querySelector('.mw-swing-row'));
  await page.evaluate(()=>widget.activeChart().applyStudyTemplate(template));
  await page.waitForFunction(()=>document.querySelector('.mw-swing-card'));
  const restored=await page.evaluate(()=>widget.activeChart().getStudyById(widget.activeChart().getAllStudies()[0].id).getInputValues());
  assert.equal(restored.find(i=>i.id==='statistics_position').value,'bottom_left');
  assert.equal(restored.find(i=>i.id==='show_average_spacing').value,true);
  await page.evaluate(()=>{studyId=widget.activeChart().getAllStudies()[0].id;
   widget.activeChart().getStudyById(studyId).setInputValues([{id:'high_strength',value:3},{id:'low_strength',value:7}]);});
  await page.waitForFunction(()=>document.querySelector('.mw-swing-row')?.textContent.includes('Swing 3 7'));
  await page.evaluate(()=>widget.activeChart().getStudyById(studyId).setInputValues([{id:'high_strength',value:5},{id:'low_strength',value:5}]));
  await page.waitForFunction(()=>document.querySelector('.mw-swing-row')?.textContent.includes('Swing 5 5'));
  await page.evaluate(()=>preview(fixture.withdrawn));
  await page.waitForFunction(()=>widget.activeChart().getAllShapes().some(s=>widget.activeChart().getShapeById(s.id).getPoints()[0].price===1.1276));
  await page.evaluate(()=>preview(fixture.result));
  await page.waitForFunction(()=>widget.activeChart().getAllShapes().some(s=>widget.activeChart().getShapeById(s.id).getPoints()[0].price===1.1242));
  assert.equal(await page.evaluate(()=>widget.activeChart().getAllShapes().length),2,'candidate replaces bridge without duplicates');
  await page.evaluate(()=>preview(fixture.confirmed));
  await page.waitForFunction(()=>document.querySelector('.mw-swing-details')?.textContent.includes('高点 264（预览 0）'));
  assert.equal(await page.evaluate(()=>widget.activeChart().getAllShapes().length),2,'confirmation must not duplicate the candidate bridge');
  await page.evaluate(()=>preview(fixture.result));
  await page.evaluate(()=>widget.activeChart().getStudyById(studyId).setVisible(false));
  await page.waitForFunction(()=>!document.querySelector('.mw-swing-row'));
  await page.evaluate(()=>widget.activeChart().getStudyById(studyId).setVisible(true));
  await page.waitForFunction(()=>document.querySelector('.mw-swing-row'));
  const second=await page.evaluate(()=>widget.activeChart().createStudy('守望 Python SWING_SR_V1',false,false));
  await page.waitForFunction(()=>document.querySelectorAll('.mw-swing-row').length===2);
  const rows=await page.evaluate(()=>Array.from(document.querySelectorAll('.mw-swing-row'),row=>row.getBoundingClientRect().toJSON()));
  assert.ok(rows[0].bottom<=rows[1].top || rows[1].bottom<=rows[0].top,'same-pane statistics must not overlap');
  await page.evaluate(id=>widget.activeChart().removeEntity(id),second);
  await page.waitForFunction(()=>document.querySelectorAll('.mw-swing-row').length===1);
  await page.evaluate(()=>widget.setLayout('2h'));
  await page.waitForFunction(()=>widget.chartsCount()===2);
  await page.evaluate(()=>widget.chart(1).createStudy('守望 Python SWING_SR_V1',false,false));
  await page.waitForFunction(()=>document.querySelectorAll('.mw-swing-row').length>=2);
  const charts=await page.evaluate(()=>Array.from({length:widget.chartsCount()},(_,index)=>({index,
   studies:widget.chart(index).getAllStudies(),shapes:widget.chart(index).getAllShapes(),
   bounds:swingPaneBounds(widget.chart(index),document.getElementById('chart'))})));
  assert.ok(charts.every(chart=>chart.shapes.length>=2),'both native charts own bridges');
  await page.screenshot({path:path.resolve(__dirname,'../../artifacts/swing-native-two-charts.png')});
  await page.evaluate(()=>widget.setLayout('s'));
  await page.waitForFunction(()=>widget.chartsCount()===1);
  await page.evaluate(()=>widget.changeTheme('Light'));
  await page.setViewportSize({width:375,height:844});
  await page.waitForFunction(()=>document.querySelector('.mw-swing-card') &&
   document.querySelector('.mw-swing-card').getBoundingClientRect().right<=innerWidth);
  await page.screenshot({path:path.resolve(__dirname,'../../artifacts/swing-native-narrow-light.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:1600,height:950});
  const legacy=await page.evaluate(async()=>{
   for(const item of widget.activeChart().getAllStudies()) widget.activeChart().removeEntity(item.id);
   for(const name of Object.keys(fixture.legacy)) await widget.activeChart().createStudy('守望 Python '+name,false,false);
   const expected=widget.activeChart().getAllStudies().map(item=>({name:item.name,
    inputs:widget.activeChart().getStudyById(item.id).getInputValues()}));
   const template=widget.activeChart().createStudyTemplate({saveSymbol:false,saveInterval:false});
   widget.activeChart().applyStudyTemplate(template);
   return expected;
  });
  await page.waitForFunction(()=>widget.activeChart().getAllStudies().length===8);
  const legacyRestored=await page.evaluate(()=>widget.activeChart().getAllStudies().map(item=>({name:item.name,
   inputs:widget.activeChart().getStudyById(item.id).getInputValues()})));
  assert.deepEqual(legacyRestored,legacy,'all eight Python studies retain persisted inputs');
  assert.deepEqual(errors,[]);
  const result={passed:true,scope:'native local-file capability probe; Docker application acceptance pending',state,bounds,restored,charts,legacy};
  fs.writeFileSync(path.resolve(__dirname,'../../artifacts/swing-native-probe.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:true,checks:['circles','bridges','statistics','hide','native-template','parameters','rollback','visibility','multiple-instances','two-charts','narrow-light','legacy-8-templates'],errors}));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
