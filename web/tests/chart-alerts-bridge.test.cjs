// Lifecycle and race tests through the shipped native adapter's public boundary.
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, "../..");
const tick = () => new Promise((r) => setTimeout(r, 5));
function fixture({ readonly = false, prepareLocate } = {}) {
  const subscriptions = {},
    shapes = new Map(),
    messages = [],
    calls = [],
    failures = [];
  let symbol = "BTCUSDT",
    resolution = "60",
    source = "binance",
    epoch = 1,
    loading = false,
    nextId = 0,
    priceScaleMode = 0;
  let history = {from:0,to:120}, rangeRelease;
  const event = () => {
    let fn;
    return {
      subscribe: (_ctx, cb) => {
        fn = cb;
      },
      unsubscribe: () => {},
      fire: () => fn?.(),
    };
  };
  const symbolEvent = event(),
    intervalEvent = event();
  function shape(id, points) {
    shapes.set(id, {
      points,
      properties: { extendLeft: false, extendRight: false },
      name: "horizontal_line",
      getPoints() {
        return this.points;
      },
      getProperties() {
        return this.properties;
      },
      setPoints(value) {
        this.points = value;
      },
      setProperties(value) {
        Object.assign(this.properties, value);
      },
    });
  }
  const chart = {
    symbol: () => symbol,
    priceFormatter: () => ({format: price => price.toFixed(5)}),
    symbolExt: () => ({}),
    resolution: () => resolution,
    chartType: () => 1,
    dataReady: () => true,
    setVisibleRange: async () => {if(rangeRelease) await rangeRelease;},
    getVisibleBarsRange: () => history,
    barTimeToEndOfPeriod: time => time+60,
    getVisibleRange: () => ({from:0,to:120}),
    getAllShapes: () => [...shapes].map(([id, s]) => ({ id, name: s.name })),
    getShapeById: (id) => shapes.get(id),
    getAllStudies: () => [],
    getPanes: () => [
      { getMainSourcePriceScale: () => ({ getMode: () => priceScaleMode }) },
    ],
    onSymbolChanged: () => symbolEvent,
    onIntervalChanged: () => intervalEvent,
    createShape: async (point, options) => {
      const id = "restored-" + ++nextId;
      shape(id, [point]);
      shapes.get(id).options=options;
      return id;
    },
  };
  const widget = {
    activeChart: () => chart,
    chartsCount: () => 1,
    chart: () => chart,
    subscribe: (name, cb) => (subscriptions[name] = cb),
    onContextMenu: () => {},
  };
  const ctx = vm.createContext({
    crypto: globalThis.crypto,
    structuredClone,
    setTimeout,
    Map,
    Set,
    MWSeries: {
      decode: (t) => ({ symbol: t, series_kind: "managed" }),
      encode: (t) => t,
      same: (a, b) => a === b,
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, "advanced-host/price-format.js"), "utf8"), ctx);
  vm.runInContext(
    fs.readFileSync(path.join(root, "advanced-host/chart-alerts.js"), "utf8"),
    ctx,
  );
  let row;
  let writeMode = "success",
    editRelease;
  const api = ctx.chartAlertBridge({
    getWidget: () => widget,
    getWorkspace: () => ({ id: "fixture" }),
    getEpoch: () => epoch,
    isLoading: () => loading,
    readonly,
    prepareLocate,
    metadata: () => ({ source }),
    calculationOrigin: () => 60000,
    frames: { 60: "H1", 5: "M5" },
    send: (m) => messages.push(structuredClone(m)),
    fail: (e) => failures.push(String(e)),
    rpc: async (q) => {
      calls.push(structuredClone(q));
      if (q.op === "geometry")
        return {
          kind: "horizontal_line",
          scale: q.args.scale,
          extend_left: q.args.extend_left,
          extend_right: q.args.extend_right,
          mapping_version: "bar-index-v1",
          points: q.args.points.map((p) => ({ ...p, index: 0 })),
        };
      if (q.op === "read") return structuredClone(row);
      if (q.op === "lifecycle") {
        row.status = "paused";
        return structuredClone(row);
      }
      if (q.op === "edit") {
        assert.equal(q.version, row.version);
        if (writeMode === "pending")
          await new Promise((r) => (editRelease = r));
        if (writeMode === "fail") throw Error("network unavailable");
        row = {
          ...row,
          version: row.version + 1,
          config: { ...row.config, condition: { right: { line: q.line } } },
        };
        if (writeMode === "timeout-committed") throw Error("timeout");
        return structuredClone(row);
      }
    },
  });
  api.attach();
  row = {
    id: "alert-one",
    name: "fixture",
    version: 1,
    status: "active",
    health_reason: null,
    config: {
      instrument: "BTCUSDT",
      source: "binance",
      series_kind: "managed",
      timeframe: "H1",
      association: {
        workspace_id: "fixture",
        chart_id: api.diagnostics().charts[0],
        chart_index: 0,
        object_id: "object-one",
        object_kind: "drawing",
        native_object_id: "native-one",
      },
      condition: {
        right: {
          line: {
            kind: "horizontal_line",
            scale: "linear",
            extend_left: false,
            extend_right: false,
            mapping_version: "bar-index-v1",
            points: [{ time: 60000, price: "100", index: 0 }],
          },
        },
      },
    },
  };
  shape("native-one", [{ time: 60, price: 100 }]);
  api.setRows([structuredClone(row)]);
  return {
    api,
    chart,
    history: value => {history=value;},
    holdRange: promise => {rangeRelease=promise;},
    shapes,
    messages,
    calls,
    failures,
    subscriptions,
    get row() {
      return row;
    },
    move: (price) => shapes.get("native-one").setPoints([{ time: 60, price }]),
    mode: (value) => (writeMode = value),
    release: () => editRelease?.(),
    switchSymbol: () => {
      symbol = "ETHUSDT";
      symbolEvent.fire();
    },
    switchInterval: () => {
      resolution = "5";
      intervalEvent.fire();
    },
    switchSource: (value = "oanda") => (source = value),
    switchScale: (value) => (priceScaleMode = value),
    layoutLoad: () => {
      loading = true;
      epoch++;
    },
    remove: () => {
      shapes.delete("native-one");
      subscriptions.drawing_event("native-one", "remove");
    },
  };
}
test('native locate awaits original-chart preparation and stops after failed or superseded selection', async () => {
  let release, seen;
  const f=fixture({readonly:true,prepareLocate:async (row,event)=>{seen={id:row.id,event};return new Promise(resolve=>{release=resolve;});}});
  const locating=f.api.locate(f.row,{id:'event-one'});
  await Promise.resolve();assert.equal(seen.id,f.row.id);assert.equal(seen.event.id,'event-one');
  release(false);await locating;assert.deepEqual(f.failures,[]);
  const missing=fixture({readonly:true,prepareLocate:async()=>{throw Error('原图格不存在');}});
  await missing.api.locate(missing.row);
  assert.match(missing.failures[0],/原图格不存在/);assert.deepEqual(missing.calls,[]);
});
test('temporary event location uses the event snapshot independently of the original association and changed rule', async () => {
  let f;
  f=fixture({readonly:true,prepareLocate:async (_row,event)=>({chart:f.chart,config:event.evidence.config,temporary:true,current:()=>true})});
  const config=structuredClone(f.row.config);
  f.row.config.instrument='ETHUSDT';f.row.config.association.workspace_id='deleted-workspace';
  await f.api.locate(f.row,{id:'event',occurred_at:60000,price:'101.25',threshold:'100',evidence:{config,ordinal:1}});
  assert.deepEqual(f.failures,[]);assert.deepEqual(f.calls,[]);
  const marker=[...f.shapes.values()].find(s=>s.options?.shape==='arrow_down');
  assert.deepEqual(JSON.parse(JSON.stringify(marker.points)),[{time:60,price:101.25}]);
  assert.equal(marker.options.disableSave,true);assert.equal(marker.options.disableUndo,true);assert.equal(marker.options.lock,true);
  assert.equal([...f.shapes.values()].find(s=>s.options?.shape==='horizontal_line').points[0].price,100);
  assert.equal(f.shapes.get('native-one').points[0].price,100);
});
test('temporary location refuses a different source and unavailable event history without a marker', async () => {
  let f;
  f=fixture({readonly:true,prepareLocate:async row=>({chart:f.chart,config:row.config,temporary:true,current:()=>true})});
  f.switchSource();await f.api.locate(f.row);
  assert.match(f.failures[0],/来源、系列或周期不匹配/);assert.equal(f.shapes.size,1);
  f.switchSource('binance');f.history(null);
  await f.api.locate(f.row,{id:'event',occurred_at:60000,price:'101.25',evidence:{ordinal:1}});
  assert.match(f.failures[1],/历史行情不可用/);assert.equal(f.shapes.size,1);assert.deepEqual(f.calls,[]);
});
test('returning or selecting another alert fences a pending event location', async () => {
  let f,current=true,release;
  f=fixture({readonly:true,prepareLocate:async row=>({chart:f.chart,config:row.config,temporary:true,current:()=>current})});
  f.holdRange(new Promise(resolve=>{release=resolve;}));
  const pending=f.api.locate(f.row,{id:'event',occurred_at:60000,price:'101.25',evidence:{ordinal:1}});
  await tick();current=false;release();await pending;
  assert.equal(f.shapes.size,1);assert.deepEqual(f.failures,[]);
});
test("drag previews do not write; mouse up serializes successive versions", async () => {
  const f = fixture();
  await tick();
  f.subscriptions.mouse_down();
  f.move(101);
  f.subscriptions.drawing_event("native-one", "points_changed");
  await tick();
  assert.equal(f.calls.filter((c) => c.op === "edit").length, 0);
  f.mode("pending");
  f.subscriptions.mouse_up();
  await tick();
  f.move(102);
  f.subscriptions.drawing_event("native-one", "points_changed");
  await tick();
  assert.equal(f.calls.filter((c) => c.op === "edit").length, 1);
  f.mode("success");
  f.release();
  await tick();
  await tick();
  assert.deepEqual(
    f.calls.filter((c) => c.op === "edit").map((c) => c.version),
    [1, 2],
  );
  assert.equal(f.row.version, 3);
  assert.equal(f.row.config.condition.right.line.points[0].price, "102");
});
test("timeout queries committed version; failures preserve position until explicit restore", async () => {
  const f = fixture();
  await tick();
  f.mode("timeout-committed");
  f.move(101);
  f.api.drawingEvent("native-one", "points_changed");
  await tick();
  await tick();
  assert.equal(f.row.version, 2);
  assert.equal(f.calls.filter((c) => c.op === "read").length, 1);
  f.mode("fail");
  f.move(102);
  f.api.drawingEvent("native-one", "points_changed");
  await tick();
  await tick();
  f.api.setRows([structuredClone(f.row)]);
  await tick();
  assert.equal(f.shapes.get("native-one").points[0].price, 102);
  assert.ok(
    f.messages.some(
      (m) => m.type === "chart-alert-association" && m.text.includes("未确认"),
    ),
  );
  await f.api.drawingAction(f.row.id, "restore");
  assert.equal(f.shapes.get("native-one").points[0].price, 101);
});
test("explicit removal pauses; symbol, interval and layout changes never pause", async () => {
  const explicit = fixture();
  await tick();
  explicit.remove();
  await tick();
  assert.equal(explicit.row.status, "paused");
  for (const change of ["switchSymbol", "switchInterval", "layoutLoad"]) {
    const f = fixture();
    await tick();
    f.remove();
    f[change]();
    await tick();
    assert.equal(f.calls.filter((c) => c.op === "lifecycle").length, 0, change);
  }
});
test("source changes fence drawing edits and menu contexts are captured at open", async () => {
  const f = fixture();
  await tick();
  let action;
  await f.api.menu(
    [],
    {
      createAction: (value) => {
        action = value;
        return value;
      },
    },
    { detail: { type: "series" } },
  );
  f.switchSymbol();
  await action.onExecute();
  assert.equal(
    f.messages.filter((m) => m.type === "chart-alert-context").length,
    0,
  );
  assert.ok(f.failures.some((text) => text.includes("已改变")));
  const source = fixture();
  await tick();
  source.switchSource();
  source.move(103);
  source.api.drawingEvent("native-one", "points_changed");
  await tick();
  assert.equal(source.calls.filter((c) => c.op === "edit").length, 0);
});
test("style changes preserve the rule when serialized geometry order or price formatting differs", async () => {
  const f = fixture();
  await tick();
  const line = f.row.config.condition.right.line;
  f.row.config.condition.right.line = {
    points: line.points.map((p) => ({
      price: "100.00",
      index: p.index,
      time: p.time,
    })),
    mapping_version: line.mapping_version,
    extend_right: line.extend_right,
    scale: line.scale,
    kind: line.kind,
    extend_left: line.extend_left,
  };
  f.api.setRows([structuredClone(f.row)]);
  await tick();
  f.api.drawingEvent("native-one", "properties_changed");
  await tick();
  await tick();
  assert.equal(f.calls.filter((q) => q.op === "edit").length, 0);
  assert.equal(f.row.version, 1);
});
test("native history events submit restored geometry without resuming a paused alert", async () => {
  const f = fixture();
  await tick();
  f.move(102);
  f.api.drawingEvent("native-one", "points_changed");
  await tick();
  await tick();
  f.row.status = "paused";
  f.api.setRows([structuredClone(f.row)]);
  await tick();
  f.move(100);
  f.subscriptions.undo?.();
  await tick();
  await tick();
  assert.equal(f.row.version, 3);
  assert.equal(f.row.config.condition.right.line.points[0].price, "100");
  assert.equal(f.row.status, "paused");
  f.move(102);
  f.subscriptions.redo?.();
  await tick();
  await tick();
  assert.equal(f.row.version, 4);
  assert.equal(f.row.config.condition.right.line.points[0].price, "102");
  assert.equal(f.row.status, "paused");
  assert.equal(f.calls.filter((q) => q.op === "lifecycle").length, 0);
});

