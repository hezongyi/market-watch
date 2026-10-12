// Read-only visual acceptance of the existing Ubuntu task instance.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const PRIVATE = '/tmp/mw-atr-offset-20261012-private';
const OUT = path.join(PRIVATE, 'evidence', 'visual');
const APP = 'https://localhost:17443', CHART = 'https://localhost:17444';
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const prior = JSON.parse(fs.readFileSync(PRIVATE + '/evidence/runtime-browser.json'));
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args:['--no-sandbox']});
  const context = await browser.newContext({ignoreHTTPSErrors:true, viewport:{width:1600,height:1000}});
  const page = await context.newPage();
  const report = {scope:'Actual HTTPS login and existing Ubuntu Docker rules/events; no API mocks', screenshots:[], errors:[], alert_writes:[]};
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('request', r => {
    const pathname = new URL(r.url()).pathname;
    // Capabilities is a read-only POST used when selecting a rule condition.
    if(pathname.startsWith('/api/chart-alerts') && pathname !== '/api/chart-alerts/capabilities' && r.method() !== 'GET') report.alert_writes.push(r.method() + ' ' + pathname);
  });
  const shot = async (name, locator) => {
    await page.waitForTimeout(250);
    await (locator || page).screenshot({path:path.join(OUT,name+'.png')});
    report.screenshots.push(name+'.png');
    console.log('captured '+name);
  };
  try {
    await page.goto(APP+'/');
    await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(PRIVATE+'/credentials.json')).password);
    await page.getByRole('button',{name:'登录工作台'}).click();
    await expect(page.getByLabel('管理员密码')).toHaveCount(0);
    const row = await page.evaluate(async id => (await fetch('/api/chart-alerts/'+id)).json(), prior.price_alert);
    assert.equal(row.config.condition.offset.multiplier,'0.3');
    report.price_rule = {version:row.version,health:row.health,count:row.count};
    await page.goto(APP+'/advanced-charts');
    await expect(page.locator('iframe[title="专业图表工作区"]')).toBeVisible();
    let host;
    for(let i=0;i<120;i++){host=page.frames().find(f=>f.url().startsWith(CHART+'/'));if(host)break;await page.waitForTimeout(500);}
    assert.ok(host);
    await host.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&alertUI&&widget.activeChart().dataReady(),null,{timeout:60000});
    const ui=host.childFrames()[0];
    const dialog=ui.locator('[data-name="mw-native-alert-dialog"]');
    await host.evaluate(()=>alertUI.open());
    const article=ui.locator('.chart-alert-card').filter({hasText:row.config.name});
    await article.locator('.alert-row-summary').click();
    await expect(article).toContainText('已触发 1 / 2 次');
    await expect(article).toContainText('ATR');
    await shot('01-rule-chart');
    await article.getByRole('button',{name:'编辑',exact:true}).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('ATR 乘数',{exact:true})).toHaveValue('0.3');
    await shot('02-edit-dark');
    await dialog.getByRole('button',{name:'消息',exact:true}).click();
    await expect(dialog.getByLabel('警报名称',{exact:true})).toHaveValue(row.config.name);
    await shot('03-message');
    await dialog.getByRole('button',{name:'返回',exact:true}).click();
    await dialog.getByRole('button',{name:'通知',exact:true}).click();
    await expect(dialog.getByLabel('已有 ntfy 推送通道',{exact:true})).toBeChecked();
    await shot('04-notification');
    await dialog.getByRole('button',{name:'返回',exact:true}).click();
    await host.evaluate(()=>widget.changeTheme('Light'));
    await expect(dialog.locator('[data-theme="light"]')).toBeVisible();
    await shot('05-edit-light');
    await dialog.getByRole('button',{name:'取消（保留草稿）',exact:true}).click();
    await host.evaluate(()=>widget.changeTheme('Dark'));
    await host.evaluate(()=>alertBridge.create());
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('ATR 乘数',{exact:true})).toHaveCount(0);
    await shot('06-create-offset-off');
    await dialog.getByRole('button',{name:'突破阈值',exact:true}).click();
    await ui.getByRole('option',{name:'ATR',exact:true}).click();
    await expect(dialog.getByRole('button',{name:'ATR K线周期',exact:true})).toContainText('D1');
    await expect(dialog.getByLabel('ATR 计算长度',{exact:true})).toHaveValue('14');
    await expect(dialog.getByLabel('ATR 乘数',{exact:true})).toHaveValue('0.2');
    await shot('07-create-offset-defaults');
    await dialog.getByRole('button',{name:'取消（保留草稿）',exact:true}).click();
    const drawing=ui.locator('.chart-alert-card').filter({hasText:'ATR runtime drawing'});
    await drawing.locator('.alert-row-summary').click();
    await expect(drawing).toContainText('等待安全恢复基准');
    await shot('08-drawing-wait');
    await ui.getByRole('tab',{name:'日志',exact:true}).click();
    const event=ui.locator('.chart-alert-card').filter({hasText:row.config.name});
    await event.locator('.alert-row-summary').click();
    await expect(event).toContainText('101.2');
    await expect(event).toContainText('ATR');
    await shot('09-event');
    await event.locator('summary').click();
    await shot('10-event-evidence');
    // A focused capture preserves readability of the lower evidence section.
    await shot('11-event-evidence-detail',event);
    assert.deepEqual(report.errors,[]);
    assert.deepEqual(report.alert_writes,[]);
    fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
