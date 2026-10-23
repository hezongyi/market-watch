// Read-only smoke against the explicitly authorized long-term acceptance instance.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, expect} = require(path.join(process.cwd(), 'web/node_modules/@playwright/test'));
const base = 'https://192.168.7.232:18280';
const chart = 'https://192.168.7.232:18281';
const workspace = '7d72eead-6be5-41a4-b3d5-bfdfff98b2bb';
const output = path.join(process.cwd(), 'artifacts/composite-mapping-native/mwa-mapping');
fs.mkdirSync(output, {recursive:true});
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ignoreHTTPSErrors:true, viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const report = {at:new Date().toISOString(), target:base, checks:[], errors:[], blockedWrites:[], passed:false};
  page.on('pageerror', error => report.errors.push(error.message));
  const record = name => {report.checks.push(name);console.log('PASS',name);};
  const host = () => page.frames().find(f => f.url().startsWith(chart+'/?'));
  const native = () => page.frames().find(f => f.url().startsWith('blob:'));
  const dc = () => native().locator('.dc-window');
  const get = async endpoint => {
    const r = await context.request.get(base+'/api'+endpoint);
    assert.equal(r.status(),200,endpoint);
    return r.json();
  };
  await context.route('**/api/advanced-charts/**', async route => {
    const request=route.request(), pathname=new URL(request.url()).pathname;
    if (['GET','HEAD','OPTIONS'].includes(request.method()) || pathname.endsWith('/preferences/migrate')) return route.continue();
    report.blockedWrites.push({path:pathname, method:request.method()});
    if (pathname.endsWith('/preferences/save')) {
      const body=request.postDataJSON();
      return route.fulfill({json:{...body,id:'inspection-only',revision:body.revision+1,updated_at:Date.now()}});
    }
    return route.fulfill({status:409,json:{detail:'Read-only acceptance inspection'}});
  });
  await context.route('**/api/market-data/**', async route => {
    const pathname=new URL(route.request().url()).pathname;
    if (['GET','HEAD','OPTIONS'].includes(route.request().method()) ||
      ['/api/market-data/resolve','/api/market-data/quotes'].includes(pathname)) return route.continue();
    report.blockedWrites.push({path:new URL(route.request().url()).pathname,method:route.request().method()});
    return route.fulfill({status:409,json:{detail:'Read-only acceptance inspection'}});
  });
  await context.route('**/api/chart-alerts/**', async route => {
    if (['GET','HEAD','OPTIONS'].includes(route.request().method())) return route.continue();
    throw Error('Unexpected alert mutation');
  });
  try {
    await page.goto(base+'/advanced-charts/'+workspace);
    const password=JSON.parse(fs.readFileSync('/home/quant/repos/.mwa-composite-mapping-20261021/browser-login.json')).password;
    await page.getByLabel('管理员密码').fill(password);
    await page.locator('button.auth-submit').click();
    await expect.poll(() => !!host() && !!native(),{timeout:60000}).toBe(true);
    await host().waitForFunction(() => typeof ready!=='undefined' && ready && !loading, null,{timeout:60000});
    const before = await get('/advanced-charts/workspaces/'+workspace);
    record('real mwa UI login and native chart startup');
    const candidates = await get('/market-data/center/composite-candidates?page_size=100');
    const eligible = candidates.items.filter(x => x.status!=='needs_maintenance');
    const candidate = eligible.find(x => x.dataset.logical_symbol==='XAUUSD') || eligible[0];
    assert.ok(candidate,'existing fixed-history candidate available');
    const dataset=candidate.dataset;
    report.symbol=dataset.logical_symbol;
    const mappingPath='/market-data/datasets/'+encodeURIComponent(dataset.id)+'/mappings';
    const mappingsBefore=await get(mappingPath);
    await host().evaluate(()=>dataCenter.open('/market-data'));
    await dc().getByRole('button',{name:'组合行情',exact:true}).click();
    await dc().getByRole('button',{name:'可建立候选',exact:true}).click();
    const row=dc().locator('[id="candidate-'+dataset.id+'"]');
    await row.getByRole('link',{name:'配置实时来源',exact:true}).click();
    await expect(dc().getByRole('heading',{name:/^配置实时来源/})).toBeVisible();
    await expect(dc().getByText('当前账户目录已读取',{exact:true})).toBeVisible();
    record('composite candidate row navigates to the new mapping page with real account directory');
    const catalog=await get('/market-data/history-catalog?source=oanda&query='+encodeURIComponent(dataset.logical_symbol)+'&page_size=50');
    const code=dataset.logical_symbol.replace('/','');
    const exact=catalog.items.find(x=>x.provider_symbol.replace(/[_/]/g,'')===code);
    assert.ok(exact,'exact real source catalog entry');
    await dc().getByRole('button',{name:/^(选择品种|更换)$/}).click();
    const picker=native().locator('[data-dialog-name="选择 OANDA Practice 品种"]');
    await expect(picker).toBeVisible();
    await picker.getByRole('searchbox').fill(exact.provider_symbol);
    await picker.locator('[data-symbol-name="'+exact.catalog_id+'"]').click();
    await expect(picker).toHaveCount(0);
    await expect(dc().getByRole('checkbox')).not.toBeChecked();
    assert.equal(await dc().getByRole('searchbox').count(),0);
    for(const name of ['仅保存','保存并打开图表','刷新目录']) {
      assert.equal(await dc().getByRole('button',{name,exact:true}).evaluate(n=>!!n.closest('[data-native-component="button"]')),true);
    }
    record('single real native symbol picker, native actions and fresh manual review');
    await dc().getByRole('button',{name:/补充说明|查看 \/ 修改/}).click();
    assert.equal(await dc().getByLabel('核对说明',{exact:true}).evaluate(n=>n.tagName==='TEXTAREA' && n.required && !!n.closest('[data-native-component="textarea"]')),true);
    for(const theme of ['Dark','Light']) {
      await host().evaluate(theme=>widget.changeTheme(theme),theme);
      await expect(dc()).toHaveAttribute('data-theme',theme.toLowerCase());
      await dc().locator('.dc-mapping-scroll').evaluate(n=>n.scrollTop=n.scrollHeight);
      await page.screenshot({path:path.join(output,'mapping-proof-'+theme.toLowerCase()+'.png')});
    }
    record('actual native proof controls and light/dark themes');
    await dc().getByRole('button',{name:'收起',exact:true}).click();
    await dc().locator('.dc-mapping-scroll').evaluate(n=>n.scrollTop=0);
    await page.screenshot({path:path.join(output,'mapping.png')});
    await page.setViewportSize({width:390,height:844});
    await expect(dc().getByRole('button',{name:'保存并打开图表',exact:true})).toBeInViewport();
    assert.equal(await dc().evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
    await page.screenshot({path:path.join(output,'mapping-mobile.png')});
    record('390px viewport keeps fixed save actions visible without horizontal overflow');
    await native().getByRole('button',{name:'关闭数据中心',exact:true}).click();
    await dc().getByRole('button',{name:'放弃修改',exact:true}).click();
    await expect(dc()).toHaveCount(0);
    assert.deepEqual(await get(mappingPath),mappingsBefore);
    assert.deepEqual(await get('/advanced-charts/workspaces/'+workspace),before);
    assert.equal(report.blockedWrites.filter(x=>x.path.startsWith('/api/market-data/')).length,0);
    report.workspaceUnchanged=true;
    report.mappingsUnchanged=true;
    report.revision=before.revision;
    record('cancel discards draft; saved workspace and mappings remain unchanged');
    assert.deepEqual(report.errors,[]);
    report.passed=true;
  } catch(e) {
    report.failure=e.message;
    await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
    process.exitCode=1;
  } finally {
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
    await browser.close();
  }
})();
