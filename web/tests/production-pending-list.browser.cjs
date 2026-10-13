// Built React data-center UI with controlled read responses; Docker gate is separate.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const dist=path.resolve(__dirname,'../dist');
(async()=>{
 const browser=await chromium.launch({executablePath:chromium.executablePath(),args:['--no-sandbox']});
 try {
  const page=await browser.newPage({viewport:{width:1450,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://mw-list.invalid/**',r=>{
   const u=new URL(r.request().url());
   if(u.pathname==='/')return r.fulfill({contentType:'text/html; charset=utf-8',body:'<html><head><meta charset="utf-8"><link rel="stylesheet" href="/data-center-native.css"><style>html,body{margin:0}#mount{width:1100px;height:900px}.dc-window{position:relative;width:100%;height:100%}</style></head><body><div id="mount"></div><script src="/data-center-native.js"></script></body></html>'});
   return r.fulfill({path:path.join(dist,u.pathname.slice(1))});
  });
  await page.goto('https://mw-list.invalid/');
  await page.evaluate(()=>{
   const composite=i=>({id:'row'+i,logical_symbol:'EURUSD',display_symbol:(i===0?'EUR/USD · Research 0 · '+ '长来源名称'.repeat(10):'EUR/USD · Research '+i),
    historical_source:'dukascopy',calendar:'ny17',status:'receiving',usage:{total:2},
    revision:{seam:1700000000000},preparation:{confirmed_end:1700003600000},
    mapping:{target_identity:{provider_symbol:'EUR_USD'}},health:{strategy_readiness:'ready'}});
   const candidate=i=>({dataset:{id:'candidate'+i,logical_symbol:'EURUSD',display_symbol:(i===0?'EUR/USD · Research 0 · '+ '长来源名称'.repeat(10):'EUR/USD · Research '+i),
    identity:{source:'dukascopy',provider_symbol:'EURUSD'},aggregation_calendar:'ny17',
    available_start:1600000000000,available_end:1700000000000},status:'ready_to_open',recommended_mapping_id:'mapping'});
   window.mount=MWNativeCenter.mount(document.querySelector('#mount'),{ui:null,
    context:{workspace:'isolated-list-fixture',target:'0',theme:'dark',symbolSync:true,intervalSync:true,
      location:'/market-data?tab=composite'},post(){},subscribe(){return()=>{}},
    async request(path){const u=new URL(path,location.origin),p=Number(u.searchParams.get('page')||1),size=Number(u.searchParams.get('page_size')||25);
     if(!u.pathname.includes('/center/composite'))throw Error('unexpected read '+u.pathname);
     return {items:Array.from({length:50},(_,i)=>u.pathname.includes('candidates')?candidate(i):composite(i)).slice((p-1)*size,p*size),total:50,page:p,page_size:size};
    }});
  });
  const content=page.locator('.dc-window-content'),rows=page.locator('.dc-market-row'),panel=page.locator('.dc-detail-panel');
  await expect(rows.first()).toBeVisible();
  const results=[];
  for(const mode of ['已建立组合','可建立候选']){
   await page.getByRole('button',{name:mode,exact:true}).click();await expect(rows.first()).toBeVisible();
   await page.getByRole('searchbox',{name:'搜索品种'}).fill('EUR');
   await expect(rows.first()).toBeVisible();
   for(const remaining of [701,700,560]){
    await page.evaluate(w=>{document.querySelector('#mount').style.width=w+'px'},remaining+360+240);
    const trigger=rows.first().getByRole('button',{name:'查看详情',exact:true});
    await trigger.click();await expect(content).toHaveAttribute('data-detail-mode','side');
    await expect(panel).toBeFocused();
    await page.evaluate(remaining=>{
      const mount=document.querySelector('#mount'),list=document.querySelector('.dc-market-list');
      mount.style.width=(mount.getBoundingClientRect().width+remaining-list.getBoundingClientRect().width)+'px';
    },remaining);
    await expect.poll(()=>page.locator('.dc-market-list').evaluate(n=>n.getBoundingClientRect().width)).toBe(remaining);
    const geometry=await rows.first().evaluate(n=>({main:n.querySelector('.dc-market-main').getBoundingClientRect().width,
      height:n.getBoundingClientRect().height,columns:getComputedStyle(n).gridTemplateColumns.split(' ').length,
      list:n.parentElement.getBoundingClientRect().width,overflow:n.scrollWidth>n.clientWidth+1}));
    assert.ok(geometry.main>=250,JSON.stringify(geometry));assert.ok(geometry.height<400);assert.equal(geometry.overflow,false);
    assert.equal(geometry.columns,remaining<=700?2:4);
    await rows.nth(1).getByRole('button',{name:'查看详情',exact:true}).click();
    await expect(panel).toContainText('Research 1');await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);await expect(rows.nth(1).getByRole('button',{name:'查看详情',exact:true})).toBeFocused();
    await expect(page.getByRole('searchbox',{name:'搜索品种'})).toHaveValue('EUR');
    results.push({mode,remaining,...geometry});
   }
   await page.evaluate(()=>document.querySelector('#mount').style.width='1099px');
   await rows.first().getByRole('button',{name:'查看详情',exact:true}).click();
   await expect(content).toHaveAttribute('data-detail-mode','full');
   await expect(panel.getByRole('button',{name:'关闭详情'})).toBeVisible();
   await page.keyboard.press('Escape');await expect(panel).toHaveCount(0);
  }
  const list=page.locator('.dc-market-list');
  await list.evaluate(n=>{n.scrollTop=800;});
  const scrollTrigger=rows.nth(8).getByRole('button',{name:'查看详情',exact:true});
  await scrollTrigger.scrollIntoViewIfNeeded();const scroll=await list.evaluate(n=>n.scrollTop);
  await scrollTrigger.click();
  await page.keyboard.press('Escape');await expect(panel).toHaveCount(0);
  assert.ok(Math.abs((await list.evaluate(n=>n.scrollTop))-scroll)<150,'detail close retains list scroll');
  assert.deepEqual(errors,[]);
  console.log('PASS built composite/candidate lists: actual remaining widths, both thresholds, row switching, focus, filter and full detail',JSON.stringify(results));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
