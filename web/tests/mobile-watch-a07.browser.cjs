// A07 Watch alignment: built React UI with explicit API fixtures vs accepted prototype.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const { chromium, expect } = require("@playwright/test");
const dist = path.resolve("dist"),
  output = process.env.MOBILE_VISUAL_OUTPUT || "/tmp/mw-mobile-watch-a07";
fs.mkdirSync(output, { recursive: true });
const codes = ["XAUUSD", "EURUSD", "BTCUSDT-PERP", "USDJPY", "QQQ", "600519"];
const symbols = codes.map((code, i) =>
  i < 2 ? "MWC:" + String(i + 1).repeat(64) : "MWP:" + code,
);
const names = [
  "现货黄金",
  "欧元 / 美元",
  "比特币",
  "美元 / 日元",
  "纳指 100 ETF",
  "贵州茅台",
];
const sources = ["OANDA", "OANDA", "Binance", "FXCM", "Yahoo", "AKShare"];
const prices = [2684.52, 1.08420, 76428.30, 147.250, 512.84, 9876543.21];
let preferenceReads = 0, slowPreferences = 0, stockSessionPhase = "normal";
let holdPreferences = false,
  emptyWatch = false;
const rows = ["monitoring", "blocked", "paused"].map((state, i) => ({
  id: "rule-" + i,
  name: ["黄金突破提醒", "欧元下破提醒", "指数观察"][i],
  status: state === "paused" ? "paused" : "active",
  health: state === "blocked" ? "blocked" : "ready",
  count: 0,
  max_triggers: 1,
  version: 1,
  control_revision: 1,
  condition_summary: "向上穿越 2,700.00",
  display_identity: {
    code: ["XAUUSD", "EURUSD", "QQQ"][i],
    source: "oanda",
    series_kind: "composite",
  },
  execution: {
    state,
    label: ["监控中", "需要处理", "已暂停"][i],
    last_evaluated_at: Date.now(),
  },
  config: {
    instrument: "a".repeat(64),
    series_kind: "composite",
    source: "composite",
    timeframe: "H1",
    mode: "close",
    notify_ntfy: false,
    condition: {
      relation: "cross_up",
      left: { kind: "price" },
      right: { kind: "constant", value: "2700" },
    },
    expires_at: null,
  },
}));
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const json = (value) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === "/api/session")
    return json({ subject: "admin", csrf: "test" });
  if (url.pathname === "/api/health")
    return json({
      ntfy_configured: false,
      delivery_enabled: false,
      chart_alerts: { loop: { state: "idle" } },
    });
  if (url.pathname === "/api/advanced-charts/preferences") {
    preferenceReads++;
    if (holdPreferences) return;
    if (slowPreferences) await new Promise(resolve => setTimeout(resolve, slowPreferences));
    return json([
      {
        kind: "setting",
        name: "mw.watchlists.v1",
        revision: 1,
        content: {
          value: {
            active: "all",
            lists: [
              {
                id: "all",
                title: "重点关注",
                symbols: emptyWatch ? [] : symbols,
              },
            ],
          },
        },
      },
    ]);
  }
  if (url.pathname === "/api/market-data/quotes")
    return json(
      body.symbols.map((ticker) => {
        const i = symbols.indexOf(ticker);
        return {
          n: ticker,
          s: "ok",
          v: {
            short_name: codes[i],
            description_base:
              codes[i] +
              " · " +
              names[i] +
              " · " +
              (i < 2 ? "组合" : "平台") +
              " · " +
              sources[i],
            description: names[i],
            exchange: sources[i],
            lp: prices[i],
            display_precision: i === 1 ? 5 : i === 0 || i === 3 ? 3 : 2,
            delay_seconds: i === 4 ? 900 : undefined,
            prev_close_price: i === 5 ? undefined : 100,
            read_at: Date.now(),
            calendar_verified: i === 4 && stockSessionPhase === "waiting",
            market_session: i === 4 && stockSessionPhase === "waiting" ? "scheduled_open" : "unknown",
            chp: [0.69, -0.22, 1.63, 1.24, -0.45, 0.56][i],
            fetch_status: "ok",
            quote_time: Date.now(),
          },
        };
      }),
    );
  if (url.pathname === "/api/market-data/sparklines") {
    const left = Math.floor(Date.now() / 86400000) * 86400000;
    return json({
      as_of: Date.now(),
      items: body.items.map((item) => item.ticker === symbols[4] && stockSessionPhase !== "normal" ? {
        ticker: item.ticker,
        window_start: stockSessionPhase === "current" ? left : left-86400000,
        window_end: stockSessionPhase === "current" ? left+23400000 : left-63000000,
        valid_until: left+86400000,
        session: {date: new Date(stockSessionPhase === "current" ? left : left-86400000).toISOString().slice(0,10), previous: stockSessionPhase !== "current"},
        timeframe:"M1", status:"partial", reference_times:[],
        points: (stockSessionPhase === "current" ? [left,left+60000,left+120000] : [left-86400000,left-75000000,left-63060000]).map((time,i)=>({time,price:String(100+[0,0.4,0.2][i])})),
      } : ({
        ticker: item.ticker,
        window_start: left,
        window_end: left + 86400000,
        timeframe: "M1",
        reference_times: [left+28800000,left+46800000],
        points: [
          { time: left, price: "100" },
          { time: left + 3600000, price: "101" },
          { time: left + 7200000, price: "100.5" },
        ],
        status: "partial",
      })),
    });
  }
  if (url.pathname === "/api/market-data/sparklines/prepare") return json({as_of:Date.now(),items:[],preparation:"ready"});
  if (url.pathname === "/api/market-data/resolve")
    return json({ id: body.instrument, source: "oanda", frames: ["M1", "H1"] });
  if (url.pathname === "/api/market-data/series/page")
    return json({
      items: [{ticker:"MWP:SPY",symbol:"SPY",display_symbol:"SPY",instrument_name:"标普 500 ETF",series_kind:"provider",source:"yahoo",source_display:"Yahoo",frames:["M1","H1"]}, ...symbols.map((ticker, i) => ({
        ticker,
        symbol: codes[i],
        display_symbol: codes[i],
        description: names[i],
        source: sources[i].toLowerCase(),
        series_kind: i < 2 ? "composite" : "provider",
        frames: ["M1", "H1"],
      }))],
      next_offset: null,
    });
  if (url.pathname === "/api/chart-alerts") return json(rows);
  if (url.pathname === "/api/chart-alerts/events") return json([]);
  if (url.pathname === "/api/charts/stream/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("event: heartbeat\ndata: {}\n\n");
    return;
  }
  if (url.pathname.startsWith("/api/charts/stream/")) return json({ ok: true });
  if (url.pathname.startsWith("/api/notification-center/"))
    return json({
      events: [],
      changes: [],
      more: false,
      epoch: "test",
      after: null,
      unread: 0,
      alert_unread: 0,
      system_unread: 0,
    });
  if (url.pathname.startsWith("/api/")) return json({ items: [] });
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory())
    file = path.join(file, "index.html");
  if (!fs.existsSync(file) && url.pathname.startsWith("/m"))
    file = path.join(dist, "m/index.html");
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, {
    "Content-Type":
      {
        ".js": "application/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
      }[path.extname(file)] || "application/octet-stream",
  });
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 412, height: 852 },
    locale: "zh-CN",
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage(),
    reference = await context.newPage(),
    errors = [],
    measurements = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const url = "http://127.0.0.1:" + server.address().port + "/m/";
  const prototype = require("node:url").pathToFileURL(
    path.resolve(
      "../docs/prototypes/android-a07-refinement-20261111/preview.html",
    ),
  ).href;
  const metrics = async (p, selectors) =>
    p.evaluate(
      (s) =>
        Object.fromEntries(
          Object.entries(s).map(([name, selector]) => {
            const el = document.querySelector(selector),
              r = el.getBoundingClientRect(),
              cs = getComputedStyle(el);
            return [
              name,
              {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                fontSize: cs.fontSize,
                color: cs.color,
              },
            ];
          }),
        ),
      selectors,
    );
  try {
    await page.goto(url);
    await expect(page.locator(".mobile-watch-row")).toHaveCount(6);
    await expect(page.locator(".mobile-watch-row.stale")).toHaveCount(0);
    await expect(page.locator('.mobile-watch-origin')).toHaveText(['Binance', 'FXCM', 'Yahoo', 'AKShare']);
    await expect(page.locator('.mobile-watch-description')).toHaveText(['黄金','欧元美元','比特币','美元日元','纳指 100 ETF','贵州茅台']);
    for (const theme of ["dark", "light"])
      for (const [width, height, font] of [
        [412, 852, 14],
        [375, 772, 14],
        [375, 772, 21],
        [852, 372, 14],
      ]) {
        await page.setViewportSize({ width, height });
        await reference.setViewportSize({ width, height });
        await page.evaluate(
          ({ theme, font }) => {
            document.querySelector(".mobile-app").dataset.theme = theme;
            document.documentElement.style.fontSize = font + "px";
          },
          { theme, font },
        );
        await reference.goto(
          prototype +
            "?embed=1&page=watch&theme=" +
            theme +
            (font === 21 ? "&scale=150" : ""),
        );
        await reference.waitForSelector(".quote-row");
        const actual = await metrics(page, {
          header: ".mobile-watch-title",
          row: ".mobile-watch-row",
          code: ".mobile-watch-symbol strong",
          price: ".mobile-watch-price strong",
          nav: ".mobile-nav",
        });
        const expected = await metrics(reference, {
          header: ".app-header",
          row: ".quote-row",
          code: ".quote-info strong",
          price: ".quote-price strong",
          nav: ".bottom-nav",
        });
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "no horizontal overflow",
        );
        if (width < 800) {
          // User-approved device feedback deliberately reduces header/nav height.
          // Feedback reserves more width for the chart with a 16px page inset.
          assert.equal(actual.row.x, 16);
          if (font === 21) {
            const separated = await page.locator('.mobile-watch-row').first().evaluate(row =>
              row.querySelector('.mobile-watch-symbol').getBoundingClientRect().bottom <= row.querySelector('.mobile-spark').getBoundingClientRect().top);
            assert(separated,'large text keeps chart on a separate unobstructed row');
          }
          assert(Math.abs(parseFloat(actual.price.fontSize) - font * 15/14) < 0.01);
          await expect(page.locator('.mobile-watch-price strong').first()).toHaveText('+0.69%');
          await expect(page.locator('.mobile-watch-last-price').nth(1)).toHaveText('1.08420');
          await expect(page.locator('.mobile-spark-previous-close')).toHaveCount(5);
          assert(await page.locator('.mobile-spark-previous-close').first().evaluate(el => el.getAttribute('y1') === '24'));
          if (font === 14) {
            assert.equal(actual.row.height, 72);
            const secondarySizes = await page.locator('.mobile-watch-description, .mobile-watch-origin').evaluateAll(els=>els.map(el=>parseFloat(getComputedStyle(el).fontSize)));
            assert(secondarySizes.length && secondarySizes.every(size=>Math.abs(size-11)<0.01),'Chinese descriptions and source labels use 11px secondary text');
            assert.equal(actual.header.height, 64);
            const fixedColumns = await page.locator('.mobile-watch-row').evaluateAll(rows => rows.map(row => {
              const bounds = selector => row.querySelector(selector).getBoundingClientRect();
              const symbol=bounds('.mobile-watch-symbol'), chart=bounds('.mobile-spark'), price=bounds('.mobile-watch-price');
              const fitted = [...row.querySelectorAll('.mobile-fit-content')].every(el => el.getBoundingClientRect().width <= el.parentElement.getBoundingClientRect().width + 0.5);
              const contained = [...row.querySelectorAll('.mobile-watch-price .mobile-fit-content')].every(el => {
                const r=el.getBoundingClientRect(); return r.left>=price.left-0.5 && r.right<=price.right+0.5;
              });
              return {left:symbol.width,right:price.width,chart:chart.width,fitted,contained};
            }));
            assert(fixedColumns.every(row => Math.abs(row.left-79.8)<0.1 && Math.abs(row.right-67.2)<0.1 && row.fitted && row.contained), 'fixed columns fit long code and quote without stealing chart width: '+JSON.stringify(fixedColumns));
            assert(Math.max(...fixedColumns.map(row=>row.chart))-Math.min(...fixedColumns.map(row=>row.chart))<0.1);
            assert(fixedColumns.every(row => row.chart >= width-191.1), 'chart has more space at both phone widths');
            const priceStyle = await page.locator('.mobile-watch-last-price').first().evaluate(el => ({
              color:getComputedStyle(el).color,pips:getComputedStyle(el.querySelector('b')).color,
              weight:getComputedStyle(el).fontWeight,pipWeight:getComputedStyle(el.querySelector('b')).fontWeight
            }));
            assert.equal(priceStyle.color,priceStyle.pips,'enlarged digits remain gray');
            assert.equal(priceStyle.weight,priceStyle.pipWeight,'enlarged digits do not gain bold emphasis');
            const referenceStyle = await page.locator('.mobile-spark').first().evaluate(el => [...el.querySelectorAll('line')].map(line => {
              const s=getComputedStyle(line);return {stroke:s.stroke,opacity:s.opacity};
            }));
            assert(referenceStyle.length>=2);assert(referenceStyle.every(s=>s.stroke===referenceStyle[0].stroke&&s.opacity===referenceStyle[0].opacity),'horizontal and vertical references share color and opacity');
            await expect(page.locator('.mobile-watch-last-price').first()).toHaveText('2,684.520');
            await expect(page.locator('.mobile-watch-last-price').nth(3)).toHaveText('147.250');
            await expect(page.locator('.mobile-watch-last-price sup').first()).toHaveText('0');

            const alignment = await page.locator('.mobile-watch-row').first().evaluate(row => {
              const symbol = row.querySelector('.mobile-watch-symbol').getBoundingClientRect();
              const spark = row.querySelector('.mobile-spark').getBoundingClientRect();
              const price = row.querySelector('.mobile-watch-price').getBoundingClientRect();
              return {symbolHeight:symbol.height,sparkHeight:spark.height,centers:[symbol.y+symbol.height/2,spark.y+spark.height/2,price.y+price.height/2]};
            });
            assert(alignment.symbolHeight <= 55, 'compact identity stays inside the 72px row');
            assert(Math.max(...alignment.centers)-Math.min(...alignment.centers)<1,'all three columns vertically centered');
          }
          assert(Math.abs(actual.nav.y + actual.nav.height - height) < 1);
          const watchBottom = await page.locator('.mobile-watch').evaluate(el => el.getBoundingClientRect().bottom);
          assert(Math.abs(watchBottom - actual.nav.y) < 1, 'content ends above measured navigation');
        }
        measurements.push({ width, height, font, theme, actual, expected });
        await page.screenshot({
          path: path.join(output, `app-${theme}-${width}-${font}.png`),
        });
        await reference.screenshot({
          path: path.join(output, `a07-${theme}-${width}-${font}.png`),
        });
      }
    await page.setViewportSize({ width: 412, height: 852 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "14px";
      document.querySelector(".mobile-app").dataset.theme = "dark";
    });
    for (const [button, name] of [
      ["搜索并添加品种", "search"],
      ["选择自选分组", "groups"],
      ["管理自选", "manage"],
    ]) {
      if (button !== "选择自选分组") await page.getByRole("button", {name:"自选操作",exact:true}).click();
      await page.getByRole("button", { name: button, exact: true }).click();
      await page.screenshot({ path: path.join(output, name + ".png") });
      await page
        .getByRole("dialog")
        .last()
        .getByRole("button", { name: "关闭", exact: true })
        .click();
    }
    // Read-only control screenshots: expanded editors, nested forms, and large text.
    for (const theme of ["light", "dark"]) for (const font of [14, 21]) {
      await page.setViewportSize({width: 375, height: 812});
      await page.evaluate(({theme, font}) => {
        document.documentElement.style.fontSize = font + "px";
        document.querySelector(".mobile-app").dataset.theme = theme;
      }, {theme, font});
      const capture = async name => {
        const sheet = page.getByRole("dialog").last();
        assert(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth + 1), name + " has no horizontal overflow");
        await page.screenshot({path: path.join(output, `${name}-${theme}-${font}.png`)});
      };
      const close = () => page.getByRole("dialog").last().getByRole("button", {name:"关闭",exact:true}).click();
      await page.getByRole("button", {name:"自选操作",exact:true}).click();
      await page.getByRole("button", {name:"搜索并添加品种",exact:true}).click();
      await expect(page.locator(".mobile-search-row").first()).toBeVisible();
      await capture("search"); await close();
      await page.getByRole("button", {name:"自选操作",exact:true}).click();
      await capture("watch-actions"); await close();
      await page.getByRole("button", {name:"选择自选分组",exact:true}).click();
      await capture("groups");
      await page.getByRole("button", {name:"新建分组",exact:true}).click();
      await capture("new-group"); await close(); await close();
      await page.getByRole("button", {name:"自选操作",exact:true}).click();
      await page.getByRole("button", {name:"管理自选",exact:true}).click();
      await page.locator(".mobile-form-detail > summary").click();
      await capture("manage-expanded");
      await page.locator(".mobile-group-order > summary").first().click();
      await page.locator(".mobile-group-order > summary").first().scrollIntoViewIfNeeded();
      await capture("group-order");
      await page.getByLabel("分组名称", {exact:true}).first().fill("重点关注 · 编辑示例");
      await expect(page.getByRole("button", {name:"保存分组",exact:true})).toBeInViewport();
      await capture("group-save"); await close();
      await page.getByRole("button", {name:"放弃修改",exact:true}).click();
    }
    await page.setViewportSize({width:412,height:852});
    await page.evaluate(() => { document.documentElement.style.fontSize="14px"; });
    const touch = await context.newCDPSession(page);
    const swipe = async (startY, endY, end = true) => {
      await touch.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:180,y:startY}]});
      for(let y=startY+12;y<=endY;y+=12) await touch.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:180,y}]});
      if(end) await touch.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    };
    const beforePull = preferenceReads;
    await swipe(160,196);
    assert.equal(preferenceReads,beforePull,'short pull never refreshes');
    slowPreferences=500;
    await swipe(160,304,false);
    await expect(page.locator('.mobile-pull-refresh')).toHaveText('松开刷新');
    await page.screenshot({path:path.join(output,'pull-release.png')});
    await touch.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    await expect(page.locator('.mobile-pull-refresh')).toHaveText('正在刷新…');
    await page.screenshot({path:path.join(output,'pull-loading.png')});
    await expect(page.locator('.mobile-pull-refresh')).toBeEmpty({timeout:15000});
    assert(preferenceReads>beforePull,'pull refresh re-reads the watchlist');
    slowPreferences=0;
    // Refresh feedback must finish after visible observations, even if history is slow.
    const heldHistory = [], heldQuotes = [];
    await page.route('**/api/market-data/quotes', route => { heldQuotes.push(route); });
    await page.route('**/api/market-data/sparklines/prepare', route => { heldHistory.push(route); });
    await swipe(160,304);
    await expect.poll(() => heldHistory.length).toBeGreaterThan(0);
    await expect(page.locator('.mobile-pull-refresh')).toBeEmpty({timeout:1500});
    assert(heldHistory.length > 0 && heldQuotes.length > 0, 'supplier quotes and history remain pending when pull feedback closes');
    await page.screenshot({path:path.join(output,'pull-complete-history-pending.png')});
    for (const route of heldHistory) await route.fulfill({json:{as_of:Date.now(),items:[],preparation:'ready'}});
    await page.unroute('**/api/market-data/sparklines/prepare');
    for (const route of heldQuotes) await route.fallback();
    await page.unroute('**/api/market-data/quotes');
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:160,y:280},{x:240,y:280}]});
    await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:80,y:280},{x:320,y:280}]});
    await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.equal(await page.evaluate(()=>visualViewport.scale),1,'watch pinch does not scale the page');
    await touch.detach();
    await page.route("**/api/session", (route) => route.abort());
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect(page.locator(".mobile-watch-status")).toContainText(
      "手机离线",
    );
    await expect(page.locator(".mobile-toast")).toHaveCount(0);
    await expect(page.locator('.mobile-spark-caption').first()).toHaveText('缓存');
    await page.screenshot({ path: path.join(output, "offline-cache.png") });
    await page.unroute("**/api/session");
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect(page.locator(".mobile-watch-row.stale")).toHaveCount(0);
    const icons = () => page.locator('.mobile-nav svg').evaluateAll(els => els.map(el => el.outerHTML));
    const watchIcons = await icons();
    await page.getByRole('link', { name: '更多', exact: true }).click();
    assert.deepEqual(await icons(), watchIcons, 'same navigation icon set on every page');
    await page.getByRole('link', { name: '自选', exact: true }).click();
    const stockRow=page.locator('.mobile-watch-row').nth(4);
    for (const phase of ['previous','waiting','current']) {
      stockSessionPhase=phase;
      await page.getByRole('link',{name:'更多',exact:true}).click();
      await page.getByRole('link',{name:'自选',exact:true}).click();
      if (phase === 'current') {
        await expect(stockRow.locator('.mobile-spark[data-previous-session]')).toHaveCount(0);
        await expect(stockRow.locator('.mobile-spark-caption')).toHaveCount(0);
        await expect(stockRow.locator('.mobile-spark-previous-close')).toHaveCount(1);
        const end=await stockRow.locator('.mobile-spark path[stroke]').getAttribute('d');
        assert(Number([...end.matchAll(/[ML]([\d.]+),/g)].at(-1)[1])<10,'current opening data leaves future session blank');
      } else {
        await expect(stockRow.locator('.mobile-spark[data-previous-session]')).toHaveCount(1);
        await expect(stockRow.locator('.mobile-spark-caption')).toHaveText(phase==='waiting' ? '上一交易日 · 等待今日行情' : '上一交易日');
        await expect(stockRow.locator('.mobile-spark-previous-close')).toHaveCount(0);
        const gray=await stockRow.locator('.mobile-spark svg').evaluate(svg=>{
          const caption=svg.parentElement.querySelector('small');
          return getComputedStyle(svg).color===getComputedStyle(caption).color;
        });
        assert(gray,'previous-session curve uses inactive gray regardless of quote change');
      }
      for (const theme of ['light','dark']) {
        await page.locator('.mobile-app').evaluate((el,theme)=>el.dataset.theme=theme,theme);
        for(const width of [375,412]) {
          await page.setViewportSize({width,height:852});
          await page.screenshot({path:path.join(output,`session-${phase}-${theme}-${width}.png`)});
        }
      }
    }
    stockSessionPhase='normal';
    await page.route('**/api/market-data/sparklines', async route => {
      const body = route.request().postDataJSON(), left = Math.floor(Date.now()/86400000)*86400000;
      await route.fulfill({ json: { as_of: Date.now(), items: body.items.map(item => ({...item, window_start: left, window_end: left+86400000, points: [], status: 'empty' })) } });
    });
    await page.getByRole('link', { name: '更多', exact: true }).click();
    await page.getByRole('link', { name: '自选', exact: true }).click();
    await expect(page.locator('.mobile-spark-empty').first()).toHaveText('暂无日内数据');
    await page.screenshot({ path: path.join(output, 'spark-empty.png') });
    await page.unroute('**/api/market-data/sparklines');
    await page.route('**/api/market-data/sparklines', route => route.abort());
    await page.getByRole('link', { name: '更多', exact: true }).click();
    await page.getByRole('link', { name: '自选', exact: true }).click();
    // A failed refresh keeps a valid cached curve, or shows an inline error
    // when the preceding empty response is the available snapshot.
    await expect(page.locator('.mobile-spark[data-cached], .mobile-spark-empty[data-state="error"]')).toHaveCount(6);
    await expect(page.locator('.mobile-toast')).toHaveCount(0);
    await page.unroute('**/api/market-data/sparklines');
    emptyWatch = true;
    await page.evaluate(() =>
      dispatchEvent(new Event("mw-mobile-watchlists-changed")),
    );
    await expect(
      page.getByText("还没有关注品种", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: path.join(output, "empty.png") });
    const native = await browser.newContext({ viewport: { width: 412, height: 852 } });
    await native.addInitScript(() => {
      window.appearanceMessages = [];
      window.MWMobileHost = { postMessage(raw) {
        const message = JSON.parse(raw);
        if (message.action === 'appearance') window.appearanceMessages.push(message.theme);
        if (message.action === 'hello') queueMicrotask(() => window.MWMobileHost.onmessage({ data: JSON.stringify({ version: 1, appVersion: '0.1.3', capabilities: ['app-update-v1', 'appearance-v1'] }) }));
        if (message.action === 'check-app-update') setTimeout(() => window.MWMobileHost.onmessage({ data: JSON.stringify({ version: 1, appUpdate: { status: 'current', label: '当前已是最新版 0.1.3' } }) }), 100);
      } };
    });
    const updates = await native.newPage();
    updates.on('pageerror', e => errors.push(e.message));
    await updates.goto(url);
    await updates.getByRole('link', { name: '更多', exact: true }).click();
    await expect.poll(() => updates.evaluate(() => window.appearanceMessages.at(-1))).toBe('dark');
    await updates.getByRole('button', { name: /显示主题/ }).click();
    await expect.poll(() => updates.evaluate(() => window.appearanceMessages.at(-1))).toBe('light');
    await updates.getByRole('button', { name: /显示主题/ }).click();
    await expect.poll(() => updates.evaluate(() => window.appearanceMessages.at(-1))).toBe('dark');
    await updates.getByRole('button', { name: /检查更新/ }).click();
    const updateSheet = updates.getByRole('dialog', { name: '检查更新', exact: true });
    await expect(updateSheet).toContainText('当前应用：0.1.3');
    await updateSheet.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(updateSheet).toContainText('当前已是最新版 0.1.3');
    await expect(updateSheet).toContainText('当前应用：0.1.3');
    await updates.screenshot({ path: path.join(output, 'app-update.png') });
    await native.close();
    holdPreferences = true;
    const fresh = await browser.newContext({
        viewport: { width: 375, height: 812 },
      }),
      cold = await fresh.newPage();
    await cold.goto(url);
    await expect(cold.locator(".mobile-loading")).toBeVisible();
    await cold.screenshot({ path: path.join(output, "cold.png") });
    await fresh.close();
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(output, "proof.json"),
      JSON.stringify({ measurements, errors }, null, 2),
    );
    console.log(
      JSON.stringify({
        checks:
          "A07 geometry/style comparison, 8 layouts, 3 sheet entries + 28 narrow/large-font control captures, fixed gold price bounds, gray pips, wider charts, pull closes with history pending, pinch, delayed quote, offline cache, empty, loading",
        errors,
        output,
      }),
    );
  } finally {
    await context.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
