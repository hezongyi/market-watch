// Full mobile workspace and native alert surface; licensed widget + routed synthetic API.
// All requests are intercepted. No deployed database is written or read by this test.
const {chromium,expect}=require('@playwright/test');
const {build}=require('esbuild');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {hash}=require('./mobile-workspace-fixture.cjs');
const root=path.resolve(__dirname,'../..'),library=process.env.MW_PROBE_LIBRARY;
const output=process.env.MW_WORKSPACE_OUTPUT;
assert.ok(library && output && process.env.MW_MOBILE_FIXTURE_FILE,'Explicit private library, seed and output required');
const seed=JSON.parse(fs.readFileSync(process.env.MW_MOBILE_FIXTURE_FILE));
const APP='https://workspace-parent.invalid',CHART='https://workspace-chart.invalid';
const workspaces=['workspace-a','workspace-b'].map(id=>({id,name:'同名工作区',revision:7,document:{engine:'tv31',schemaVersion:1,symbol:'MWP:TEST',interval:'1D',state:structuredClone(seed.document)}}));
const NOW=Date.UTC(2026,8,28,12),rows=[],events=[],requests=[],messages=[],errors=[],unexpected=[],preferences=[];
const a=workspaces[0];
const watchlistValue={active:'fixture-list',lists:[{id:'fixture-list',title:'测试列表',symbols:['MWP:TEST','MWP:TEST-2']}]};
for(const [name,value] of [['mw.watchlists.v1',watchlistValue],['mw.symbol-flags.v1',{version:1,flags:{}}]])preferences.push({id:randomUUID(),kind:'setting',name,tool:'',revision:1,content:{value}});
const unrelatedPreference={id:randomUUID(),kind:'chart_template',name:'保留桌面模板',tool:'',revision:1,content:{value:{untouched:true}}};preferences.push(unrelatedPreference);

