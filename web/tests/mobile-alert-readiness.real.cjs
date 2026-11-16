// Actual persistent development API + deployed UI. Business writes are denied.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium,expect}=require('@playwright/test');
const credentials=JSON.parse(fs.readFileSync(process.env.MW_ALERT_CREDENTIALS||path.join(process.env.HOME,'.local/share/market-watch-dev/credentials.json')));
const origin=credentials.base_url;
const out=process.env.MW_ALERT_UI_OUTPUT||'/tmp/mw-alert-readiness-20261116/deployed-ui';
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch();
  const context=await browser.newContext({viewport:{width:375,height:880},isMobile:true,hasTouch:true,ignoreHTTPSErrors:true,serviceWorkers:'block'});
  const proof={host:'Ubuntu local Docker',origin,errors:[],blockedWrites:[],screenshots:[],checks:[]};
  const page=await context.newPage();page.on('pageerror',e=>proof.errors.push(e.message));
  try{
    const login=await context.request.post(origin+'/api/login',{data:{password:credentials.login_password}});assert(login.ok());
    const rr=await context.request.get(origin+'/api/chart-alerts');assert(rr.ok());const rows=await rr.json();
    const selected=rows.find(r=>r.status==='active')||rows[0];assert(selected,'existing rule for read-only observation');
    proof.rule={id:selected.id,status:selected.status,version:selected.version,run:selected.run,count:selected.count};
    await context.route('**/api/**',route=>{
      const r=route.request();
      if(['GET','HEAD','OPTIONS'].includes(r.method()))return route.continue();
      proof.blockedWrites.push({method:r.method(),path:new URL(r.url()).pathname});return route.abort('blockedbyclient');
    });
    if(process.env.MW_ALERT_UI_DIST){
      const dist=path.resolve(process.env.MW_ALERT_UI_DIST);
      await context.route('**/*',route=>{
        const url=new URL(route.request().url());if(url.pathname.startsWith('/api/'))return route.fallback();
        let file=path.join(dist,decodeURIComponent(url.pathname));
        if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
        if(!fs.existsSync(file)&&url.pathname.startsWith('/m/'))file=path.join(dist,'m/index.html');
        if(!file.startsWith(dist+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
        return route.fulfill({status:200,contentType:{'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
      });
    }
    async function shot(name){await page.waitForTimeout(400);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(out,name+'.png')});proof.screenshots.push(name+'.png');}
    await page.goto(origin+'/m/more');
    await expect(page.getByRole('button',{name:/显示主题/})).toBeVisible();
    // Let the initial IndexedDB appearance restore finish before changing it.
    await page.waitForTimeout(400);
    for(const [theme,width,font] of [['light',375,14],['dark',412,21]]){
      await page.getByRole('link',{name:'更多',exact:true}).click();
      if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();
      await expect(page.locator('.mobile-app')).toHaveAttribute('data-theme',theme);
      await page.setViewportSize({width,height:880});await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);
      await page.locator('a[href="/m/alerts"]').click();
      if(!['active','paused'].includes(selected.status)&&!selected.execution?.settlement_pending){
        await page.getByRole('button',{name:'搜索规则',exact:true}).click();
        const filters=page.getByRole('dialog',{name:'搜索规则',exact:true});
        await filters.getByRole('combobox',{name:'规则范围',exact:true}).click();
        await page.getByRole('option',{name:'全部未归档',exact:true}).click();
        await filters.getByRole('button',{name:'查看规则',exact:true}).click();
        await expect(filters).toHaveCount(0);
      }
      const row=page.locator('.alert-rule').filter({has:page.getByRole('button',{name:'查看'+selected.name,exact:true})});
      await expect(row).toBeVisible();
      if(selected.status==='active'){
        await expect(row.getByRole('switch')).toBeChecked();
        await expect(row).toContainText(/监控中|休市|等待数据|需处理|准备中|结算中|恢复中/);
        await expect(row).not.toContainText(/服务未开启|尚未接管|状态待确认/);
      }else{
        await expect(row).toContainText({paused:'已暂停',completed:'次数已用完',expired:'已到期'}[selected.status]);
        await expect(row).not.toContainText('监控中');
      }
      await expect(page.locator('.mobile-app')).toHaveCSS('background-color',theme==='dark'?'rgb(16, 19, 23)':'rgb(248, 249, 252)');
      await shot(`list-${theme}-${width}`);
      await row.locator('.alert-rule-open').click();const detail=page.getByRole('dialog',{name:'规则详情',exact:true});
      await expect(detail.getByText(/^(最近|上次)检查$/).first()).toBeVisible();
      await expect(detail.getByText('最近判定',{exact:true}).first()).toBeVisible();
      await expect(detail.getByRole('button',{name:'排查信息',exact:true})).toHaveAttribute('aria-expanded','false');
      await shot(`detail-${theme}-${width}`);
      await detail.getByRole('button',{name:'关闭',exact:true}).click();await expect(detail).toHaveCount(0);
      proof.checks.push(`${width}px ${theme} ${font}px: 保留原规则${selected.status}、真实生命周期、检查/判定首屏、排查默认收起`);
    }
    assert.deepEqual(proof.errors,[]);assert.deepEqual(proof.blockedWrites,[]);proof.passed=true;
    fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
  }catch(e){await page.screenshot({path:path.join(out,'failure.png')});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify(proof,null,2));throw e;}
  finally{await context.close();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