test("price-axis presentation changes cannot silently replace the saved coordinate system", async () => {
  const f = fixture();
  await tick();
  f.switchScale(1);
  f.api.drawingEvent("native-one", "properties_changed");
  await tick();
  await tick();
  assert.equal(f.calls.filter((q) => q.op === "edit").length, 0);
  assert.equal(f.row.config.condition.right.line.scale, "linear");
  assert.ok(
    f.messages.some(
      (m) => m.type === "chart-alert-association" && m.text.includes("价格轴"),
    ),
  );
  f.switchScale(0);
  f.move(102);
  f.api.drawingEvent("native-one", "points_changed");
  await tick();
  await tick();
  assert.equal(f.row.version, 2);
  assert.equal(f.row.config.condition.right.line.points[0].price, "102");
});

test('visible create paths explain loading and unresolved metadata', async () => {
  const f=fixture();
  f.layoutLoad();await f.api.create();
  assert.ok(f.failures.length,'loading creates visible feedback');
  assert.equal(f.messages.filter(m=>m.type==='chart-alert-context').length,0);
  const items=await f.api.menu([], {createAction:options=>options}, {});
  assert.equal(items[0].disabled,true);assert.match(items[0].label,/加载/);
  const g=fixture();g.switchSource(null);await g.api.create();
  assert.ok(g.failures.length,'metadata missing creates visible feedback');
  assert.equal(g.messages.filter(m=>m.type==='chart-alert-context').length,0);
});