let preferenceFailure=false,preferenceConflict=false,lifecycleConflict=false,workspaceFailure=false,workspaceConflict=false;
function rule(workspace,index,name,status='active'){
 const config={name,instrument:index===3?'TEST-3':'TEST',series_kind:'provider',source:'fixture',timeframe:'M5',mode:'close',condition:{relation:'cross_up',left:{kind:'price'},right:{kind:'constant',value:'100'}},max_triggers:3,expires_at:null,message:name,notify_web:true,notify_ntfy:true,late_delivery:'log_only',association:{workspace_id:workspace,chart_id:'original-'+(index+1),chart_index:index,generation:'fixture',object_id:null,object_kind:null,native_object_id:null},calculation_version:'chart-python-v1'};
 const row={id:randomUUID(),name,version:1,control_revision:1,run:1,status,health:'ready',health_reason:null,count:1,max_triggers:3,effective_at:NOW-100000,created_at:NOW-100000,updated_at:NOW,config,condition_summary:'价格上穿 100',runtime:{}};
 rows.push(row);return row;
}
function event(row,i=0){const e={id:randomUUID(),alert_id:row.id,occurred_at:NOW-i*300000,detected_at:NOW-i*300000,direction:'up',price:'101.25',threshold:'100',evidence:{rule_version:1,ordinal:1,left:'101.25',late:false,config:structuredClone(row.config),observation:{}},message:row.name,notification_id:randomUUID(),notification_status:'pending',ack_at:null,delivery_status:'pending'};events.push(e);return e;}
const second=rule('workspace-a',1,'原图格二'),fourth=rule('workspace-a',3,'原图格四'),cross=rule('workspace-b',3,'跨工作区日志'),completed=rule('workspace-a',1,'已经完成','completed');
event(second);event(fourth);const crossEvent=event(cross);
for(let i=1;i<28;i++)event(cross,i);
// The current rule has since changed; event inspection must use its evidence.
cross.config.instrument='TEST-2';
function history(q){const step=({D1:86400000,H4:14400000,H1:3600000,M5:300000,M1:60000})[q.timeframe]||300000,end=Math.floor((q.before||Date.UTC(2026,8,29))/step)*step,count=Math.min(q.countBack||q.limit||400,20000);const bars=Array.from({length:count},(_,i)=>{const start=end-(count-i)*step,close=100+Math.sin(start/step/5)*2;return {start,end:start+step,chart_time:start,open:String(close-.3),high:String(close+2),low:String(close-2),close:String(close),complete:true,volume:null,revision:1};});return {bars,indicators:[],has_more:true,cache_revision:1,as_of:Date.now(),calculation_origin:bars[0].start};}
async function business({url,req,body,reply,route}){
 const p=url.pathname;
 if(p==='/api/advanced-charts/native-charts/save'){
  if(workspaceFailure){await reply({detail:'图格保存失败，请重试'},503);return true;}
  const row=workspaces.find(w=>w.id===body.id);
  if(workspaceConflict){workspaceConflict=false;row.revision++;await reply({detail:'工作区已在其他窗口修改，未覆盖'},409);return true;}
  if(row.revision!==body.revision){await reply({detail:'工作区版本冲突'},409);return true;}
  row.document.state=JSON.parse(body.content);row.document.symbol=body.symbol;row.document.interval=body.resolution;row.revision++;
  await reply(row);return true;
 }
 if(/^\/api\/advanced-charts\/workspaces\//.test(p)){const row=workspaces.find(w=>w.id===decodeURIComponent(p.split('/').at(-1)));await reply(row||{detail:'工作区已删除'},row?200:404);return true;}
 if(/^\/api\/advanced-charts\/native-charts\//.test(p)){const row=workspaces.find(w=>w.id===decodeURIComponent(p.split('/').at(-1)));assert.equal(req.method(),'GET','mobile workspace write');await reply(row?{...row,content:JSON.stringify(row.document.state)}:{detail:'不存在'},row?200:404);return true;}
 if(p==='/api/advanced-charts/catalog'){await reply({});return true;}
 if(p==='/api/market-data/series/search'){await reply([{ticker:'MWP:TEST-3',label:'测试品种三'}]);return true;}
 if(p==='/api/advanced-charts/preferences'){await reply(preferences);return true;}
 if(p==='/api/advanced-charts/preferences/save'){
  assert.ok(['mw.watchlists.v1','mw.symbol-flags.v1'].includes(body.name),'forbidden preference');
  if(preferenceFailure){await reply({detail:'保存失败，稍后重试'},503);return true;}
  const previous=preferences.find(v=>v.name===body.name);
  if(preferenceConflict){preferenceConflict=false;previous.revision++;previous.content.value.flags['MWP:TEST']='green';await reply({detail:'版本冲突'},409);return true;}
  if((previous?.revision||0)!==body.revision){await reply({detail:'版本冲突'},409);return true;}
  const next={...body,id:previous?.id||'f'.repeat(64),revision:body.revision+1};
  if(previous)preferences.splice(preferences.indexOf(previous),1,next);else preferences.push(next);
  await reply(next);return true;
 }
 if(p==='/api/chart-alerts/capabilities'){await reply({sources:[{source:'fixture',series_kind:'provider',basis:'last',available:true,observation_basis:'fixture'}],modes:['close','intrabar']});return true;}
 if(p==='/api/chart-alerts/events'){await reply(events);return true;}
 if(p==='/api/chart-alerts' && req.method()==='GET'){await reply(rows);return true;}
 if(/^\/api\/chart-alerts\/[a-f0-9-]{36}$/.test(p)){const row=rows.find(r=>r.id===p.split('/').at(-1));await reply(row||{detail:'告警不存在'},row?200:404);return true;}
 if(p.endsWith('/lifecycle')){
  assert.ok(['pause','resume'].includes(body.action),'forbidden lifecycle');
  const row=rows.find(r=>r.id===p.split('/')[3]);
  if(lifecycleConflict){lifecycleConflict=false;row.control_revision++;await reply({detail:'告警版本冲突，请核对后重试'},409);return true;}
  assert.equal(row.status,body.action==='pause'?'active':'paused');row.status=body.action==='pause'?'paused':'active';row.control_revision++;await reply(row);return true;
 }
 if(/^\/api\/notifications\/[^/]+\/ack$/.test(p)){const e=events.find(e=>e.notification_id===p.split('/')[3]);e.ack_at=Date.now();e.notification_status='acknowledged';await reply({ok:true});return true;}
 if(p.startsWith('/api/notifications/')){await reply({events:[],attempts:[]});return true;}
 return false;
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const uiAssets = path.join(output, "ui-assets");
  execFileSync(process.execPath, ["scripts/build-alert-ui.mjs", uiAssets], {
    cwd: path.join(root, "web"),
  });
  // Apply the existing production build hook to a disposable copy only.
  const patched = path.join(output, "library.e2f8b3a016c9e1a0b7a5.js");
  fs.copyFileSync(
    path.join(library, "bundles", path.basename(patched)),
    patched,
  );
  execFileSync(process.execPath, [
    path.join(root, "advanced-host/patch-native-reserve.mjs"),
    patched,
  ]);
  const toolset = path.join(output, 'restricted-toolset.4fbfc823d8551bbb3e53.js');
  fs.copyFileSync(path.join(library, 'bundles', path.basename(toolset)), toolset);
  execFileSync(process.execPath, [path.join(root, 'advanced-host/patch-native-toolset.mjs'), toolset]);
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter,Routes,Route} from 'react-router-dom';import {NoticeProvider} from './src/notifications/context';import AdvancedWorkspace from './src/advanced/AdvancedWorkspace';import {setCsrf} from './src/api';setCsrf('parent-only-fixture');createRoot(document.getElementById('root')).render(<BrowserRouter><NoticeProvider active={false} subject="fixture"><Routes><Route path="/advanced-charts/:workspaceId?" element={<AdvancedWorkspace/>}/><Route path="/settings" element={<a href="/advanced-charts/workspace-a">返回图表</a>}/></Routes></NoticeProvider></BrowserRouter>);`,
      loader: "tsx",
      resolveDir: path.join(root, "web"),
    },
    bundle: true,
    write: false,
    outdir: "fixture",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": JSON.stringify({ VITE_ADVANCED_CHART_ORIGIN: CHART }),
    },
  });
  let rejectBrowserFault;const browserFault=new Promise((_,reject)=>{rejectBrowserFault=reject;});browserFault.catch(()=>{});
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, isMobile:true, hasTouch:true,
  });
  const report = {
    scope:
      "Ubuntu Chromium; full AdvancedWorkspace and shipped bridge with actual licensed widget; routed synthetic API; no deployed instance",
    cases: [],
    passed: false,
  };
  page.on("pageerror", (e) => {errors.push(e.stack || String(e));rejectBrowserFault(e);});
  await page.addInitScript(() => {
    return (addEventListener("message", (e) => {
      if (e.data?.channel === "mw-chart-v1")
        (globalThis.__messages ||= []).push(e.data);
    }));},
  );
  await page.route("**/*", route => {unexpected.push("external:"+new URL(route.request().url()).origin);return route.abort();});
  await page.route(APP + "/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      body = req.method() === "POST" ? req.postDataJSON() : undefined;
    const reply = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/fixture.") && url.pathname !== "/readyz")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      });
    if (url.pathname.startsWith("/fixture.")) {
      const f = bundle.outputFiles.find((f) =>
        f.path.endsWith(path.extname(url.pathname)),
      );
      return route.fulfill({
        body: f.text,
        contentType: url.pathname.endsWith(".js")
          ? "text/javascript"
          : "text/css",
      });
    }
    requests.push({
      path: url.pathname,
      body,
      csrf: req.headers()["x-csrf-token"],
    });
    const handled = await business({url,req,body,reply,route});
    if (handled) return;
    if (url.pathname === "/readyz") return reply({ time: Date.now() });
    if (url.pathname === "/api/advanced-charts/workspaces")
      return reply(workspaces);
    if (url.pathname === "/api/advanced-charts/native-charts")
      return reply(
        workspaces.map((w) => ({
          ...w,
          symbol: w.document.symbol,
          resolution: w.document.interval,
          timestamp: Date.now() / 1000,
          content: JSON.stringify(w.document.state),
        })),
      );
    if (url.pathname === "/api/charts/history-capabilities")
      return reply({
        protocol: 1,
        version: "fixture",
        mode: "continuous",
        max_bars: 20000,
        workspace_bars: 40000,
        response_bytes: 8000000,
        task_seconds: 30,
        min_bars: 100,
        hard_max_bars: 20000,
        default_bars: 4000,
      });
    if (url.pathname === "/api/market-data/resolve") {
      return reply({
        instrument: body.instrument,
        symbol: body.instrument,
        name: body.instrument,
        source: "fixture",
        basis: "last",
        calendar: "utc0",
        precision: 5,
        session: "24x7",
        timezone: "Etc/UTC",
        frames: ["M1","M5","H1","H4","D1"],
        volume_kind: "unavailable",
      });
    }
    if (url.pathname === "/api/market-data/quotes")
      return reply(
        body.symbols.map((n) => ({
          n,
          s: "ok",
          v: { lp: 1.12, ch: 0, chp: 0, short_name: n, exchange: "Fixture" },
        })),
      );
    if (url.pathname === "/api/charts/history-loads")
      return reply({ result: history(body.query) });
    if (url.pathname === "/api/charts/data") return reply(history(body));
    if (url.pathname === "/api/charts/reserve")
      return reply({ ...history(body), reserve_status: "ready" });
    if (["/api/charts/provider/subscribe", "/api/charts/stream/subscribe"].includes(url.pathname))
      return reply({ listener: crypto.randomUUID() });
    if (["/api/charts/provider/unsubscribe", "/api/charts/stream/unsubscribe"].includes(url.pathname))
      return reply({ ok: true });
    if (["/api/charts/provider/events", "/api/charts/stream/events"].includes(url.pathname))
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": fixture\n\n",
      });
    unexpected.push(url.pathname);
    return reply({ detail: "Unexpected fixture path " + url.pathname }, 404);
  });
  await page.route(CHART + "/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: fs.readFileSync(
          path.join(root, "advanced-host/index.html"),
          "utf8",
        ),
      });
    const relative = decodeURIComponent(url.pathname).slice(1);
    const file =
      relative === 'charting_library/bundles/' + path.basename(toolset) ? toolset :
      relative === "charting_library/bundles/" + path.basename(patched)
        ? patched
        : relative.startsWith("charting_library/")
          ? path.join(library, relative.slice("charting_library/".length))
          : /^alert-ui\.(js|css)$/.test(relative)
            ? path.join(uiAssets, relative)
            : path.join(root, "advanced-host", relative);
    if (!fs.existsSync(file)) {
      unexpected.push(url.pathname);
      return route.fulfill({ status: 404, body: "Missing fixture asset" });
    }
    return route.fulfill({
      path: file,
      ...(file.endsWith(".js")
        ? { contentType: "text/javascript; charset=utf-8" }
        : file.endsWith(".css")
          ? { contentType: "text/css" }
          : {}),
    });
  });
  try {
    const beforeHash=hash(workspaces);
    await page.goto(APP+'/advanced-charts/workspace-a');
    const iframe=page.locator('iframe[title="专业图表工作区"]');
    await iframe.waitFor();
    let host,chart;
    async function settle(workspace='workspace-a'){
      await expect(iframe).toHaveAttribute('data-workspace-id',workspace);host=await (await iframe.elementHandle()).contentFrame();await host.waitForURL(u=>u.origin===CHART);
      assert.ok(host,'host frame');
      await Promise.race([browserFault,host.waitForFunction(id=>typeof ready!=='undefined' && ready && !loading && alertUI && mobileChartView?.state().selected && alertUIWorkspace===id && widget.activeChart().dataReady(),workspace,{timeout:30000})]);
      chart=host.childFrames()[0];
      assert.ok(chart,'rendered chart iframe');
    }
    const nav=page.getByRole('navigation',{name:'移动端导航'});
    async function openAlerts(){await nav.getByRole('button',{name:/告警/}).click();await chart.getByRole('tab',{name:'警报',exact:true}).waitFor();}
    async function temporary(row){await Promise.race([browserFault,host.waitForFunction(config=>mobileChartView.state().temporary && mobileChartView.state().exploring && MWSeries.same(widget.activeChart().symbol(),MWSeries.encode(config.instrument,config.series_kind)) && frames[widget.activeChart().resolution()]===config.timeframe && widget.activeChart().dataReady(),row.config,{timeout:10000})]);assert.equal(await host.evaluate(()=>widget.chartsCount()),1);}
    await settle();
    await openAlerts();
    await nav.getByRole('button',{name:'更多',exact:true}).click();
    await expect(chart.getByRole('complementary',{name:'告警与日志',exact:true})).toHaveCount(0);
    await nav.getByRole('button',{name:'图表',exact:true}).click();
    for(const [row,index] of [[second,1],[fourth,3]]){
      await openAlerts();
      await chart.locator('.chart-alert-card').filter({hasText:row.name}).locator('.alert-row-summary').click();
      await temporary(row);
      await expect(page.getByRole('button',{name:'返回告警与日志'})).toBeVisible();
      await page.getByRole('button',{name:'返回告警与日志'}).click();
      await chart.getByRole('tab',{name:'警报',exact:true}).waitFor();
      await host.waitForFunction(()=>!mobileChartView.state().temporary && mobileChartView.state().selected?.original_index===0);
      report.cases.push({name:'native rule from original chart '+(index+1)+' opens temporary view and restores original chart'});
    }
    const card=chart.locator('.chart-alert-card').filter({hasText:second.name});
    await card.getByRole('button',{name:'暂停',exact:true}).click();
    await expect(card.getByRole('button',{name:'恢复',exact:true})).toBeEnabled();assert.equal(second.status,'paused');
    await card.getByRole('button',{name:'恢复',exact:true}).click();
    await expect(card.getByRole('button',{name:'暂停',exact:true})).toBeEnabled();assert.equal(second.status,'active');
    await expect(chart.locator('.chart-alert-card').filter({hasText:completed.name}).getByRole('button',{name:'重新启用（新一轮）'})).toBeDisabled();
    lifecycleConflict=true;
    await card.getByRole('button',{name:'暂停',exact:true}).click();
    await chart.getByRole('alert').filter({hasText:'告警版本冲突'}).waitFor();
    assert.equal(second.status,'active');
    await card.getByRole('button',{name:'暂停',exact:true}).click();
    await expect(card.getByRole('button',{name:'恢复',exact:true})).toBeEnabled();
    await card.getByRole('button',{name:'恢复',exact:true}).click();
    report.cases.push({name:'pause/resume and 409 refresh; completed restart unavailable'});
    await chart.getByRole('tab',{name:'日志',exact:true}).click();
    await chart.getByRole('button',{name:'搜索告警',exact:true}).click();
    await chart.getByRole('textbox',{name:'搜索',exact:true}).fill('跨工作区日志');
    const eventCard=chart.locator('[data-signal-id="'+crossEvent.id+'"]');
    await eventCard.getByRole('button',{name:'日志详情',exact:true}).click();
    await chart.getByRole('menuitem',{name:'查看详情',exact:true}).click();
    const detail=chart.getByRole('region',{name:'告警详情'});
    await detail.waitFor();
    await detail.getByRole('button',{name:'停止后续手机提醒',exact:true}).click();
    await expect(detail.getByRole('button',{name:'已停止后续提醒',exact:true})).toBeDisabled();
    assert.equal(cross.status,'active','ack must not pause rule');assert.ok(crossEvent.ack_at);
    await chart.locator('.alert-panel-content').evaluate(n=>{n.scrollTop=140;n.dispatchEvent(new Event('scroll'));});
    report.scrollGeometry=await chart.locator('.alert-panel-content').evaluate(n=>({scrollTop:n.scrollTop,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight,panel:n.parentElement.getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight},cards:n.querySelectorAll('[data-signal-id]').length}));
    assert.ok(report.scrollGeometry.scrollTop>0,'list must actually scroll before testing restoration');
    const viewBefore=await host.evaluate(()=>JSON.parse(sessionStorage.getItem('mw-mobile-alert-view:v1:workspace-a')));
    await detail.getByRole('button',{name:'定位触发位置',exact:true}).click();
    await temporary({config:crossEvent.evidence.config});
    assert.equal(new URL(page.url()).pathname,'/advanced-charts/workspace-a');
    assert.equal(await (await iframe.elementHandle()).contentFrame(),host,'temporary location keeps host');
    await host.waitForFunction(()=>widget.activeChart().getAllShapes().some(s=>s.name==='arrow_down'),null,{timeout:30000});
    const markers=await host.evaluate(()=>widget.activeChart().getAllShapes().filter(s=>s.name==='arrow_down').map(s=>widget.activeChart().getShapeById(s.id).getPoints()));
    report.eventMarkers=markers;
    assert.ok(markers.some(points=>points.some(p=>p.time===NOW/1000 && p.price===101.25)),'event marker time/price');
    await page.getByRole('button',{name:'返回告警与日志'}).click();
    await host.waitForFunction(()=>!mobileChartView.state().temporary && mobileChartView.state().selected?.original_index===0);
    await chart.getByRole('tab',{name:'日志',exact:true}).waitFor();
    await expect(chart.getByRole('textbox',{name:'搜索',exact:true})).toHaveValue('跨工作区日志');
    await expect(chart.getByRole('region',{name:'告警详情'})).toBeVisible();
    const viewAfter=await host.evaluate(()=>JSON.parse(sessionStorage.getItem('mw-mobile-alert-view:v1:workspace-a')));
    for(const key of ['tab','search','selected','detail','showHandled','eventSort','sort'])assert.deepEqual(viewAfter[key],viewBefore[key],key+' restored');
    assert.equal(await chart.locator('.alert-panel-content').evaluate(n=>n.scrollTop),viewBefore.scrollTop);
    report.cases.push({name:'event from another workspace opens locally; return preserves chart/search/detail/selection/scroll',marker:markers,scroll:viewAfter.scrollTop,ackDoesNotPause:true});
    // An obsolete original association does not prevent a temporary view.
    await chart.getByRole('button',{name:'关闭详情',exact:true}).click();
    await chart.getByRole('textbox',{name:'搜索',exact:true}).fill('');
    await chart.getByRole('tab',{name:'警报',exact:true}).click();
    fourth.config.association.chart_id='deleted-original';
    await chart.getByRole('button',{name:'更多选项',exact:true}).click();
    await chart.getByRole('menuitem',{name:'刷新',exact:true}).click();
    await chart.locator('.chart-alert-card').filter({hasText:fourth.name}).locator('.alert-row-summary').click();
    await temporary(fourth);
    await page.getByRole('button',{name:'返回告警与日志'}).click();
    await host.waitForFunction(()=>!mobileChartView.state().temporary);
    fourth.config.association.chart_id='original-4';
    await chart.locator('.chart-alert-card').filter({hasText:fourth.name}).locator('.alert-row-summary').click();
    await temporary(fourth);
    await page.getByRole('button',{name:/图格 4/}).click();
    await host.waitForFunction(()=>!mobileChartView.state().temporary && mobileChartView.state().selected?.original_index===3);
    await expect(page.getByRole('button',{name:'返回告警与日志'})).toHaveCount(0);
    await page.getByRole('button',{name:/图格 1/}).click();
    await host.waitForFunction(()=>mobileChartView.state().selected?.original_index===0);
    report.cases.push({name:'missing original chart does not block temporary location'});
    // Exercise writes and recovery only against the routed synthetic transport.
    const watchlists=()=>preferences.find(p=>p.name==='mw.watchlists.v1').content.value;
    const flags=()=>preferences.find(p=>p.name==='mw.symbol-flags.v1').content.value.flags;
    await nav.getByRole('button',{name:'自选',exact:true}).click();
    await page.getByRole('button',{name:'MWP:TEST-2 上移',exact:true}).click();
    await expect.poll(()=>watchlists().lists[0].symbols).toEqual(['MWP:TEST-2','MWP:TEST']);
    await page.getByRole('button',{name:'MWP:TEST-2 移除',exact:true}).click();
    await expect.poll(()=>watchlists().lists[0].symbols).toEqual(['MWP:TEST']);
    await expect(page.getByRole('button',{name:'MWP:TEST-2 移除',exact:true})).toHaveCount(0);
    await page.getByRole('textbox',{name:'搜索品种',exact:true}).fill('测试');
    await page.getByRole('button',{name:'搜索',exact:true}).click();
    await page.getByRole('button',{name:/测试品种三/}).click();
    await expect.poll(()=>watchlists().lists[0].symbols).toEqual(['MWP:TEST','MWP:TEST-3']);
    await host.waitForFunction(()=>MWSeries.same(widget.activeChart().symbol(),'MWP:TEST-3'));
    await nav.getByRole('button',{name:'自选',exact:true}).click();
    await page.getByRole('button',{name:'MWP:TEST 旗标红',exact:true}).click();
    await expect.poll(()=>flags()['MWP:TEST']).toBe('red');
    const unrelatedKey='mw-preference-draft:v1:admin:fixture:desktop',unrelatedRaw=JSON.stringify({key:JSON.stringify(['chart_template','桌面草稿','']),kind:'chart_template',name:'桌面草稿',tool:'',version:'desktop-preserved',operation:'save',failed:true,value:{untouched:true}});
    await page.evaluate(({key,raw})=>localStorage.setItem(key,raw),{key:unrelatedKey,raw:unrelatedRaw});
    preferenceFailure=true;
    await page.getByRole('button',{name:'MWP:TEST 旗标蓝',exact:true}).click();
    await page.getByRole('button',{name:'处理设置草稿',exact:true}).waitFor();
    assert.equal(flags()['MWP:TEST'],'red');
    await page.getByRole('button',{name:'处理设置草稿',exact:true}).click();
    let recovery=page.getByRole('dialog',{name:'处理设置草稿',exact:true});
    await expect(recovery.getByRole('combobox')).toHaveCount(1);
    await expect(recovery.getByRole('combobox').locator('option')).toHaveCount(1);
    preferenceFailure=false;
    await recovery.getByRole('button',{name:'提交本地修改',exact:true}).click();
    await expect.poll(()=>flags()['MWP:TEST']).toBe('blue');
    await recovery.getByRole('button',{name:'关闭',exact:true}).click();
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),unrelatedKey),unrelatedRaw);
    assert.deepEqual(unrelatedPreference.content.value,{untouched:true});
    report.cases.push({name:'watchlist reorder/remove/search add, flag persistence and failed save → submit local draft; unrelated desktop settings/draft retained'});
    await page.reload();await settle();
    await nav.getByRole('button',{name:'自选',exact:true}).click();
    assert.deepEqual(watchlists().lists[0].symbols,['MWP:TEST','MWP:TEST-3']);
    await expect(page.getByRole('button',{name:'MWP:TEST 旗标蓝',exact:true})).toBeVisible();
    preferenceConflict=true;
    await page.getByRole('button',{name:'MWP:TEST 旗标黄',exact:true}).click();
    await page.getByRole('button',{name:'处理设置草稿',exact:true}).click();
    recovery=page.getByRole('dialog',{name:'处理设置草稿',exact:true});
    await expect(recovery.getByRole('textbox',{name:'服务器设置',exact:true})).toContainText(/green/);
    await recovery.getByRole('button',{name:'采用服务器设置',exact:true}).click();
    await recovery.getByRole('button',{name:'关闭',exact:true}).click();
    assert.equal(flags()['MWP:TEST'],'green');
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),unrelatedKey),unrelatedRaw);
    report.cases.push({name:'preferences reload and 409 concurrent edit → adopt server without overwriting it'});
    assert.equal(hash(workspaces),beforeHash,'mobile changed source documents');
    assert.ok(!requests.some(r=>/advanced-charts\/(?:workspaces|native-charts).*save/.test(r.path)),'workspace write');
    await nav.getByRole('button',{name:'图表',exact:true}).click();
    const beforeSave=structuredClone(workspaces[0]);
    await host.evaluate(async()=>{await widget.chart(0).createStudy('Moving Average',false,false,{length:37});});
    const save=page.getByRole('button',{name:'保存当前图格',exact:true});
    await expect(save).toBeEnabled();
    await openAlerts();
    await chart.locator('.chart-alert-card').filter({hasText:second.name}).locator('.alert-row-summary').click();
    await temporary(second);
    await page.getByRole('button',{name:'返回告警与日志'}).click();
    await host.waitForFunction(()=>!mobileChartView.state().temporary && mobileChartDirty);
    assert.ok(await host.evaluate(()=>widget.chart(0).getAllStudies().some(s=>widget.chart(0).getStudyById(s.id).getInputValues().some(v=>v.value===37))),'temporary inspection lost unsaved study');
    await nav.getByRole('button',{name:'图表',exact:true}).click();
    workspaceFailure=true;await save.click();
    await expect(save).toBeEnabled();assert.equal(workspaces[0].revision,beforeSave.revision);
    workspaceFailure=false;await save.click();
    await expect(page.getByRole('button',{name:'图格已保存',exact:true})).toBeVisible();
    assert.equal(workspaces[0].revision,beforeSave.revision+1);
    for(const index of [1,2,3])assert.equal(hash(workspaces[0].document.state.charts[index]),hash(beforeSave.document.state.charts[index]));
    assert.equal(workspaces[0].document.state.layout,beforeSave.document.state.layout);
    await page.reload();await settle();
    assert.ok(await host.evaluate(()=>widget.chart(0).getAllStudies().some(s=>widget.chart(0).getStudyById(s.id).getInputValues().some(v=>v.value===37))));
    const serverBefore=hash(workspaces[0].document.state);
    await host.evaluate(async()=>{await widget.chart(0).createStudy('Moving Average',false,false,{length:43});});
    workspaceConflict=true;await save.click();
    await expect(save).toBeEnabled();assert.equal(hash(workspaces[0].document.state),serverBefore,'conflict overwrote server');
    assert.ok(await host.evaluate(()=>widget.chart(0).getAllStudies().some(s=>widget.chart(0).getStudyById(s.id).getInputValues().some(v=>v.value===43))),'failed edit lost');
    report.cases.push({name:'mobile explicit slot save: 503 keeps edit, retry persists and reloads; other charts/layout unchanged; 409 keeps local edit without overwriting server'});
    // Router unmount in this transport fixture (not the real Settings page).
    await page.evaluate(()=>{history.pushState({},'', '/settings');dispatchEvent(new PopStateEvent('popstate'));});
    await page.getByRole('link',{name:'返回图表',exact:true}).waitFor();
    const alertReads=()=>requests.filter(r=>r.path==='/api/chart-alerts' || r.path==='/api/chart-alerts/events').length;
    const readsAfterLeave=alertReads();await page.waitForTimeout(5500);
    assert.equal(alertReads(),readsAfterLeave,'alert polling revived after route unmount');
    report.cases.push({name:'route unmount stops alert polling beyond its five-second interval; settings content is a fixture'});
    assert.deepEqual(unexpected,[],'unhandled or external network');
    assert.deepEqual(errors,[],'uncaught browser errors');
    report.passed=true;
  } catch(error){report.failure=error.stack;process.exitCode=1;report.debug=await Promise.all(page.frames().map(async f=>({url:f.url(),body:await f.locator('body').innerText().catch(()=>''),state:await f.evaluate(()=>({ready:typeof ready==='undefined'?null:ready,loading:typeof loading==='undefined'?null:loading,mobile:typeof mobileChartView==='undefined'?null:mobileChartView?.state(),alerts:typeof alertUI==='undefined'?null:!!alertUI,ranges:typeof widget==='undefined'?null:{visible:widget.activeChart().getVisibleRange(),bars:widget.activeChart().getVisibleBarsRange(),symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution()},messages:globalThis.__messages?.filter(m=>m.type.includes('mobile-alert') || m.type==='error').slice(-12).map(m=>({type:m.type,error:m.error,state:m.state}))})).catch(()=>null)})));await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.html'),await page.content());}
  finally {
    report.errors=errors;report.unexpected=unexpected;
    report.requests=requests.map(({path,body})=>({path,...(path.endsWith('/lifecycle')?{action:body.action}:{} ),...(path.endsWith('/history-loads')?{query:body.query}:{} ),...(path.endsWith('/preferences/save')?{value:body.content?.value}:{} )}));
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,failure:report.failure,unexpected}));
    await browser.close();
  }
})();
