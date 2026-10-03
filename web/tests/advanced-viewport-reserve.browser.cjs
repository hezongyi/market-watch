// Full product + isolated PostgreSQL + actual provider bars. No candle fixtures.
const {chromium} = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const APP = 'https://localhost:15743', CHART = 'https://localhost:15744';
const OUT = process.env.VIEWPORT_RESERVE_OUTPUT || '/tmp/mw-viewport-acceptance/browser.json';
const report = {at:new Date().toISOString(), scope:'isolated full stack, actual provider OHLC; additive per-render diagnostic hook', cases:[]};
const save = () => fs.writeFileSync(OUT, JSON.stringify(report,null,2));
(async () => {
  const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    headless:true,args:['--no-sandbox']});
  try {
    for (const count of (process.env.COUNTS || '1,2,4,8').split(',').map(Number)) {
      const synced=process.env.SYNC==='true', pointer=count===1||synced;
      const item = {count,synced,pointer,errors:[],http:[]}; report.cases.push(item); save();
      const context = await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:1000}});
      const readyDeadline=Date.now()+45000;
      while(Date.now()<readyDeadline) {
        const health=await context.request.get(APP+'/readyz').catch(()=>null);
        if(health?.ok())break;
        await new Promise(ok=>setTimeout(ok,250));
      }
      const login = await context.request.post(APP+'/api/login', {data:JSON.parse(fs.readFileSync('/tmp/mw-viewport-acceptance/login.json'))});
      assert.ok(login.ok(),'isolated login HTTP '+login.status()); const csrf = (await login.json()).csrf;
      const api = async (endpoint, data) => {
        const r = await context.request.post(APP+'/api/'+endpoint,{headers:{'X-CSRF-Token':csrf},data});
        assert.ok(r.ok(),endpoint+' '+r.status()); return r.json();
      };
      const workspace = await api('advanced-charts/workspaces',{name:'Viewport reserve acceptance '+count});
      await api(`advanced-charts/workspaces/${workspace.id}/save`,{name:workspace.name,revision:workspace.revision,
        document:{engine:'tv31',schemaVersion:1,symbol:'MWP:EURUSD',series_kind:'provider',interval:'5'}});
      const page = await context.newPage(), jobs=[];
      page.on('pageerror',e=>item.errors.push(e.message));
      page.on('response',r=>{if(!/\/api\/charts\/(data|reserve)$/.test(r.url()))return;
        jobs.push((async()=>{const b=await r.json();item.http.push({at:Date.now(),status:r.status(),query:r.request().postDataJSON(),
          count:b.bars?.length,mandatory:b.mandatory_count,optional:b.optional_count,hit:b.cache_hit,
          reserve_status:b.reserve_status,attempts:b.candles_http_attempts,bytes:(await r.body()).length});})());});
      await page.route('**/bundles/library.*.js',async route=>{
        const response=await route.fetch();let source=await response.text();
        const before='s&&this._drawSources(e,t)}if(null!==this._state)';
        assert.equal(source.split(before).length,2);
        const hook=`s&&(this._drawSources(e,t),(()=>{if(!globalThis.__recordReserve)return;const m=this.state().model();if(!this.containsMainSeries())return;const ts=m.timeScale(),r=ts.visibleBarsStrictRange(),bars=m.mainSeries().bars(),w=Math.ceil(e.canvas.width/6),h=e.canvas.height;let pixels=0;const p=e.getImageData(0,30,w,h-60).data;for(let i=0;i<p.length;i+=16){const R=p[i],G=p[i+1],B=p[i+2];if((R>130&&R>G*1.45&&R>B*1.3)||(G>85&&G>R*1.5&&G>B*1.15))pixels++;}(globalThis.__reserveFrames??=[]).push({at:performance.now(),symbol:m.mainSeries().symbol(),resolution:m.interval(),first:r?.firstBar(),firstAvailable:bars.firstIndex(),bars:bars.size(),pixels,spacing:ts.barSpacing()});})())}if(null!==this._state)`;
        await route.fulfill({response,body:source.replace(before,hook)});
      });
      async function settle(frame) {
        await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&
          Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:45000});
        await page.waitForTimeout(500);
      }
      const snapshot = frame=>frame.evaluate(()=>({active:widget.activeChartIndex(),
        reserve:MWNativeReserve.diagnostics(),charts:Array.from({length:widget.chartsCount()},(_,i)=>{
          const c=widget.chart(i);return {symbol:c.symbol(),resolution:c.resolution(),spacing:c.getTimeScale().barSpacing(),
            offset:c.getTimeScale().rightOffset(),width:c.getTimeScale().width(),range:c.getVisibleRange(),studies:c.getAllStudies(),shapes:c.getAllShapes()};}),undo:widget.undoRedoState()}));
      try {
        await page.goto(APP+'/advanced-charts');
        await page.waitForFunction(()=>[...document.querySelectorAll('iframe')].some(f=>f.src.startsWith('https://localhost:15744/')));
        let frame;
        const frameDeadline=Date.now()+30000;
        while(!frame&&Date.now()<frameDeadline) {frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
          if(!frame)await page.waitForTimeout(100);}
        assert.ok(frame,'chart origin frame must finish navigation');await settle(frame);
        if(count>1) {await frame.evaluate(count=>{widget.timeSync().setValue(false);widget.dateRangeSync().setValue(false);widget.setLayout(count===2?'2h':String(count));},count);await settle(frame);}
        await frame.evaluate(async ({count,synced})=>{
          for(let i=0;i<count;i++) {
            const c=widget.chart(i);if(i%2&&!synced)await c.setResolution('1D',{doNotActivateChart:true});
            await c.createStudy('Moving Average',false,false,{length:200});
            await c.createShape({time:c.getVisibleRange().to,price:1.1},{shape:'horizontal_line',disableSelection:true});
          }
          if(synced) {widget.timeSync().setValue(true);widget.dateRangeSync().setValue(true);}
        },{count,synced});await settle(frame);await page.waitForTimeout(2000);
        item.initial=await snapshot(frame);
        assert.ok(item.initial.reserve.models.every(m=>m.geometry.reserve>=2*m.geometry.screen-1),
          'all visible panes must have their reserve in the native sequence before drag');
        const native=frame.childFrames().find(f=>f.url().includes('charting_library')) || frame.childFrames()[0];assert.ok(native);
        await native.evaluate(()=>{globalThis.__reserveFrames=[];globalThis.__recordReserve=true;});
        const target=pointer?0:count-1;
        let dragBox;
        if(pointer) {
          for(const canvas of await native.locator('canvas').all()) {
            const box=await canvas.boundingBox();
            if(box&&box.width>300&&box.height>120&&(!dragBox||box.width*box.height>dragBox.width*dragBox.height))dragBox=box;
          }
          assert.ok(dragBox,'main pane canvas for real pointer gestures');
        }
        // Nonfocused public time-scale moves preserve focus, exercising each
        // chart's native viewport event rather than pointer focus dispatch.
        for(let turn=0;turn<12;turn++) {
          const reverse=turn===4||turn===9;
          if(pointer) {await page.mouse.move(dragBox.x+dragBox.width*(reverse?.8:.12),dragBox.y+dragBox.height*.45);await page.mouse.down();}
          for(let step=0;step<12;step++) {
            if(pointer) {
              const q=(step+1)/12,curve=q*q*(3-2*q);
              await page.mouse.move(dragBox.x+dragBox.width*((reverse?.8:.12)+(reverse?-1:1)*.55*curve),dragBox.y+dragBox.height*.45);
            } else await frame.evaluate(({target,reverse})=>{const c=widget.chart(target),ts=c.getTimeScale();
                ts.setRightOffset(ts.rightOffset()+(reverse?1:-1)*ts.width()/ts.barSpacing()*.55/12);},{target,reverse});
            await page.waitForTimeout(20);
          }
          if(pointer)await page.mouse.up();
          await page.waitForTimeout(150);
        }
        await page.waitForTimeout(1500);item.final=await snapshot(frame);
        item.frames=await native.evaluate(()=>{globalThis.__recordReserve=false;return globalThis.__reserveFrames;});
        await Promise.all(jobs);
        item.missing=item.frames.filter(f=>f.first<f.firstAvailable);
        item.blank=item.frames.filter(f=>f.pixels===0);
        assert.ok(item.frames.length>50,'native render samples');
        assert.equal(item.missing.length,0,'history must exist before each rendered viewport');
        assert.equal(item.blank.length,0,'left candle sample blank');
        assert.equal(item.final.active,item.initial.active,'nonfocused pan must not activate chart');
        for(let i=0;i<count;i++) {
          const a=item.initial.charts[i],b=item.final.charts[i];
          for(const k of ['symbol','resolution','studies','shapes'])assert.deepEqual(b[k],a[k]);
          if(!synced||i===target)assert.equal(b.spacing,a.spacing);
          // Original v31.1.0 also rounds peer spacing when fitting a linked
          // date range (6 -> 5.9333 in the four-pane baseline). Verify dates.
          if(synced)for(const edge of ['from','to'])assert.ok(
            Math.abs(b.range[edge]-item.final.charts[target].range[edge])<=300,
            'linked pane time range diverged');
          if(i!==target&&!synced)assert.equal(b.offset,a.offset,'independent pane changed');
          if(synced)assert.notEqual(b.offset,a.offset,'linked pane did not move');
        }
        assert.deepEqual(item.errors,[]);
        assert.deepEqual(item.final.undo,item.initial.undo,'buffering must not alter undo commands');
        assert.ok(item.http.some(r=>r.query.native_reserve),'must exercise PG reserve endpoint');
        assert.ok(item.http.filter(r=>r.query.native_reserve).every(r=>r.status===200&&r.mandatory===0&&r.attempts.length===0));
        assert.ok(item.http.filter(r=>r.query.native_reserve&&r.query.timeframe==='D1')
          .every(r=>r.query.before%86400000===0),'D1 reserve cursor must use provider trading-day labels');
        await page.screenshot({path:OUT.replace('.json',`-${count}.png`)});item.passed=true;
      } catch(e) {item.error=String(e);}
      finally {await Promise.allSettled(jobs);save();await page.close();await context.close();}
    }
  } finally {save();await browser.close();}
  assert.ok(report.cases.every(c=>c.passed),'full-stack reserve acceptance failed');
})().catch(e=>{report.error=String(e);save();console.error(e.message);process.exitCode=1;});
