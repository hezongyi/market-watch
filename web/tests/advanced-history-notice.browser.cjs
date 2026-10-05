// Exercise the host notification contract through its trusted chart iframe.
const { chromium } = require("@playwright/test");
const fs = require("node:fs"), assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    headless:true,args:["--no-sandbox"]});
  try {
    const context = await browser.newContext({ignoreHTTPSErrors:true});
    const app = process.env.NATIVE_SYNC_APP || "https://192.168.7.232:16343";
    const login=await context.request.post(app + "/api/login", {
      data:JSON.parse(fs.readFileSync(process.env.NATIVE_SYNC_LOGIN,"utf8"))});
    assert.ok(login.ok());
    const csrf=(await login.json()).csrf;
    const created=await context.request.post(app + "/api/advanced-charts/workspaces", {
      headers:{"X-CSRF-Token":csrf},data:{name:"History notice timing acceptance"}});
    assert.ok(created.ok());
    const workspace=await created.json();
    const page = await context.newPage();
    await page.route("**/api/advanced-charts/workspaces?limit=1",async route => {
      const rows=await (await context.request.get(app+"/api/advanced-charts/workspaces")).json();
      await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(rows.filter(r=>r.id===workspace.id))});
    });
    await page.goto(app + "/advanced-charts");
    await page.waitForTimeout(1500);
    let frame;
    for(let n=0;n<100;n++) {
      frame=page.frames().find(f=>f.url().startsWith("https://192.168.7.232:16344/"));
      if(frame)break;
      await page.waitForTimeout(100);
    }
    assert.ok(frame);
    await frame.waitForFunction(() => typeof workspaceEpoch === "number" && typeof widget !== "undefined" && widget.chartsCount());
    await frame.waitForFunction(() => !MWNativeNavigation.busy() &&
      ![...providerHistoryWork.values()].some(w=>w.inflight),null,{timeout:60000});
    await page.waitForTimeout(1000);
    await page.locator(".advanced-loading-notice").waitFor({state:"hidden",timeout:30000});
    const send = message => frame.evaluate(m => parent.postMessage({channel:"mw-chart-v1",...m,epoch:workspaceEpoch},"*"),message);
    const base={type:"native-load-start",id:"notice-timing",instrument:"EURUSD",timeframe:"M5",
      count:12000,estimatedPages:3,from:1752451200000,to:1752537600000};
    await send(base);
    await page.waitForTimeout(4400);
    assert.equal(await page.locator(".advanced-loading-notice").count(),0,"ordinary notice stays hidden before five seconds");
    await page.locator(".advanced-loading-notice").waitFor({timeout:2000});
    const text=await page.locator(".advanced-loading-notice").textContent();
    assert.ok(text.includes("预计缓存总共约 3 页"));
    await send({type:"native-load-end",id:base.id});
    await page.locator(".advanced-loading-notice").waitFor({state:"hidden",timeout:2000});
    await send({...base,id:"capacity-timing"});
    await send({type:"capacity-notice",key:"MWP:EURUSD|5|",id:101,symbol:"MWP:EURUSD",resolution:"5",
      phase:"filling",message:"已超过容量，正在加载可到达的最早位置"});
    await page.locator(".history-capacity-result").waitFor({timeout:1500});
    assert.ok((await page.locator(".advanced-loading-notice").textContent()).includes("请求 12,000 根"),
      "capacity-associated loading detail bypasses the five-second gate");
    await send({type:"native-load-end",id:"capacity-timing"});
    const started=Date.now()-12000;
    await send({type:"capacity-notice",key:"MWP:EURUSD|5|",id:101,symbol:"MWP:EURUSD",resolution:"5",
      phase:"filling",message:"正在补齐边界",started,totalBars:60000,loadedBars:20000,
      estimatedPages:15,pages:5,batch:2,completedBatch:1});
    const result=page.locator(".history-capacity-result");
    await result.filter({hasText:"预计补齐 60,000 根"}).waitFor();
    const elapsedBefore=await result.textContent();
    await page.waitForTimeout(1600);
    const elapsedAfter=await result.textContent();
    assert.notEqual(elapsedBefore,elapsedAfter,"boundary clock keeps ticking with no live getBars batch");
    await send({...base,id:"second-batch",boundaryId:101,batch:2,count:20000,estimatedPages:5});
    assert.ok((await result.textContent()).includes("预计总共约 15 页"));
    assert.ok((await result.textContent()).includes("累计新增缓存 5 页"));
    await send({type:"native-load-end",id:"second-batch"});
    await send({type:"capacity-notice",key:"MWP:EURUSD|5|",id:101,phase:"clear"});
    await page.locator(".advanced-loading-notice").waitFor({state:"hidden",timeout:2000});
    const report={passed:true,scope:"trusted iframe notice messages; actual UI visibility, not provider performance",
      hiddenBeforeFiveSeconds:true,estimateText:text,capacityImmediate:true,
      boundaryElapsedBefore:elapsedBefore,boundaryElapsedAfter:elapsedAfter,
      operationTotalsSeparateFromBatches:true,cleanup:true};
    if(process.env.NATIVE_SYNC_OUTPUT)fs.writeFileSync(process.env.NATIVE_SYNC_OUTPUT,JSON.stringify(report,null,2));
    console.log("History notice: five-second delay, estimated pages, immediate capacity detail and cleanup passed");
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