test('squeeze alert captures calculation parameters and boolean, excluding display colors', async () => {
  const f=fixture();
  f.chart.getAllStudies=()=>[{id:'squeeze',name:'守望 Python ROLLING_RANGE_SQUEEZE'}];
  f.chart.getStudyById=()=>({getInputValues:()=>Object.entries({
    k:3,lookback:20,low_pct:0.1,confirm_on_close:false,first_fill_color:'#ff0000',sma_color:'#00ff00',
  }).map(([id,value])=>({id,value}))});
  await f.api.create({object:{type:'study',id:'squeeze'}});
  assert.deepEqual(f.failures,[]);
  const context=f.messages.find(m=>m.type==='chart-alert-context').context;
  assert.deepEqual(context.indicator,{name:'ROLLING_RANGE_SQUEEZE',version:'1',
    params:{k:3,lookback:20,low_pct:0.1,confirm_on_close:false},output:'signal'});
  assert.equal(context.calculation_origin,60000);
});


test('price-axis plus opens selection; only its alert action creates at captured display price', async () => {
  const f = fixture();
  f.subscriptions.onPlusClick({symbol: 'BTCUSDT', price: 1.1195149});
  await tick();
  assert.equal(f.messages.filter(m => m.type === 'chart-alert-context').length, 0, 'plus itself never creates');
  const items = await f.api.menu([], {createAction: value => value}, {menuName:'CrosshairMenuView'});
  assert.equal(items.length, 1);assert.match(items[0].label, /1\.11951.*创建告警/);
  assert.equal(f.messages.filter(m => m.type === 'chart-alert-context').length, 0, 'opening menu never creates');
  await items[0].onExecute();
  const contexts = f.messages.filter(m => m.type === 'chart-alert-context');
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].context.quick_create, true);
  assert.equal(contexts[0].context.price, '1.11951');
  assert.equal(contexts[0].context.price_presentation.text, '1.11951');
  assert.equal(contexts[0].context.association.workspace_id, 'fixture');
  assert.equal(f.calls.filter(q => ['edit', 'lifecycle'].includes(q.op)).length, 0);
});

