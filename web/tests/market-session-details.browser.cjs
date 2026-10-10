// Actual native chart acceptance with backend-injected synthetic provider history.
const {chromium} = require("@playwright/test");
const fs = require("node:fs"), path = require("node:path");
const assert = require("node:assert/strict");
const APP = process.env.SESSION_APP || "https://localhost:17443";
const ROOT = process.env.SESSION_PRIVATE || "/tmp/mw-session-details-fix-20261011";
const OUT = process.env.SESSION_OUTPUT || "docs/verification/market-session-details-fix-20261011";
const report = {scope:"Ubuntu Docker, synthetic provider history, actual pinned native UI", cases:[], errors:[], phase:"initial"};
const record=report.cases.push.bind(report.cases);report.cases.push=item=>{console.log("PASS",item.case,item.name||item.width||item.zone||"");return record(item);};
(async () => {
  const extension = path.join(ROOT,"zoom-extension");
  fs.mkdirSync(extension,{recursive:true});
  fs.writeFileSync(path.join(extension,"manifest.json"),JSON.stringify({manifest_version:3,name:"Session acceptance zoom",version:"1.0",permissions:["tabs"],background:{service_worker:"worker.js"}}));
  fs.writeFileSync(path.join(extension,"worker.js"),'chrome.runtime.onInstalled.addListener(()=>{});');
  const context = await chromium.launchPersistentContext('',{headless:true,ignoreHTTPSErrors:true,viewport:null,
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:["--no-sandbox","--window-size=1440,1000","--disable-extensions-except="+extension,"--load-extension="+extension]});
  const worker=context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  try {
    const login = await context.request.post(APP+"/api/login", {data:JSON.parse(fs.readFileSync(ROOT+"/login.json"))});
    assert.ok(login.ok(), "isolated login");
    const {csrf} = await login.json();
    async function post(path,data) {
      const response = await context.request.post(APP+"/api/"+path,{data,headers:{"X-CSRF-Token":csrf}});
      assert.ok(response.ok(), path+" "+response.status()+" "+await response.text());return response.json();
    }
    const catalog = await (await context.request.get(APP+"/api/market-data/center/platform?source=dukascopy&query=XAU&page_size=25")).json();
    const entry = catalog.items.find(row=>row.symbol === "XAU/USD");
    assert.ok(entry,"Dukascopy gold must be mapped");
    const ticker = entry.ticker || "MWP:"+entry.id;
    const calendars = await (await context.request.get(APP+"/api/market-data/center/calendars")).json();
    fs.writeFileSync(OUT+"/calendar-inventory.json",JSON.stringify(calendars,null,2));
    const workspace = await post("advanced-charts/workspaces",{name:"Session details synthetic acceptance"});
    await post("advanced-charts/workspaces/"+workspace.id+"/save",{name:workspace.name,revision:workspace.revision,
      document:{engine:"tv31",schemaVersion:1,symbol:ticker,series_kind:"provider",interval:"1"}});
    await context.route("**/api/advanced-charts/workspaces?limit=1",async route=>{
      const response=await context.request.get(APP+"/api/advanced-charts/workspaces");
      await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify((await response.json()).filter(row=>row.id===workspace.id))});
    });
    const page = await context.newPage();
    page.on("crash",()=>report.errors.push("browser page crashed"));
    const zoom = value=>worker.evaluate(async({base,value})=>{
      const tab=(await chrome.tabs.query({})).find(tab=>tab.url?.startsWith(base));
      await chrome.tabs.setZoom(tab.id,value);return chrome.tabs.getZoom(tab.id);
    },{base:APP,value});
    page.on("pageerror",error=>report.errors.push({message:error.message,stack:error.stack,after:report.cases.at(-1)?.case,phase:report.phase,page:"main"}));
    await page.goto(APP+"/advanced-charts");
    await page.locator('iframe[title="专业图表工作区"]').waitFor({timeout:60000});
    const frame = await (async()=>{for(let i=0;i<120;i++) {const f=page.frames().find(f=>f.url().startsWith("https://127.0.0.1:17444/"));if(f)return f;await page.waitForTimeout(500);}throw Error("missing chart origin");})();
    await frame.waitForFunction(()=>typeof ready!=="undefined" && ready && !loading && widget.activeChart().dataReady(),null,{timeout:120000});
    const ui = frame.childFrames()[0]; assert.ok(ui,"native frame");
    await frame.evaluate(async()=> {const bar=await widget.widgetbar();bar.changeWidgetBarVisibility(true);bar.showPage("watchlist_details_news");});
    const quote = (await post("market-data/quotes",{symbols:[ticker]}))[0];
    assert.equal(quote.v.market_session,"closed"); assert.equal(quote.v.session_reason,"周末");
    assert.equal(quote.v.quote_time,null); assert.equal(quote.v.time_type,"source_m1");
    await ui.getByText(/最后行情时间/).first().waitFor({timeout:30000});
    await page.screenshot({path:OUT+"/details-initial.png"});
    let text = await ui.locator("body").innerText();
    assert.ok(text.includes("休市") && text.includes("周末") && text.includes("最后行情时间"),text);
    assert.ok(!text.includes("时段与行情不一致"),"normal Friday quote cannot conflict with Saturday closure");
    assert.ok(!text.includes("开市"),"unverified native open label must be absent");
    report.cases.push({case:"native details ready",quoteTime:quote.v.data_start,description:quote.v.description});
    for(const zone of ["Asia/Shanghai","America/New_York","exchange","Etc/UTC"]) {
      const expected=({"Asia/Shanghai":"2026-10-10 04:59:00 UTC+8","America/New_York":"2026-10-09 16:59:00 America/New_York (UTC-4)",exchange:"2026-10-09 20:59:00 UTC","Etc/UTC":"2026-10-09 20:59:00 UTC"})[zone];
      await frame.evaluate(zone=>widget.activeChart().getTimezoneApi().setTimezone(zone),zone);
      const description=ui.getByText(new RegExp("最后行情时间 "+expected.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"))).first();
      await description.waitFor({timeout:15000});
      const box=await description.boundingBox();
      assert.ok(box && box.height>0 && box.y>=0 && box.y+box.height<=await page.evaluate(()=>innerHeight),"description directly in viewport");
      report.cases.push({case:"native quote timezone",zone,expected,visible:true});
    }
    await frame.evaluate(()=>widget.activeChart().getTimezoneApi().setTimezone("Asia/Shanghai"));
    await ui.getByText(/最后行情时间.*UTC\+8/).first().waitFor({timeout:15000});
    await frame.evaluate(()=>widget.setLayout("2h"));
    await frame.waitForFunction(()=>widget.chartsCount()===2,null,{timeout:30000});
    await frame.evaluate(async()=>{for(let i=0;i<widget.chartsCount();i++) await new Promise(resolve=>widget.chart(i).setSymbol(widget.chart(0).symbol(),resolve));
      widget.chart(0).getTimezoneApi().setTimezone("Etc/UTC");widget.chart(1).getTimezoneApi().setTimezone("Asia/Shanghai");widget.setActiveChart(1);});
    await frame.waitForFunction(()=>widget.chart(0).dataReady() && widget.chart(1).dataReady(),null,{timeout:90000});
    await ui.getByText(/最后行情时间.*UTC\+8/).first().waitFor({timeout:15000});
    await frame.evaluate(()=>widget.setActiveChart(0));
    await ui.getByText(/最后行情时间.* UTC(?: ·|$)/).first().waitFor({timeout:15000});
    report.cases.push({case:"active chart/timezone switch",passed:true});
    await frame.evaluate(()=>widget.setLayout("s"));
    await frame.waitForFunction(()=>widget.chartsCount()===1 && widget.activeChart().dataReady(),null,{timeout:30000});
    // Inject only raw quote snapshots at the existing presentation seam. This
    // proves native rendering of rare states; backend cases are tested separately.
    await frame.evaluate(()=>{globalThis.sessionAcceptanceCallbacks=[...quoteSubscriptions].map(([id,sub])=>({id,symbols:sub.symbols,cb:sub.cb}));
      for(const id of [...quoteSubscriptions.keys()]) feed.unsubscribeQuotes(id);});
    async function inject(overrides) {
      await frame.evaluate(({ticker,value})=>{const row={s:"ok",n:ticker,v:value};rememberQuoteRows([row]);
        for(const sub of sessionAcceptanceCallbacks) if(sub.symbols.includes(ticker)) sub.cb([presentQuote(row)]);
      },{ticker,value:{...quote.v,read_at:Date.now(),...overrides}});
    }
    for(const [name,values,phrase] of [
      ["unknown",{market_session:"unknown",session_reason:null},"时段未核实"],
      ["no time",{quote_time:null,data_start:null,data_end:null},"暂无行情更新时间"],
      ["read failure",{fetch_status:"fetch_failed"},"更新失败，保留上次数据"],
      ["reopened waiting",{market_session:"scheduled_open",session_reason:null},"等待新行情"],
      ["closure conflict",{session_conflict_reason:"时段与行情不一致，待核实"},"时段与行情不一致，待核实"],
      ["precise event",{quote_time:Date.parse("2026-10-09T20:59:58Z"),time_type:"provider_quote"},"最后更新于 2026-10-09 20:59:58 UTC"],
      ["fixed history",{time_type:"fixed_history",description_base:"固定历史"},"历史数据时间"],
    ]) {await inject(values);await ui.getByText(phrase,{exact:false}).first().waitFor({timeout:15000});
      report.cases.push({case:"native controlled quote state",name,phrase});}
    const replaced=await frame.evaluate(async ticker=>{
      const results=[];
      feed.subscribeQuotes(["MWP:BTCUSDT"],[],rows=>results.push({generation:"old",rows}),"acceptance-replace");
      feed.subscribeQuotes([ticker],[],rows=>results.push({generation:"new",rows}),"acceptance-replace");
      await new Promise(resolve=>setTimeout(resolve,16000));
      feed.unsubscribeQuotes("acceptance-replace");
      return results.map(item=>({generation:item.generation,symbols:item.rows.map(row=>row.n)}));
    },ticker);
    assert.ok(replaced.length && replaced.every(item=>item.generation==="new" && item.symbols.every(symbol=>symbol===ticker)));
    report.cases.push({case:"rapid quote subscription replacement",selected:ticker,results:replaced});
    await inject({});
    await frame.evaluate(()=>{for(const sub of sessionAcceptanceCallbacks) feed.subscribeQuotes(sub.symbols,[],sub.cb,sub.id);});
    for(const theme of ["Dark","Light"]) {
      await frame.evaluate(theme=>widget.changeTheme(theme),theme);
      for(const width of [375,768,1440]) {
        await page.setViewportSize({width,height:1000});
        await page.waitForTimeout(500);
        await frame.evaluate(async()=> {const bar=await widget.widgetbar();bar.changeWidgetBarVisibility(true);bar.showPage("watchlist_details_news");});
        await page.screenshot({path:OUT+`/details-${theme.toLowerCase()}-${width}.png`});
        const narrow=await frame.getByRole("complementary",{name:"商品状态和行情时间"}).isVisible();
        const description=narrow ? frame.getByRole("complementary",{name:"商品状态和行情时间"}) : ui.getByText(/休市.*周末.*最后行情时间/).first();await description.waitFor();
        await description.filter({hasText:/休市.*周末.*最后行情时间/}).waitFor({timeout:30000});
        assert.match(await description.innerText(),/休市.*周末.*最后行情时间/);
        const box=await description.boundingBox();assert.ok(box && box.y>=0 && box.y+box.height<=1000);
        assert.ok(await description.evaluate(node=>node.scrollWidth<=node.clientWidth+1 && node.scrollHeight<=node.clientHeight+1),"native details not clipped");
        await page.screenshot({path:OUT+`/details-${theme.toLowerCase()}-${width}.png`});
        report.cases.push({case:"details responsive",theme,width,visible:true,mode:narrow?"compact compatibility":"native details"});
      }
    }
    await frame.evaluate(()=>dataCenter.open("/market-data?tab=calendar"));
    await ui.getByRole("heading",{name:"交易日历",exact:true}).waitFor({timeout:30000});
    for(const theme of ["Dark","Light"]) {
      await frame.evaluate(theme=>widget.changeTheme(theme),theme);
      for(const width of [375,768,1440]) {
        await page.setViewportSize({width,height:1000});
        await page.waitForTimeout(500);
        await ui.getByLabel("品种搜索").fill("XAUUSD");
        await ui.locator(".dc-calendar-row summary").filter({hasText:"XAU/USD"}).first().waitFor({timeout:15000});
        const summary=ui.locator(".dc-calendar-row summary").filter({hasText:"XAU/USD"}).first();
        if(!await summary.evaluate(node=>node.parentElement.open)) await summary.click();
        assert.ok(await ui.getByRole("link").filter({hasText:"dukascopy.com"}).first().isVisible());
        const overflow=await ui.locator(".dc-window").evaluate(node=>node.scrollWidth-node.clientWidth);
        assert.equal(overflow,0,theme+" "+width+" overflow");
        await page.screenshot({path:OUT+`/calendar-${theme.toLowerCase()}-${width}.png`});
        report.cases.push({case:"calendar native responsive",theme,width,overflow});
      }
    }
    const summary=ui.locator(".dc-calendar-row summary").filter({hasText:"XAU/USD"}).first();
    await summary.focus();await page.keyboard.press("Space");
    assert.equal(await summary.evaluate(node=>node.parentElement.open),false);
    await page.keyboard.press("Enter");assert.equal(await summary.evaluate(node=>node.parentElement.open),true);
    report.cases.push({case:"calendar keyboard disclosure",passed:true});
    assert.equal(await zoom(2),2);await page.waitForTimeout(500);
    assert.ok(await page.evaluate(()=>devicePixelRatio>=2));
    assert.equal(await ui.locator(".dc-window").evaluate(node=>node.scrollWidth-node.clientWidth),0);
    await page.screenshot({path:OUT+"/calendar-zoom200.png"});
    report.cases.push({case:"actual Chrome browser zoom",factor:2,viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}))});
    await zoom(1);
    await ui.getByRole("button",{name:"关闭数据中心",exact:true}).click();
    await zoom(2);await page.waitForTimeout(500);
    await frame.evaluate(async()=> {const bar=await widget.widgetbar();bar.changeWidgetBarVisibility(true);bar.showPage("watchlist_details_news");});
    await page.waitForTimeout(1000);
    await page.screenshot({path:OUT+"/details-zoom200.png"});
    const zoomDetails=await frame.getByRole("complementary",{name:"商品状态和行情时间"}).isVisible() ? frame.getByRole("complementary",{name:"商品状态和行情时间"}) : ui.getByText(/休市.*周末.*最后行情时间/).first();
    const zoomBox=await zoomDetails.boundingBox();assert.ok(zoomBox && zoomBox.y>=0 && zoomBox.y+zoomBox.height<=await page.evaluate(()=>innerHeight));
    await page.screenshot({path:OUT+"/details-zoom200.png"});
    report.cases.push({case:"native details actual 200% zoom",visible:true});await zoom(1);
    for(const interval of ["1","60","240","1D","1W","1M"]) {
      report.phase="period "+interval;
      await frame.evaluate(async interval=>{
        const chart=widget.activeChart();
        if(chart.resolution()===interval)return;
        const loaded=new Promise(resolve=>chart.onDataLoaded().subscribe(null,resolve,true));
        await chart.setResolution(interval);
        await loaded;
        // Leave the native completed-event dispatch before the next mutation.
        await new Promise(resolve=>setTimeout(resolve,0));
      },interval);
      await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:90000});
      report.cases.push({case:"native period ready",interval});
    }
    // A separate native workspace view keeps the period range restoration
    // independent from the fast-selection quote identity assertion.
    report.phase="rapid page opening";
    const rapidPage=await context.newPage();
    rapidPage.on("pageerror",error=>report.errors.push({message:error.message,stack:error.stack,phase:report.phase,page:"rapid"}));
    await rapidPage.goto(APP+"/advanced-charts");
    await rapidPage.locator('iframe[title="专业图表工作区"]').waitFor({timeout:60000});
    let rapidFrame;
    for(let i=0;i<120&&!rapidFrame;i++){rapidFrame=rapidPage.frames().find(frame=>frame.url().startsWith("https://127.0.0.1:17444/"));if(!rapidFrame)await rapidPage.waitForTimeout(500);}
    assert.ok(rapidFrame);
    await rapidFrame.waitForFunction(()=>typeof ready!=="undefined" && ready && !loading && widget.activeChart().dataReady(),null,{timeout:120000});
    const fxCatalog=await (await context.request.get(APP+"/api/market-data/center/platform?source=dukascopy&query=EURUSD&page_size=100")).json();
    const fx=fxCatalog.items.find(row=>row.symbol==="EUR/USD");assert.ok(fx);
    const fxTicker=fx.ticker||"MWP:"+fx.id;
    report.phase="rapid symbol switching";
    await rapidFrame.evaluate(async ticker=>{
      widget.activeChart().setSymbol("MWP:BTCUSDT");
      await new Promise(resolve=>setTimeout(resolve,20));
      widget.activeChart().setSymbol(ticker);
      const bar=await widget.widgetbar();bar.changeWidgetBarVisibility(true);bar.showPage("watchlist_details_news");
    },fxTicker);
    const rapidUi=rapidFrame.childFrames()[0];
    await rapidUi.getByText(/EURUSD.*平台行情.*休市.*最后行情时间/).first().waitFor({timeout:30000});
    await rapidFrame.waitForFunction(ticker=>MWSeries.same(widget.activeChart().symbol(),ticker) && widget.activeChart().dataReady(),fxTicker,{timeout:90000});
    const selected=await rapidFrame.evaluate(()=>({symbol:widget.activeChart().symbol(),rows:[...quoteSnapshotRows].map(([ticker,row])=>({ticker,name:row.v.short_name}))}));
    assert.equal(selected.symbol.toLowerCase(),fxTicker.toLowerCase());
    assert.equal(selected.rows.find(row=>row.ticker.toLowerCase()===fxTicker.toLowerCase())?.name,"EURUSD");
    await rapidPage.screenshot({path:OUT+"/details-rapid-selection.png"});
    report.cases.push({case:"rapid native symbol selection quote identity",selected:fxTicker,passed:true});
    await rapidPage.close();
    await page.waitForTimeout(1000);
    assert.deepEqual(report.errors,[]);
    fs.writeFileSync(OUT+"/browser.json",JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  } finally {await context.close();}
})().catch(error=>{report.failure=error.stack;fs.writeFileSync(OUT+"/browser.json",JSON.stringify(report,null,2));console.error(error);process.exit(1);});
