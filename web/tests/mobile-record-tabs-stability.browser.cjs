// Record-tab geometry with slow API doubles and real built UI; no device claim.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const dist=path.resolve('dist'),out=process.env.MOBILE_RECORD_TABS_OUTPUT||'/tmp/mw-record-tabs-stability';
fs.mkdirSync(out,{recursive:true});
let failHistory=false;
const streams=new Set(),errors=[];
const record={id:'fixture-record',title:'行情数据连接恢复 · 长标题布局检查',message:'供应商已恢复连接，历史告警记录仍可查阅。',instrument:'EURUSD',severity:'info',occurred_at:Date.now(),handled_at:null};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');let raw='';for await(const c of req)raw+=c;
 const json=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
 if(url.pathname==='/api/session')return json({csrf:'test',subject:'admin'});
 if(url.pathname==='/api/health')return json({version:'fixture-1'});
 if(url.pathname==='/api/advanced-charts/preferences')return json([]);
 if(url.pathname==='/api/notification-center/events'){ if(url.searchParams.has('audience')) await new Promise(r=>setTimeout(r,300));return failHistory?json({detail:'记录读取失败'},503):json({events:url.searchParams.get('audience')==='alerts'?[record]:[],before:null}); }
 if(url.pathname==='/api/chart-alerts/events/page')return json({items:[],next_cursor:null});
 if(url.pathname.endsWith('/timeline'))return json({observations:[]});
 if(url.pathname==='/api/notification-center/snapshot')return json({events:[],cursor:'test'});
 if(url.pathname==='/api/market-data/series/page')return json({items:[],next_offset:null});
 if(url.pathname==='/api/charts/stream/events'){
  streams.add(res);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: heartbeat\ndata: {}\n\n');req.on('close',()=>streams.delete(res));return;
 }
 if(url.pathname.startsWith('/api/charts/stream/'))return json({ok:true});
 if(url.pathname.startsWith('/api/'))return json({detail:'Unexpected fixture API '+url.pathname},404);
 let file=path.join(dist,decodeURIComponent(url.pathname));
 if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
 if(!fs.existsSync(file)&&url.pathname.startsWith('/m'))file=path.join(dist,'m/index.html');
 if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
 res.writeHead(200,{'Content-Type':{'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream'});res.end(fs.readFileSync(file));
});

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch();
 const context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,serviceWorkers:'block'});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));const proof=[];
 try {
  await page.goto('http://127.0.0.1:'+server.address().port+'/m/more');
  for(const width of [375,412])for(const theme of ['light','dark'])for(const font of [14,21]) {
   await page.setViewportSize({width,height:812});
   if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();
   await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);
   await page.getByRole('button',{name:/告警记录/}).click();
   const dialog=page.getByRole('dialog',{name:'事件记录',exact:true});
   await expect(dialog).toBeVisible();await page.waitForTimeout(500);
   for (const name of ['异常 / 恢复','系统','触发','异常 / 恢复']) {
    await page.evaluate(()=>{
     window.tabFrames=[];window.trackTabs=true;
     const frame=()=>{
      const el=document.querySelector('.mobile-record-tabs [role=tablist]');const r=el.getBoundingClientRect();
      window.tabFrames.push({time:performance.now(),y:r.y,x:r.x,height:r.height,width:r.width,selected:[...el.querySelectorAll('[role=tab]')].filter(n=>n.getAttribute('aria-selected')==='true').map(n=>n.textContent).join(','),opacity:getComputedStyle(el).opacity});
      if(window.trackTabs)requestAnimationFrame(frame);
     };frame();
    });
    const tab=dialog.getByRole('tab',{name,exact:true});
    await tab.click();
    for(let i=0;i<3;i++) {
     await page.waitForTimeout(220);
     await page.screenshot({path:path.join(out,`${width}-${theme}-${font}-${proof.length}-${i}.png`)});
    }
    const frames=await page.evaluate(()=>{window.trackTabs=false;return window.tabFrames});
    await expect(tab).toHaveAttribute('aria-selected','true');
    assert.equal(await tab.getAttribute('aria-controls'),await dialog.getByRole('tabpanel').getAttribute('id'));
    proof.push({width,theme,font,name,span:Math.max(...frames.map(f=>f.y))-Math.min(...frames.map(f=>f.y)),frames});
    assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'no horizontal drawer overflow');
   }
   // A nested detail remains short and returns to the same stable record browser.
   const y=await dialog.getByRole('tablist').evaluate(el=>el.getBoundingClientRect().y);
   await dialog.getByRole('button',{name:/行情数据连接恢复/}).click();
   const detail=page.getByRole('dialog',{name:record.title,exact:true});
   await expect(detail).toBeVisible();
   await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));
   await expect(detail).toHaveCount(0);await page.waitForTimeout(350);
   assert.equal(await dialog.getByRole('tablist').evaluate(el=>el.getBoundingClientRect().y),y);
   // Failure/retry must remain usable without collapsing the browser.
   failHistory=true;
   await dialog.getByRole('tab',{name:'系统',exact:true}).click();
   await expect(dialog.getByRole('alert')).toContainText('记录读取失败');
   assert.equal(await dialog.getByRole('tablist').evaluate(el=>el.getBoundingClientRect().y),y);
   failHistory=false;
   await dialog.getByRole('button',{name:'重试读取',exact:true}).click();
   await expect(dialog.getByText('本页暂无记录。',{exact:true})).toBeVisible();
   assert.equal(await dialog.getByRole('tablist').evaluate(el=>el.getBoundingClientRect().y),y);
   await dialog.getByRole('button',{name:'关闭',exact:true}).click();
   await expect(dialog).toHaveCount(0);
  }
  fs.writeFileSync(path.join(out,'frames.json'),JSON.stringify(proof,null,2));
  console.log(JSON.stringify(proof.map(({width,theme,font,name,span})=>({width,theme,font,name,span}))));
  assert(proof.every(p=>p.span<=1),'record type buttons must not jump as content changes or loads');assert.deepEqual(errors,[]);
 }finally{await browser.close();for(const res of streams)res.destroy();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