test('price-axis plus rejects invalid price, loading, missing metadata and readonly charts', async () => {
  for (const change of [f => {}, f => f.layoutLoad(), f => f.switchSource(null)]) {
    const f = fixture(); change(f);
    for (const price of [0, -1, NaN, Infinity]) f.subscriptions.onPlusClick({symbol: 'BTCUSDT', price});
    if (f.failures.length === 0) assert.fail('invalid plus click must explain failure');
    assert.equal(f.messages.filter(m => m.type === 'chart-alert-context').length, 0);
  }
  for (const change of [f => f.layoutLoad(), f => f.switchSource(null)]) {
    const f = fixture(); change(f); f.subscriptions.onPlusClick({symbol: 'BTCUSDT', price: 100});
    assert.equal(f.messages.filter(m => m.type === 'chart-alert-context').length, 0);
    assert.ok(f.failures.length);
  }
  const f = fixture({readonly: true}); f.subscriptions.onPlusClick?.({symbol: 'BTCUSDT', price: 100});
  assert.equal(f.messages.filter(m => m.type === 'chart-alert-context').length, 0);
  const other = fixture(); other.subscriptions.onPlusClick({symbol: 'ETHUSDT', price: 100});
  assert.equal(other.messages.filter(m => m.type === 'chart-alert-context').length, 0);
});


