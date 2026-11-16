// Read-only inspection of this task's Ubuntu acceptance instance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, expect} = require('@playwright/test');
const task = 'mw-managed-live-rollover-20261113';
const origin = process.env.MW_SETTINGS_ORIGIN || 'https://192.168.7.232:18447';
assert(['https://192.168.7.232:18447','https://127.0.0.1:18447'].includes(origin));
const out = process.env.MW_SETTINGS_OUTPUT || '/tmp/mw-data-settings-20261116/deployed';
fs.mkdirSync(out,{recursive:true});
const privateDir = path.join(process.env.HOME,'.local/share/market-watch-docker/previews',task);
(async()=>{
  const browser = await chromium.launch();
  const context = await browser.newContext({viewport:{width:375,height:880},isMobile:true,hasTouch:true,serviceWorkers:'block',ignoreHTTPSErrors:true});
  const proof = {origin,staticSource:process.env.MW_SETTINGS_DIST?'local candidate':'deployed',checks:[],errors:[],blockedWrites:[],screenshots:[]};
  try {
    const response = await context.request.post(origin+'/api/login',{data:{password:JSON.parse(fs.readFileSync(path.join(privateDir,'credentials.json'))).login_password}});
    assert(response.ok(),'task login');
    const summary = await context.request.get(origin+'/api/market-data/center/dataset-summaries?mobile=true&page_size=100');
    assert(summary.ok());
    const data = await summary.json();
    const selected = data.items.find(d=>d.continuation?.enabled);
    assert(selected,'existing enabled dataset for read-only verification');
    // Deny configuration, maintenance, watchlist and other business writes.
    await context.route('**/api/**',route=>{
      const request=route.request(), url=new URL(request.url());
      if(['GET','HEAD','OPTIONS'].includes(request.method()) || request.method()==='POST' && /^\/api\/market-data\/(quotes|sparklines)$/.test(url.pathname))return route.continue();
      proof.blockedWrites.push({path:url.pathname,method:request.method()});return route.abort('blockedbyclient');
    });
    if(process.env.MW_SETTINGS_DIST) {
      const dist=path.resolve(process.env.MW_SETTINGS_DIST);
      await context.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.pathname.startsWith('/api/')||url.pathname==='/readyz')return route.fallback();
        let file=path.join(dist,decodeURIComponent(url.pathname));
        if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
        if(!fs.existsSync(file)&&url.pathname.startsWith('/m/'))file=path.join(dist,'m/index.html');
        if(!file.startsWith(dist+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
        return route.fulfill({status:200,contentType:{'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
      });
    }
    const page=await context.newPage();page.on('pageerror',e=>proof.errors.push(e.message));
    async function shot(name) {
      await page.waitForTimeout(400);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no page overflow');
      const drawer=page.getByRole('dialog',{name:'自建行情',exact:true});
      if(await drawer.count()) assert(await drawer.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'no drawer overflow');
      await page.screenshot({path:path.join(out,name+'.png')});proof.screenshots.push(name+'.png');
    }
    for(const [theme,width,font] of [['light',375,14],['dark',412,21]]) {
      await page.goto(origin+'/m/more');
      if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();
      await page.setViewportSize({width,height:880});
      await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);
      await page.getByRole('link',{name:'数据',exact:true}).click();
      const row=page.locator('#managed-'+selected.id);
      await expect(row).toBeVisible();
      await expect(row.getByRole('switch')).toBeChecked();
      await expect(row.locator('.data-managed-status small')).toHaveText(/实时已开启|实时需处理/);
      await expect(row.locator('.data-maintenance-summary')).toHaveText(/维护已配置|维护已暂停|维护需处理|维护待配置/);
      await expect(row).not.toContainText(/实时恢复中|实时认证异常|实时运行中/);
      await shot(`list-${theme}-${width}-${font}`);
      await row.locator('.data-managed-open').click();
      const detail=page.getByRole('dialog',{name:'自建行情',exact:true});
      await expect(detail.locator('.data-live-summary')).toHaveText(/已开启/);
      await expect(detail.getByText('维护设置',{exact:true})).toHaveCount(2);
      const runtime=detail.getByRole('button',{name:'最近运行情况',exact:true});
      await expect(runtime).toHaveAttribute('aria-expanded','false');
      await shot(`detail-${theme}-${width}-${font}`);
      await runtime.click();
      await expect(runtime).toHaveAttribute('aria-expanded','true');
      await runtime.scrollIntoViewIfNeeded();
      await shot(`runtime-${theme}-${width}-${font}`);
      await detail.getByRole('button',{name:'关闭',exact:true}).click();
      await expect(detail).toHaveCount(0);
    }
    proof.checks.push('真实配置保持开启，列表稳定呈现维护设置；运行详情默认收起、展开及关闭通过','375px浅色及412px深色150%字号截图无横向溢出');
    assert.deepEqual(proof.errors,[]);assert.deepEqual(proof.blockedWrites,[]);
    proof.passed=true;
    fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify(proof,null,2));
    console.log(JSON.stringify(proof));
  } catch(error) {
    await context.pages()[0]?.screenshot({path:path.join(out,'failure.png')});
    fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify(proof,null,2));throw error;
  } finally {await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
