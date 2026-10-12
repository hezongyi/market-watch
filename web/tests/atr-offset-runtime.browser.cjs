// Actual Ubuntu Docker API, licensed widget, collection/worker and local notification sink.
// Supplier OHLC is controlled by scripts/atr_offset_acceptance_api.py; no HTTP route mocks.
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const APP = 'https://localhost:17443', CHART = 'https://localhost:17444';
const PRIVATE = '/tmp/mw-atr-offset-20261012-private', STATE = PRIVATE + '/evidence';
const COMPOSE = 'docker compose --env-file ' + PRIVATE + '/compose.env -p mw-atr-offset-20261012 -f deploy/ubuntu/atr-offset.acceptance.yaml';
const compose = action => execFileSync('sg', ['docker', '-c', COMPOSE + ' ' + action], {stdio: 'pipe'});
const control = price => fs.writeFileSync(STATE + '/control.json', JSON.stringify({price}));
(async () => {
  control('100');
  const priceName='ATR runtime price '+Date.now();
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox']});
  const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1600, height: 1000}});
  const page = await context.newPage();
  const report = {scope: 'quant-server Ubuntu Docker, actual API/cache/worker/licensed widget; synthetic Binance OHLC and task-local ntfy sink', cases: []};
  const errors = [], leaks = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => {if(r.url().startsWith(CHART + '/') && (r.headers().cookie || r.headers().authorization)) leaks.push(new URL(r.url()).pathname);});
  const until = async (check, label) => {for(let i=0;i<120;i++){if(await check())return;await page.waitForTimeout(500);}throw Error(label);};
  const api = (path, body) => page.evaluate(async ({path, body}) => {
    const session = await (await fetch('/api/session')).json();
    const r = await fetch('/api' + path, body ? {method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify(body)} : {});
    if(!r.ok)throw Error(path+' '+r.status+' '+await r.text());return r.json();
  }, {path,body});
  let frame, ui, dialog;
  const chartReady = async () => {
    await until(async () => {frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));return !!frame;}, 'chart iframe');
    await frame.waitForFunction(()=>typeof ready !== "undefined" && ready && !loading && alertUI && widget.activeChart().dataReady(), null, {timeout:60000});
    await until(async()=>{ui=frame.childFrames()[0];return !!ui;},'native alert renderer');
    dialog=ui.locator('[data-name="mw-native-alert-dialog"]');
  };
  const select = async (label, option) => {
    if(label==='判定')await dialog.locator('.alert-advanced-options').evaluate(n=>n.open=true);
    await dialog.getByRole('button',{name:label,exact:true}).click();
    await ui.getByRole('option',{name:option,exact:true}).click();
  };
  const name = async value => {
    await dialog.getByRole('button',{name:'消息',exact:true}).click();
    await dialog.getByLabel('警报名称',{exact:true}).fill(value);
    await dialog.getByLabel('消息正文',{exact:true}).fill(value);
    await dialog.getByRole('button',{name:'应用到草稿',exact:true}).click();
  };
  const save = async edit => {
    const response=page.waitForResponse(r=>r.url().includes('/api/chart-alerts') && r.request().method()==='POST' && (edit?r.url().endsWith('/edit'):r.url().endsWith('/chart-alerts')));
    await dialog.getByRole('button',{name:edit?'保存新版本':'创建告警',exact:true}).click();
    const r=await response;assert.equal(r.status(),edit?200:201,await r.text());
    const row=await r.json();await dialog.waitFor({state:'hidden'});return row;
  };
  try {
    await page.goto(APP+'/');
    await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(PRIVATE+'/credentials.json')).password);
    await page.getByRole('button',{name:'登录工作台'}).click();
    await until(async()=>!await page.getByLabel('管理员密码').count(),'login');
    const workspace=await api('/advanced-charts/workspaces',{name:'ATR offset isolated acceptance'});
    await api('/advanced-charts/workspaces/'+workspace.id+'/save',{name:workspace.name,revision:workspace.revision,document:{engine:'tv31',schemaVersion:1,symbol:'MWP:BTCUSDT',interval:'240'}});
    for (const old of await api('/chart-alerts')) {
      await api('/chart-alerts/'+old.id+'/lifecycle',{version:old.version,control_revision:old.control_revision,request_id:'atr-acceptance-archive-'+old.id,action:'archive'});
    }
    await page.goto(APP+'/advanced-charts');
    await chartReady();
    report.cases.push('HTTPS login, real H4 licensed chart and native React renderer');
    await frame.evaluate(()=>alertBridge.create());
    await dialog.waitFor();
    await name(priceName);
    await dialog.getByLabel('比较值',{exact:true}).fill('100');
    await select('关系','上穿');
    await select('判定','盘中观察');
    await select('触发次数','最多 2 次');
    await dialog.getByRole('button',{name:'通知',exact:true}).click();
    await dialog.getByLabel('已有 ntfy 推送通道',{exact:true}).check();
    await dialog.getByRole('button',{name:'应用到草稿',exact:true}).click();
    await select('突破阈值','ATR');
    assert.match(await dialog.getByRole('button',{name:'ATR K线周期',exact:true}).innerText(),/D1/);
    assert.equal(await dialog.getByLabel('ATR 计算长度',{exact:true}).inputValue(),'14');
    assert.equal(await dialog.getByLabel('ATR 乘数',{exact:true}).inputValue(),'0.2');
    const price=await save(false);
    report.price_alert=price.id;
    assert.equal(price.config.timeframe,'H4');assert.equal(price.config.condition.offset.timeframe,'D1');
    await until(async()=>(await api('/chart-alerts/'+price.id)).health==='ready','H4/D1 initialized');
    assert.equal((await api('/chart-alerts/'+price.id)).count,0);
    const article=ui.locator('.chart-alert-card').filter({hasText:priceName});
    await article.getByRole('button',{name:'编辑',exact:true}).click();
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel('ATR 乘数',{exact:true}).inputValue(),'0.2');
    await dialog.getByLabel('ATR 乘数',{exact:true}).fill('0.3');
    const edited=await save(true);assert.equal(edited.config.condition.offset.multiplier,'0.3');
    await article.getByRole('button',{name:'暂停',exact:true}).click();
    await until(async()=>(await api('/chart-alerts/'+price.id)).status==='paused','paused');
    await article.getByRole('button',{name:'恢复',exact:true}).click();
    await until(async()=>(await api('/chart-alerts/'+price.id)).health==='ready','resumed baseline');
    report.cases.push('default D1/14/0.2 persists; real edit to 0.3 and pause/resume retain offset');
    const drawing=await frame.evaluate(async()=>{
      const c=widget.activeChart();const r=c.getVisibleRange();
      const id=await c.createShape({time:r.to-14400,price:100},{shape:'horizontal_line'});
      c.getShapeById(id).setProperties({linecolor:'#00cc00',linewidth:4});
      await alertBridge.create({chart:c,object:{type:'shape',id}});return id;
    });
    await dialog.waitFor();await name('ATR runtime drawing');
    await select('关系','上穿');await select('突破阈值','ATR');
    let drawingRow=await save(false);report.drawing_alert=drawingRow.id;
    await until(async()=>await frame.evaluate(id=>alertBridge.diagnostics().rows.some(r=>r.id===id),drawingRow.id),'drawing bound');
    await frame.evaluate(id=>{const s=widget.activeChart().getShapeById(id);s.setPoints([{time:s.getPoints()[0].time,price:101}]);s.setProperties({linecolor:'#00cc00'});},drawing);
    await until(async()=>(await api('/chart-alerts/'+drawingRow.id)).version===2,'drawing edit');
    drawingRow=await api('/chart-alerts/'+drawingRow.id);assert.equal(drawingRow.config.condition.offset.multiplier,'0.2');
    assert.equal(Number(drawingRow.config.condition.right.line.points[0].price),101);
    report.cases.push('licensed horizontal line edit creates new version and retains ATR');
    await page.screenshot({path:STATE+'/drag-before.png'});
    const box=await page.locator('iframe[title="专业图表工作区"]').boundingBox();
    const x=Math.round(box.x+box.width*0.45);
    const y=Number(execFileSync('/tmp/mw-native-alert-python311/bin/python',['-c',
      "from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert('RGB'); x=int(sys.argv[2]); ys=[y for y in range(90,850) if (lambda r,g,b:r<30 and 150<g<230 and b<30)(*im.getpixel((x,y)))]; assert ys, 'visible native green line'; print(sum(ys)/len(ys))",
      STATE+'/drag-before.png',String(x)],{encoding:'utf8'}));
    let dragWrites=0;page.on('request',r=>{if(r.url().endsWith('/chart-alerts/'+drawingRow.id+'/edit'))dragWrites++;});
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y-24,{steps:12});
    await page.waitForTimeout(200);assert.equal(dragWrites,0,'no save during drag');await page.mouse.up();
    await until(async()=>(await api('/chart-alerts/'+drawingRow.id)).version>2,'mouse drag saved');
    drawingRow=await api('/chart-alerts/'+drawingRow.id);assert.equal(drawingRow.config.condition.offset.multiplier,'0.2');
    assert.notEqual(Number(drawingRow.config.condition.right.line.points[0].price),101);
    report.cases.push('actual mouse drag commits after release and retains ATR config');

    await page.reload();await chartReady();
    const persisted=await api('/chart-alerts/'+price.id);assert.equal(persisted.config.condition.offset.multiplier,'0.3');
    assert.equal((await api('/chart-alerts/'+drawingRow.id)).config.condition.offset.timeframe,'D1');
    await page.screenshot({path:STATE+'/runtime.png'});
    report.cases.push('page refresh restores saved config and drawing version');
    // Close every browser before testing autonomous collection and actual delivery.
    await context.close();
    const callsBefore=fs.readFileSync(STATE+'/supplier-calls.jsonl','utf8').trim().split('\n').length;
    await new Promise(r=>setTimeout(r,3000));
    control('104');
    let notes=[];
    for(let i=0;i<40;i++){
      await new Promise(r=>setTimeout(r,1000));
      if(fs.existsSync(STATE+'/notifications.jsonl'))notes=fs.readFileSync(STATE+'/notifications.jsonl','utf8').trim().split('\n').map(JSON.parse);
      if(notes.some(n=>n.message.includes(priceName)))break;
    }
    assert.equal(notes.filter(n=>n.message.includes(priceName)).length,1,'one real ntfy delivery');
    const delivered=notes.find(n=>n.message.includes(priceName)).message;
    assert.match(delivered,/比较值 101\.20*/);
    assert.match(delivered,/原目标 100/);assert.match(delivered,/ATR 4/);assert.match(delivered,/偏移 1\.20*/);
    const background=fs.readFileSync(STATE+'/supplier-calls.jsonl','utf8').trim().split('\n').slice(callsBefore).map(JSON.parse);
    assert.ok(background.some(c=>c.frame==='H4'));assert.ok(background.some(c=>c.frame==='D1'));
    compose('restart api alert-worker notify-worker');
    await new Promise(r=>setTimeout(r,6000));
    notes=fs.readFileSync(STATE+'/notifications.jsonl','utf8').trim().split('\n').map(JSON.parse);
    assert.equal(notes.filter(n=>n.message.includes(priceName)).length,1,'restart does not duplicate delivery');
    report.cases.push('all browsers closed: both H4/D1 supplier reads continue; actual worker sends one ntfy message; restart keeps one');
    report.errors=errors;report.credentials_sent_to_chart=leaks;
    assert.deepEqual(errors,[]);assert.deepEqual(leaks,[]);
    fs.writeFileSync(STATE+'/runtime-browser.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } catch(error) {
    if(!page.isClosed())await page.screenshot({path:STATE+'/runtime-failure.png'});
    throw error;
  } finally {control('100');await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
