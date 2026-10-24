// Lifecycle and race tests through the shipped native adapter's public boundary.
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, "../..");
const tick = () => new Promise((r) => setTimeout(r, 5));
function fixture() {
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
    resolution: () => resolution,
    chartType: () => 1,
    dataReady: () => true,
    getAllShapes: () => [...shapes].map(([id, s]) => ({ id, name: s.name })),
    getShapeById: (id) => shapes.get(id),
    getAllStudies: () => [],
    getPanes: () => [
      { getMainSourcePriceScale: () => ({ getMode: () => priceScaleMode }) },
    ],
    onSymbolChanged: () => symbolEvent,
    onIntervalChanged: () => intervalEvent,
    createShape: async (point) => {
      const id = "restored-" + ++nextId;
      shape(id, [point]);
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
    readonly: false,
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
