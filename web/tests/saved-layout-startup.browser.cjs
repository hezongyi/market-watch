// Exercise the real React entry, localStorage and save RPCs with a controlled
// chart adapter. The vendor renderer and HTTP backend are outside this test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium, expect} = require('@playwright/test');
const clone = value => JSON.parse(JSON.stringify(value));
const root = path.resolve('dist');
const preferenceSource = fs.readFileSync('../advanced-host/preferences.js', 'utf8');
const preferenceKey = JSON.stringify(['setting', 'chart.lastUsedTimeBasedResolution', '']);
const adapterSource = preferenceSource + `
MWChartAdapter = {mount(container, application) {
  const adapter = {
    start() { application.observe({type:'loaded'}, adapter); },
    update(value) {
      if(value.type !== 'init') return;
      const rpc = (op,args) => application.session('preferences',{op,args},{id:1},adapter);
      const prefs = nativePreferences(value.preferences,rpc,value.readonly,()=>{},()=>{},()=>({}),{
        blocked:value.preference_draft_keys,put:d=>rpc('draftWrite',d),
        drop:d=>rpc('draftDrop',d),failed:d=>rpc('draftFailed',d)
      });
      window.startupProbe = {value, adapter, application, prefs};
      container.textContent = value.workspace.name;
      application.observe({type:'ready'},adapter);
      application.observe({type:'notice-center-ready',workspace_id:value.workspace.id,session:value.alert_ui_session},adapter);
    },
    dispose() { window.startupProbe?.prefs.dispose(); delete window.startupProbe; }
  };
  return adapter;
}};`;

