// Licensed native API probe with synthetic Python output; no acceptance instance writes.
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
 page.on('console',m=>{if(m.type()==='error' && m.text().startsWith('DISPLAY'))errors.push(m.text());});
 const snapshot=()=>page.evaluate(()=>widget.activeChart().getAllShapes().map(s=>({
  id:s.id,name:s.name,points:widget.activeChart().getShapeById(s.id).getPoints(),
  properties:widget.activeChart().getShapeById(s.id).getProperties()})));
 const ready=()=>page.waitForFunction(()=>widget.activeChart().getAllShapes().length===
  fixture.result.presentation.boxes.length+fixture.result.presentation.labels.length,null,{timeout:20000});
 try {
  await page.goto('file://'+path.resolve(__dirname,'fixtures/squeeze-native.html'));
  await page.waitForFunction(()=>ready && widget.activeChart().dataReady(),null,{timeout:45000});
  await ready();
  const shapes=await snapshot();
  const expected=await page.evaluate(()=>fixture.result.presentation);
  const rectangles=shapes.filter(s=>s.name==='rectangle');
  assert.equal(rectangles.length,expected.boxes.length);
  for(const box of expected.boxes)assert.ok(rectangles.some(s=>s.points[0].time===box.left_chart_time/1000 &&
   s.points[0].price===box.top && s.points[1].time===box.right_chart_time/1000 && s.points[1].price===box.bottom));
  const labels=shapes.filter(s=>s.name==='balloon');
  assert.equal(labels.length,expected.labels.length);
  assert.ok(labels.every(s=>s.properties.text.startsWith('PctRank: ')));
  const styles=await page.evaluate(()=>widget.activeChart().getStudyById(studyId).getStyleValues().styles);
  assert.equal(styles.plot0.color.toLowerCase(),'#2196f3');
  assert.equal(styles.plot0.linewidth,2);
  assert.ok([1,2,3,4].every(i=>styles['plot'+i].visible===false));
  const projection=await page.evaluate(()=>captureDrawingProjection(widget));
  assert.equal(projection.charts[0].drawings.length,0);
  const saved=await page.evaluate(()=>new Promise(resolve=>widget.save(resolve)));
  assert.ok(shapes.every(s=>!JSON.stringify(saved).includes(s.id)));
  await page.screenshot({path:path.resolve(__dirname,'../../artifacts/squeeze-native-dark.png')});
  await page.evaluate(()=>widget.activeChart().getStudyById(studyId).setInputValues([
   {id:'first_border_color',value:'#aa00ff'},{id:'sma_color',value:'#ff0000'}]));
  await page.waitForFunction(()=>widget.activeChart().getAllShapes().some(s=>
   widget.activeChart().getShapeById(s.id).getProperties().color==='#aa00ff'));
  await page.waitForFunction(()=>widget.activeChart().getStudyById(studyId).getStyleValues().styles.plot0.color==='#ff0000');
  await page.evaluate(()=>preview(fixture.withdrawn));
  await page.waitForFunction(()=> {
   const rectangles=widget.activeChart().getAllShapes().filter(s=>s.name==='rectangle')
    .map(s=>widget.activeChart().getShapeById(s.id).getPoints());
   return rectangles.length===fixture.withdrawn.presentation.boxes.length &&
    fixture.withdrawn.presentation.boxes.every(box=>rectangles.some(points=>
     points[0].time===box.left_chart_time/1000 && points[1].time===box.right_chart_time/1000 &&
     points[0].price===box.top && points[1].price===box.bottom));
  });
  await page.evaluate(()=>preview(fixture.result));await ready();
  await page.evaluate(()=>widget.activeChart().getStudyById(studyId).setVisible(false));
  await page.waitForFunction(()=>widget.activeChart().getAllShapes().length===0);
  await page.evaluate(()=>widget.activeChart().getStudyById(studyId).setVisible(true));await ready();
  await page.evaluate(()=>{globalThis.template=widget.activeChart().createStudyTemplate({saveSymbol:false,saveInterval:false});
   widget.activeChart().removeEntity(studyId);});
  await page.waitForFunction(()=>widget.activeChart().getAllShapes().length===0);
  await page.evaluate(()=>widget.activeChart().applyStudyTemplate(template));await ready();
  await page.evaluate(()=>{studyId=widget.activeChart().getAllStudies()[0].id;});
  assert.equal(await page.evaluate(()=>widget.activeChart().getStudyById(studyId).getInputValues().find(i=>i.id==='first_border_color').value),'#aa00ff');
  const second=await page.evaluate(()=>widget.activeChart().createStudy('守望 Python ROLLING_RANGE_SQUEEZE',false,false,fixture.params));
  await page.waitForFunction(()=>widget.activeChart().getAllShapes().length===2*(fixture.result.presentation.boxes.length+fixture.result.presentation.labels.length));
  await page.evaluate(id=>widget.activeChart().removeEntity(id),second);await ready();
  await page.evaluate(()=>widget.changeTheme('Light'));
  await page.setViewportSize({width:375,height:844});
  await page.screenshot({path:path.resolve(__dirname,'../../artifacts/squeeze-native-narrow-light.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.resolve(__dirname,'../../artifacts/squeeze-native-probe.json'),JSON.stringify({passed:true,
   scope:'local native probe; acceptance pending',shapes,styles,errors},null,2));
  console.log(JSON.stringify({passed:true,checks:['geometry','labels','styles','save-exclusion','colors','rollback','visibility','template','multiple-instances','narrow-light'],errors}));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
