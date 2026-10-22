// Read-only smoke against the explicitly authorized long-term acceptance instance.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, expect} = require(path.join(process.cwd(), 'web/node_modules/@playwright/test'));
const base = 'https://192.168.7.232:18280';
const chart = 'https://192.168.7.232:18281';
const workspace = '7d72eead-6be5-41a4-b3d5-bfdfff98b2bb';
const output = path.join(process.cwd(), 'artifacts/composite-mapping-v2/mwa-mapping');
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
      ['/api/market-data/resolve','/api/market-data/quotes','/api/market-data/history-catalog/refresh'].includes(pathname) || pathname.endsWith('/mapping-check')) return route.continue();
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
    const selected = [];
    const fx = eligible.find(x => ['EURUSD','USDCAD'].includes(x.dataset.logical_symbol));
    const gold = eligible.find(x => x.dataset.logical_symbol==='XAUUSD');
    if (fx) selected.push(fx);
    if (gold) selected.push(gold);
    assert.ok(selected.length,'existing fixed-history candidate available');
    report.availableStandardFx = !!fx;
    report.symbols = selected.map(x => x.dataset.logical_symbol);
    const allBefore = {};
    for (const candidate of selected) {
      const dataset = candidate.dataset;
      const mappingPath='/market-data/datasets/'+encodeURIComponent(dataset.id)+'/mappings';
      allBefore[mappingPath] = await get(mappingPath);
      await host().evaluate(()=>dataCenter.open('/market-data'));
      await dc().getByRole('button',{name:'组合行情',exact:true}).click();
      await dc().getByRole('button',{name:'可建立候选',exact:true}).click();
      await expect(dc().getByText('建立条件',{exact:true})).toBeVisible();
      await dc().locator('[id="candidate-'+dataset.id+'"]').getByRole('link',{name:'配置实时来源',exact:true}).click();
      await expect(dc().getByRole('heading',{name:/^配置实时来源/})).toBeVisible();
      await expect(dc().getByText('① 选择实时品种',{exact:true})).toBeVisible();
      assert.equal(await native().locator('[data-dialog-name="选择 OANDA Practice 品种"]').count(),0);
      assert.equal(await dc().getByRole('button',{name:'来源',exact:true}).count(),0);
      const catalog=await get('/market-data/history-catalog?source=oanda&query='+encodeURIComponent(dataset.logical_symbol)+'&page_size=50');
      const exact=catalog.items.find(x=>x.provider_symbol.replace(/[_/]/g,'')===dataset.logical_symbol);
      assert.ok(exact,'exact real current-account catalog entry');
      await dc().getByRole('searchbox',{name:'搜索品种'}).fill(exact.provider_symbol);
      await dc().locator('[data-symbol-name="'+exact.catalog_id+'"]').getByRole('button',{name:/^(选择|已选择)$/}).click();
      await dc().getByRole('button',{name:'配置实时 →',exact:true}).click();
      await expect(dc().getByText('② 配置并创建',{exact:true})).toBeVisible();
      if (dataset.logical_symbol==='XAUUSD') {
        await expect(dc().getByText(/Dukascopy 滚动黄金 CFD/)).toBeVisible();
        const confirmation=dc().getByRole('checkbox',{name:/确认.*黄金报价产品差异/});
        await expect(confirmation).not.toBeChecked();
        await expect(dc().getByRole('button',{name:'仅保存配置',exact:true})).toBeDisabled();
        await confirmation.check();
      } else assert.equal(await dc().getByRole('checkbox').count(),0);
      await expect(dc().getByRole('status').filter({hasText:'可以创建'})).toBeVisible({timeout:30000});
      assert.equal(await dc().getByLabel('备注（选填）',{exact:true}).evaluate(n=>n.tagName==='TEXTAREA' && !n.required && !!n.closest('[data-native-component="textarea"]')),true);
      await dc().getByLabel('备注（选填）',{exact:true}).fill('仅浏览，不保存');
      for (const theme of ['Dark','Light']) {
        await host().evaluate(theme=>widget.changeTheme(theme),theme);
        await expect(dc()).toHaveAttribute('data-theme',theme.toLowerCase());
        await page.screenshot({path:path.join(output,dataset.logical_symbol+'-'+theme.toLowerCase()+'.png')});
      }
      await dc().getByRole('button',{name:'查看匹配详情',exact:true}).click();
      await expect(dc().getByText('Dukascopy 历史报价来源',{exact:true})).toBeVisible();
      await expect(dc().getByLabel('补充历史产品资料（选填）',{exact:true})).toHaveValue('');
      await dc().getByRole('button',{name:'收起匹配详情',exact:true}).click();
      await page.setViewportSize({width:390,height:844});
      await expect(dc().getByRole('button',{name:'仅保存配置',exact:true})).toBeInViewport();
      assert.equal(await dc().evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
      await page.screenshot({path:path.join(output,dataset.logical_symbol+'-mobile.png')});
      await native().getByRole('button',{name:'关闭数据中心',exact:true}).click();
      await dc().getByRole('button',{name:'放弃修改',exact:true}).click();
      await expect(dc()).toHaveCount(0);
      assert.deepEqual(await get(mappingPath),allBefore[mappingPath]);
      await page.setViewportSize({width:1440,height:1000});
      record(dataset.logical_symbol+': real OANDA two-step selection, server rules, optional note/evidence, native controls, themes, mobile and discard');
    }
    assert.deepEqual(await get('/advanced-charts/workspaces/'+workspace),before);
    assert.equal(report.blockedWrites.filter(x=>x.path.startsWith('/api/market-data/')).length,0);
    report.workspaceUnchanged=true;
    report.mappingsUnchanged=true;
    report.revision=before.revision;
    record('discard leaves complete workspace and mapping lists unchanged; no mapping/composite writes');
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