test('dismissed plus menus never create or affect an ordinary menu', async () => {
  const f=fixture(); f.subscriptions.onPlusClick({symbol:'BTCUSDT',price:120});
  await f.api.menu([], {createAction:v=>v}, {menuName:'CrosshairMenuView'});
  assert.equal(f.messages.filter(m=>m.type==='chart-alert-context').length,0);
  const normal=await f.api.menu([], {createAction:v=>v}, {menuName:'MainSeriesContextMenu',detail:{type:'series'}});
  await normal[0].onExecute();
  const c=f.messages.find(m=>m.type==='chart-alert-context').context;
  assert.equal(c.quick_create,undefined);assert.equal(c.price,undefined);
});

test('plus selection rejects changed chart and missing/invalid captured price', async () => {
  for(const change of ['switchSymbol','switchInterval','layoutLoad']){
    const f=fixture();f.subscriptions.onPlusClick({symbol:'BTCUSDT',price:120});
    const items=await f.api.menu([], {createAction:v=>v}, {menuName:'CrosshairMenuView'});
    f[change]();await items[0].onExecute();
    assert.equal(f.messages.filter(m=>m.type==='chart-alert-context').length,0,change);
    assert.ok(f.failures.length,change);
  }
  for(const p of [undefined,0,NaN]){
    const f=fixture();if(p!==undefined)f.subscriptions.onPlusClick({symbol:'BTCUSDT',price:p});
    const native={native:true};const items=await f.api.menu([native], {createAction:v=>v}, {menuName:'CrosshairMenuView'});
    assert.deepEqual(items,[native]);
  }
});
