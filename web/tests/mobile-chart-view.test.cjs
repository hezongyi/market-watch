const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../advanced-host/mobile-chart-view.js'), 'utf8');
function fixture({delay} = {}) {
  const ctx = vm.createContext({structuredClone, setTimeout, clearTimeout,requestAnimationFrame:callback=>setTimeout(callback,0)}); vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../../advanced-host/mobile-chart-document.js'),'utf8'),ctx); vm.runInContext(source, ctx);
  const document = {charts: [0,1,2,3].map(n=>({n,version:3,panes:[{sources:[{type:'MainSeries',state:{symbol:'symbol-'+n,interval:n%2?'5':'60'}}]}]})), _mwAlertCharts: ['a','b','c','d']};
  let charts = document.charts.slice(), active = 0, loads = 0;
  const chart = n => ({symbol: () => 'symbol-' + n, resolution: () => n % 2 ? '5' : '60',
    chartType: () => 1, getAllStudies: () => [{id: 'study-' + n, name: 'MA'}],
    getStudyById: () => ({getInputValues: () => [{id: 'length', value: n + 10}], getStyleValues: () => ({color: n})}),
    getAllShapes: () => [{id: 'line-' + n, name: 'horizontal_line'}],
    getShapeById: () => ({getPoints: () => [{time: 100, price: n}], getProperties: () => ({color: n}), setProperties: () => {}}),
    createStudyTemplate: () => ({template: n}),
    getSeries: () => ({chartStyleProperties: () => ({}), setChartStyleProperties: () => {}}),
    getVisibleRange: () => ({from: 1, to: 2}),
    getTimeScale: () => ({barSpacing: () => 6, rightOffset: () => 10, setBarSpacing: () => {}, setRightOffset: () => {}}),
    dataReady: () => true, setSymbol: async () => true, setResolution: async () => true,
    setChartType: (_, done) => done(), removeAllStudies: () => {}, removeAllShapes: () => {},
    applyStudyTemplate: () => {}, createShape: async () => 'new-shape', createMultipointShape: async () => 'new-shape',
    setVisibleRange: async () => {}});
  const listeners = new Map();
  const widget = {chartsCount: () => charts.length, chart: i => chart(charts[i].n), activeChartIndex: () => active,
    load: async state => {assert.equal(state.charts.length,1,'mobile load instantiated a grid');loads++; if (delay) await delay(); charts = state.charts.slice(); active = 0;},
    setActiveChart: i => {active = i;}, setLayout: () => {throw Error('mobile must never collapse a grid');},
    subscribe: (event, callback) => {const rows = listeners.get(event) || []; rows.push(callback); listeners.set(event, rows);},
    unsubscribe: (event, callback) => listeners.set(event, (listeners.get(event) || []).filter(item => item !== callback)),
    unloadUnusedCharts: () => {}, save: cb => cb({charts: charts.slice()})};
  const api = ctx.createMobileChartView({widget, workspace: {id: 'w1', revision: 7, name: 'W1'}, document});
  api.buildDirectory(document);
  return {api, document, loads: () => loads, widget};
}
test('select second/fourth original identity without mutating saved document', async () => {
  const f = fixture(), before = JSON.stringify(f.document);
  assert.equal(await f.api.select(1), true);
  assert.equal(f.api.state().selected.original_chart_id, 'b');
  assert.equal(f.api.indexForAssociation({workspace_id: 'w1', chart_id: 'b'}), 1);
  assert.equal(f.api.indexForAssociation({workspace_id: 'w1', chart_id: 'wrong', chart_index: 1}), null);
  assert.equal(f.api.indexForAssociation({workspace_id: 'other', chart_id: 'b'}), null);
  assert.equal(f.api.matches({workspace_id: 'w1', chart_id: 'a', chart_index: 0}), false);
  assert.equal(await f.api.select(3), true);
  assert.equal(f.api.state().selected.original_index, 3);
  assert.equal(f.api.state().revision, 7);
  assert.equal(JSON.stringify(f.document), before);
});
test('temporary exploration unbinds original association', async () => {
  const {api} = fixture(); await api.select(1);
  const a = {workspace_id: 'w1', chart_id: 'b'};
  assert.equal(api.matches(a), true); api.explore(); assert.equal(api.matches(a), false);
  await api.select(1); assert.equal(api.matches(a), true);
});
test('repeated alert inspection stays in one chart and returns to the first captured view without loading the original grid', async () => {
  const f=fixture(),before=JSON.stringify(f.document);
  await f.api.select(1);const loads=f.loads();
  const target=await f.api.openTemporary({symbol:'alert-one',resolution:'5'});
  assert.equal(target.current(),true);assert.equal(f.api.state().temporary,true);
  assert.equal(f.api.state().selected,null);assert.equal(f.api.matches({workspace_id:'w1',chart_id:'b'}),false);
  await f.api.openTemporary({symbol:'alert-two',resolution:'60'});
  assert.equal(target.current(),false);assert.equal(f.loads(),loads,'temporary inspection must not reload a grid');
  await f.api.restoreTemporary();
  assert.equal(f.api.state().selected.original_index,1);assert.equal(f.api.state().temporary,false);
  assert.equal(f.api.state().exploring,false);assert.equal(f.loads(),loads+1);
  assert.equal(JSON.stringify(f.document),before);
});
test('return from alert inspection preserves an earlier exploratory view and invalidates its pending marker', async () => {
  const {api}=fixture();await api.select(1);api.explore();
  const target=await api.openTemporary({symbol:'alert',resolution:'5'});
  await api.restoreTemporary();assert.equal(target.current(),false);
  assert.equal(api.state().exploring,true);assert.equal(api.matches({workspace_id:'w1',chart_id:'b'}),false);
  assert.equal(api.state().temporary,false);
});
test('A→B→A only commits newest selection', async () => {
  const {api} = fixture();
  const results = await Promise.all([api.select(0), api.select(1), api.select(0)]);
  assert.deepEqual(results, [false, false, true]);
  assert.equal(api.state().selected.original_index, 0);
});
test('disposal fences pending load and further selections', async () => {
  let release; const f = fixture({delay: () => new Promise(resolve => {release = resolve;})});
  const task = f.api.select(1); while(!release)await new Promise(resolve=>setTimeout(resolve,0)); f.api.dispose(); release();
  assert.equal(await task, false); assert.equal(await f.api.select(0), false);
  assert.equal(f.api.state().selected, null);
});
test('rejects an unsupported layout instead of silently dropping chart state', () => {
  const ctx=vm.createContext({structuredClone});vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../../advanced-host/mobile-chart-document.js'),'utf8'),ctx);
  assert.throws(()=>ctx.MWMobileChartDocument.project({charts:[{version:99,panes:[]}]},0),/格式不支持/);
});
test('missing original chart cannot start load', async () => {
  const f = fixture(); await assert.rejects(f.api.select(9), /原图格不存在/);
  assert.equal(f.loads(), 0);
});
test('merge adds new study definitions but refuses to replace shared definitions', () => {
  const ctx=vm.createContext({structuredClone});vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../../advanced-host/mobile-chart-document.js'),'utf8'),ctx);
  const {document}=fixture();document.studyMetaInfoMap={shared:{version:1}};
  const single=ctx.MWMobileChartDocument.project(document,1);
  single.studyMetaInfoMap.added={version:2};
  const result=ctx.MWMobileChartDocument.merge(document,1,single);
  assert.equal(result.studyMetaInfoMap.added.version,2);
  assert.equal(document.studyMetaInfoMap.added,undefined);
  single.studyMetaInfoMap.shared.version=3;
  assert.throws(()=>ctx.MWMobileChartDocument.merge(document,1,single),/指标定义已变化/);
  assert.equal(document.studyMetaInfoMap.shared.version,1);
});
