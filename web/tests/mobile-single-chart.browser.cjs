// Pinned licensed engine, synthetic saved layout and feed; all network routed.
// Proves direct single-chart initialization and save/merge/reopen, without
// instantiating the original grid on mobile or writing any deployed workspace.
const {chromium} = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {hash} = require('./mobile-workspace-fixture.cjs');
const root = path.resolve(__dirname,'../..'), library = process.env.MW_PROBE_LIBRARY;
const output = process.env.MW_WORKSPACE_OUTPUT, fixture = process.env.MW_MOBILE_FIXTURE_FILE;
assert.ok(library && output && fixture,'Explicit private library, fixture and output required');
const original = JSON.parse(fs.readFileSync(fixture)).document;
const origin='https://mobile-single.invalid';
(async()=>{
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox']});
 const report={passed:false,cases:[],errors:[],external:[]};
 let source=structuredClone(original),single=true,index=1;
 try {
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  page.on('pageerror',e=>report.errors.push(e.stack));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==origin){report.external.push(url.origin);return route.abort();}
   if(url.pathname==='/'){
    let html=fs.readFileSync(path.join(__dirname,'fixtures/native-history.html'),'utf8');
    html=html.replace('<script>\n// Standalone','<script src="/mobile-chart-document.js"></script><script src="/fixture.js"></script><script>\n// Standalone');
    html=html.replace("symbol:'TEST',interval:","saved_data: fixtureDocument, symbol:undefined,interval:");
    html=html.replace('enabled_features:[',"enabled_features:['support_multicharts',");
    return route.fulfill({contentType:'text/html',body:html});
   }
   if(url.pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:'const fullDocument='+JSON.stringify(source)+';const fixtureDocument='+ (single?'MWMobileChartDocument.project(fullDocument,'+index+')':'fullDocument')+';'});
   const base=url.pathname.startsWith('/charting_library/')?library:path.join(root,'advanced-host');
   const relative=url.pathname.startsWith('/charting_library/')?url.pathname.slice('/charting_library/'.length):url.pathname.slice(1);
   const file=path.resolve(base,decodeURIComponent(relative));
   assert.ok(file.startsWith(path.resolve(base)+path.sep));
   if(!fs.existsSync(file))return route.fulfill({status:404});
   return route.fulfill({body:fs.readFileSync(file),contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});
  });
  async function open(){await page.goto(origin+'/?initialCount=1000');await page.waitForFunction(()=>ready && Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i)).every(c=>c.dataReady()));await page.evaluate(()=>rendered());}
  const capture=async i=>page.evaluate(i=>{
   const chart=widget.chart(i);
   return {symbol:chart.symbol(),resolution:chart.resolution(),type:chart.chartType(),
    studies:chart.getAllStudies().map(({id,name})=>{const s=chart.getStudyById(id);return {id,name,inputs:s.getInputValues(),styles:s.getStyleValues(),visible:s.isVisible(),pane:s.paneIndex()};}),
    shapes:chart.getAllShapes().map(({id,name})=>{const s=chart.getShapeById(id);return {id,name,points:s.getPoints().map(p=>name==='horizontal_line'?{price:p.price}:p),properties:s.getProperties()};})};
  },i);
  single=false;await open();
  const expected=[];for(let i=0;i<4;i++)expected.push(await capture(i));
  assert.equal(await page.evaluate(()=>widget.chartsCount()),4);
  report.cases.push({name:'desktop source baseline loads four charts'});
  single=true;
  for(index of [1,3,0]){
   await open();assert.equal(await page.evaluate(()=>widget.chartsCount()),1);
   assert.deepEqual(await capture(0),expected[index]);
   report.cases.push({name:'direct single-chart constructor preserves chart '+(index+1)});
  }
  index=1;await open();
  await page.evaluate(async()=>{
   const c=widget.chart(0);
   await c.createStudy('Relative Strength Index',false,false,{length:9});
   await c.createMultipointShape([{time:END/1000-6*300,price:99},{time:END/1000-3*300,price:103}],{shape:'trend_line',overrides:{linecolor:'#aa00ff',linewidth:3}});
   const study=c.getAllStudies().find(s=>s.name==='Relative Strength Index');
   await c.createShape({time:END/1000-5*300,price:55},{shape:'horizontal_line',ownerStudyId:study.id});
  });
  await page.evaluate(()=>rendered());
  const edited=await capture(0);
  source=await page.evaluate(async()=>{
   const saved=await new Promise(resolve=>widget.save(resolve,{includeDrawings:true}));
   return MWMobileChartDocument.merge(fullDocument,1,saved);
  });
  for(const i of [0,2,3])assert.equal(hash(source.charts[i]),hash(original.charts[i]),'other chart changed');
  for(const key of Object.keys(original).filter(k=>!['charts','studyMetaInfoMap'].includes(k)))assert.equal(hash(source[key]),hash(original[key]),'workspace metadata changed: '+key);
  await open();assert.deepEqual(await capture(0),edited);
  report.cases.push({name:'single-chart save/merge/reopen preserves indicator pane and its drawing, main drawings and study settings; other charts/layout unchanged'});
  single=false;await open();assert.equal(await page.evaluate(()=>widget.chartsCount()),4);
  assert.deepEqual(await capture(1),edited);
  for(const i of [0,2,3])assert.deepEqual(await capture(i),expected[i]);
  report.cases.push({name:'merged workspace reopens through ordinary four-chart constructor'});
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);report.passed=true;
 }catch(e){report.failure=e.stack;process.exitCode=1;}
 finally{await browser.close();fs.writeFileSync(path.join(output,'single-chart-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
})();