(async () => {
  let server, browser;
  try {
    // CI can serve build:ui directly; local acceptance supplies the isolated
    // Ubuntu Docker web URL through MW_BASE_URL.
    let base = process.env.MW_BASE_URL;
    if (!base) {
      server = http.createServer((req,res) => {
        const url = new URL(req.url, 'http://localhost');
        const file = path.join(root, url.pathname);
        const selected = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(root,'index.html');
        res.setHeader('Content-Type', selected.endsWith('.js') ? 'text/javascript' : selected.endsWith('.css') ? 'text/css' : 'text/html');
        fs.createReadStream(selected).pipe(res);
      });
      await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
      base = 'http://127.0.0.1:' + server.address().port;
    }
    browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
    const context = await browser.newContext({viewport:{width:1440,height:900}});
    const page = await context.newPage(), errors = [], mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    let workspace = {id:'saved-layout',name:'已保存布局',revision:7,document:{engine:'tv31',schemaVersion:1,state:{layout:'2h',marker:'server-saved'}}};
    let failSave = false;
    let preference = {id:'a'.repeat(64),kind:'setting',name:'chart.lastUsedTimeBasedResolution',tool:'',revision:3,content:{value:'15'}};
    const oldDocument = {engine:'tv31',schemaVersion:1,state:{layout:'s',marker:'ignored-draft'}};
    const oldPreference = {key:preferenceKey,kind:'setting',name:preference.name,tool:'',version:'old-version',operation:'save',value:'240',failed:true};
    const drafts = {
      'mw-tv-draft:saved-layout':JSON.stringify(oldDocument),
      'mw-tv-draft:v2:admin:old-tab:saved-layout':JSON.stringify(oldDocument),
      'mw-tv-draft:v3:admin:old-tab:saved-layout':JSON.stringify({draftVersion:3,version:'old-layout',at:1,baseRevision:1,document:oldDocument}),
      ['mw-preference-draft:v1:admin:old-tab:'+encodeURIComponent(preferenceKey)]:JSON.stringify(oldPreference),
      'mw-preference-draft:v1:admin:unreadable':'{broken',
    };
    await context.addInitScript(({drafts}) => {
      // Seed once, so subsequent reloads detect any accidental deletion/rewrite.
      if(!localStorage.getItem('startup-test-seeded')) {
        for(const [key,value] of Object.entries(drafts))localStorage.setItem(key,value);
        localStorage.setItem('mw.last-workspace.v1','saved-layout');
        localStorage.setItem('startup-test-seeded','yes');
      }
    }, {drafts});
    await page.route('**/chart-assets.json', route => route.fulfill({json:{libraryDirectory:'test-library',script:'test-adapter.js'}}));
    await page.route('**/test-library/charting_library.js', route => route.fulfill({contentType:'text/javascript',body:''}));
    await page.route('**/test-adapter.js', route => route.fulfill({contentType:'text/javascript',body:adapterSource}));
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(4);
      const body = req.method() === 'POST' ? req.postDataJSON() : null;
      if(body)mutations.push({path:p,body});
      let result;
      if(p === '/session')result = {csrf:'test-csrf',subject:'admin'};
      else if(p === '/signals/pending-count')result = {count:0};
      else if(p === '/advanced-charts/workspaces')result = [clone(workspace)];
      else if(p === '/advanced-charts/workspaces/saved-layout')result = clone(workspace);
      else if(p === '/advanced-charts/preferences')result = [clone(preference)];
      else if(p === '/advanced-charts/preferences/migrate')result = {ok:true};
      else if(p === '/advanced-charts/catalog')result = [];
      else if(p === '/charts/history-capabilities')result = {};
      else if(p === '/advanced-charts/workspaces/saved-layout/save') {
        assert.equal(body.revision,workspace.revision);
        workspace = {...workspace,revision:workspace.revision+1,document:body.document};
        result = clone(workspace);
      } else if(p === '/advanced-charts/native-charts/save') {
        if(failSave)return route.fulfill({status:409,json:{detail:'revision conflict'}});
        assert.equal(body.revision,workspace.revision);
        workspace = {...workspace,revision:workspace.revision+1,document:{...workspace.document,state:JSON.parse(body.content)}};
        result = clone(workspace);
      } else if(p === '/advanced-charts/preferences/save') {
        assert.equal(body.revision,preference.revision);
        preference = {...preference,...body,revision:preference.revision+1};
        result = clone(preference);
      } else if(p === '/notification-center/events')result = {events:[],after:'0',epoch:'test',unread:0};
      else if(p === '/notification-center/changes')result = {changes:[],after:'0',epoch:'test',more:false,server_time:Date.now()};
      else if(p === '/notification-center/health')result = {at:Date.now(),state:'ready',sound_enabled:false,display_enabled:true};
      else throw Error('Unexpected API request: '+p);
      await route.fulfill({json:result});
    });
    const verify = async () => {
      await expect.poll(() => page.evaluate(() => window.startupProbe?.value.workspace.id)).toBe(workspace.id);
      const init = await page.evaluate(() => JSON.parse(JSON.stringify(window.startupProbe.value)));
      assert.deepEqual(init.document,workspace.document,'only the server-saved layout is loaded');
      assert.deepEqual(init.preference_draft_keys,[],'old drafts cannot suspend new preference saves');
      assert.equal(init.preferences[0].content.value,preference.content.value);
      await expect(page.locator('.advanced-status, .preference-draft-banner, .preference-draft-dialog')).toHaveCount(0);
      assert.equal(await page.getByText(/存在未保存草稿|处理设置草稿|复制恢复/).count(),0);
      assert.equal(await page.locator('.advanced-chart').evaluate(el => el.getBoundingClientRect().top),0,'chart fills the former status-bar space');
      const retained = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key,localStorage.getItem(key)])),Object.keys(drafts));
      assert.deepEqual(retained,drafts,'ignored drafts remain untouched');
    };
    await page.goto(base+'/');
    await expect(page).toHaveURL(/advanced-charts\/saved-layout$/);
    await verify();
    assert.deepEqual(mutations.filter(item => !item.path.endsWith('/migrate')),[],'entering the page never submits old drafts');
    await page.reload();await verify();
    await page.evaluate(async () => {
      const {application,adapter,prefs,value} = window.startupProbe;
      await application.workspace('workspace',{op:'save',args:{id:value.workspace.id,revision:value.workspace.revision,name:value.workspace.name,content:JSON.stringify({layout:'3h',marker:'newly-saved'})}},{id:2},adapter);
      await prefs.savePreference('setting','chart.lastUsedTimeBasedResolution','60');
    });
    assert.equal(workspace.document.state.marker,'newly-saved','old drafts do not block layout saving');
    assert.equal(preference.content.value,'60','old drafts do not block setting saving');
    await page.reload();await verify();
    await page.goto(base+'/advanced-charts/saved-layout');await verify();
    await page.evaluate(() => {
      const {application,adapter,value} = window.startupProbe;
      application.observe({type:'snapshot',document:{...value.document,state:{layout:'2v',marker:'autosaved'}}},adapter);
    });
    await expect.poll(() => workspace.document.state.marker).toBe('autosaved');
    await page.reload();await verify();
    failSave = true;
    const save = () => page.evaluate(async () => {
      const {application,adapter,value} = window.startupProbe;
      try {
        await application.workspace('workspace',{op:'save',args:{id:value.workspace.id,revision:value.workspace.revision,name:value.workspace.name,content:JSON.stringify({layout:'s',marker:'failed-edit'})}},{id:3},adapter);
        return 'unexpected success';
      } catch(error) { return {message:String(error),status:error.status}; }
    });
    assert.equal((await save()).status,409);
    const saveAttempts = () => mutations.filter(item => item.path === '/advanced-charts/native-charts/save').length;
    const attempts = saveAttempts();
    assert.match((await save()).message,/本次保存未完成/,'current-session failures still block unsafe overwrite');
    assert.equal(saveAttempts(),attempts);
    failSave = false;
    await page.reload();await verify();
    assert.equal(workspace.document.state.marker,'autosaved','failed drafts are ignored on reload');
    assert.deepEqual(errors,[]);
    console.log('PASS saved-layout startup: root/direct/reload load server layout and settings, no top bar/recovery, old drafts untouched, manual/automatic saves work, current-session conflict remains protected');
    await context.close();
  } finally {
    await browser?.close();
    if(server)await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {console.error(error);process.exitCode=1;});
