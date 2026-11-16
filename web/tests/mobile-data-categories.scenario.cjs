const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { createHash } = require("node:crypto");
const { expect } = require("@playwright/test");
module.exports = async ({
  page,
  context,
  server,
  datasets,
  make,
  entries,
  errors,
  proof,
  shot,
  close,
  out,
}) => {
  function add(code, kind, name, source = "dukascopy") {
    const row = make(
      {
        ...entries[kind === "metal" ? 1 : 0],
        logical_symbol: code,
        display_symbol: code,
        label: name,
        source,
        asset_class: kind,
      },
      createHash("sha256")
        .update(code + source)
        .digest("hex"),
      true,
    );
    row.mobile_identity = {
      category: { forex: "外汇", metal: "贵金属", equity: "美股" }[kind],
      provider: source === "yahoo" ? "Yahoo" : "Dukas",
      channel: "",
      product: "",
      environment: "",
      provider_symbol: code,
    };
    datasets.set(row.id, row);
    return row;
  }
  for (let n = 0; n < 27; n++)
    add("MET" + String(n).padStart(3, "0"), "metal", "贵金属示例" + n);
  for (let n = 0; n < 56; n++)
    add("FX" + String(n).padStart(3, "0"), "forex", "外汇示例" + n);
  add("AAPL", "equity", "苹果", "yahoo");
  const calls = [];
  let fail = false,
    gate = null,
    release;
  await page.route(
    "**/api/market-data/center/dataset-summaries?**",
    async (route) => {
      calls.push(new URL(route.request().url()).searchParams.toString());
      if (gate) await gate;
      if (fail)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"detail":"fixture read failed"}',
        });
      await route.continue();
    },
  );
  const tab = (name) => page.getByRole("tab", { name, exact: true }),
    scroll = page.locator('[data-slot="tabs-content"]:not([hidden]) .data-managed-scroll'),
    rows = page.locator('[data-slot="tabs-content"]:not([hidden]) .data-managed-row');
  const top = () => scroll.evaluate((el) => (el.scrollTop = 0)),
    bottom = () => scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
  async function pull(dy = 150, dx = 0) {
    await scroll.evaluate(
      (el, { dy, dx }) => {
        function event(type, x, y) {
          el.dispatchEvent(
            new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              touches:
                type === "touchend"
                  ? []
                  : [
                      new Touch({
                        identifier: 1,
                        target: el,
                        clientX: x,
                        clientY: y,
                      }),
                    ],
            }),
          );
        }
        event("touchstart", 100, 180);
        event("touchmove", 100 + dx, 180 + dy);
        event("touchend", 100 + dx, 180 + dy);
      },
      { dy, dx },
    );
  }
  await context.addInitScript(() => {
    window.__cacheHints = [];
    new MutationObserver(() => {
      for (const node of document.querySelectorAll('.data-inline-feedback,.data-feedback,.mobile-watch-status'))
        if (/上次读取|当前状态待核实|正在确认.*上次自选/.test(node.textContent)) window.__cacheHints.push(node.textContent);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/m/data`);
  await page.getByLabel("密码", { exact: true }).fill("fixture");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(rows).toHaveCount(25);
  await expect(tab("外汇")).toBeVisible();
  await expect(tab("贵金属")).toBeVisible();
  assert.equal(await tab("加密").count(), 0);
  proof.checks.push(
    "分类来自完整目录，首屏25条之后的类别可见；不存在的类别省略",
  );
  await shot("01-all");
  if (process.env.MOBILE_TAB_SWIPE === "1") {
    await require('./mobile-tab-swipe.helper.cjs').verifySwipeTabs({ page, context, root: page.locator('.data-category-tabs'), full: true });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    proof.checks.push('原生触摸左右切分类、首尾边界、短滑/斜滑/取消/多指/屏幕边缘/纵向锁定及点击键盘通过；无条目误开');
  }
  await tab("外汇").click();
  await expect(rows).toHaveCount(25);
  assert.equal(
    await rows.first().locator(".symbol-primary-code strong").textContent(),
    "FX000",
  );
  await bottom();
  await expect(rows).toHaveCount(50);
  await bottom();
  await expect(rows).toHaveCount(56);
  assert.equal(
    new Set(await rows.locator(".symbol-primary-code strong").allTextContents())
      .size,
    56,
  );
  assert(
    calls.some(
      (c) =>
        new URLSearchParams(c).get("category") === "forex" &&
        new URLSearchParams(c).get("page") === "3",
    ),
  );
  proof.checks.push("分类在后端分页前完成；自动加载2/3页，无重复");
  await scroll.evaluate((el) => (el.scrollTop = 1100));
  await page.waitForTimeout(100);
  const position = await scroll.evaluate((el) => el.scrollTop);
  await tab("贵金属").click();
  await expect(rows).toHaveCount(25);
  await tab("外汇").click();
  await expect(rows).toHaveCount(56);
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(position);
  await page.getByRole("link", { name: "更多", exact: true }).click();
  await page.getByRole("link", { name: "数据", exact: true }).click();
  await expect(tab("外汇")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(position);
  await page.reload();
  await expect(tab("外汇")).toHaveAttribute("aria-selected", "true");
  await expect(rows).toHaveCount(56);
  proof.checks.push("切分类/导航保留已加载内容和位置；重开记住类别和缓存范围");
  gate = new Promise((r) => (release = r));
  const readsBeforeReload = calls.length;
  await page.reload();
  await expect(rows).toHaveCount(56);
  await expect.poll(() => calls.length).toBeGreaterThan(readsBeforeReload);
  await top();
  const cachedY = (await rows.first().boundingBox()).y;
  await expect(page.locator('.data-inline-feedback')).toHaveCount(0);
  await shot('cached-revalidation-pending');
  const refreshed = page.waitForResponse(r => { const u = new URL(r.url()); return u.pathname.endsWith('/dataset-summaries') && u.searchParams.get('page') === '3'; });
  gate = null; release();
  await refreshed;
  await expect(rows).toHaveCount(56);
  await expect.poll(async () => (await rows.first().boundingBox()).y).toBe(cachedY);
  assert.deepEqual(await page.evaluate(() => window.__cacheHints), []);
  await shot('cached-revalidation-finished');
  proof.checks.push('慢请求时立即沿用自建缓存，不插入上次读取提示；刷新前后首行位置一致，MutationObserver无短暂提示');

  await top();
  gate = new Promise((r) => (release = r));
  const touch = await context.newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", {type:"touchStart",touchPoints:[{x:160,y:200}]});
  for(const y of [225,250,280,320,355]) await touch.send("Input.dispatchTouchEvent", {type:"touchMove",touchPoints:[{x:160,y}]});
  await expect(page.getByText("松开刷新", {exact:true})).toBeVisible();
  await touch.send("Input.dispatchTouchEvent", {type:"touchEnd",touchPoints:[]});
  await expect(page.getByText("正在刷新…", { exact: true })).toBeVisible();
  proof.checks.push("Chromium真实输入通道的触摸拖动/松手触发刷新");
  await shot("02-pull-refresh");
  release();
  gate = null;
  await expect(page.getByText("正在刷新…", { exact: true })).toHaveCount(0);
  await expect(rows).toHaveCount(56);
  const before = calls.length;
  await pull(60);
  await page.waitForTimeout(150);
  assert.equal(calls.length, before);
  await pull(150, 180);
  await page.waitForTimeout(150);
  assert.equal(calls.length, before);
  await scroll.evaluate((el) => (el.scrollTop = 120));
  await pull();
  await page.waitForTimeout(150);
  assert.equal(calls.length, before);
  proof.checks.push("下拉刷新及时收回并保留类别和内容；短拉/横拉/非顶部不触发");
  await top();
  fail = true;
  await pull();
  await expect(
    page.getByText("服务暂不可用，请稍后重试", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByText("正在刷新…", { exact: true })).toHaveCount(0);
  await expect(rows).toHaveCount(56);
  await shot("03-refresh-failed");
  fail = false;
  await pull();
  await expect(
    page.getByText("服务暂不可用，请稍后重试", { exact: false }),
  ).toHaveCount(0);
  proof.checks.push("刷新失败停止提示并保留旧内容；再次下拉恢复");
  await page
    .getByRole("button", { name: "搜索自建行情", exact: true })
    .click();
  const dlg = page.getByRole("dialog", { name: "搜索自建行情", exact: true });
  await dlg.getByRole("combobox", { name: "来源", exact: true }).click();
  await page
    .getByRole("option", { name: "Yahoo Finance", exact: true })
    .click();
  await close("搜索自建行情");
  await expect(
    page.getByText("没有符合条件的自建行情", { exact: true }),
  ).toBeVisible();
  await expect(tab("外汇")).toBeVisible();
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(tab("外汇")).toHaveAttribute("aria-selected", "true");
  await expect(rows).toHaveCount(56);
  proof.checks.push("来源与类别叠加筛选；空态保留分类；清除筛选保留类别");
  await page.getByRole("button", { name: "搜索自建行情", exact: true }).click();
  const searchTools = page.getByRole("dialog", { name: "搜索自建行情", exact: true });
  const searchInput = searchTools.getByRole("searchbox", { name: "搜索自建行情", exact: true });
  const beforeSearch = calls.length;
  await searchInput.fill("FX055");
  await page.waitForTimeout(300);
  assert.equal(calls.length, beforeSearch, "editing filters does not request each keystroke");
  await searchTools.getByRole("button", { name: "查看行情", exact: true }).click();
  await expect(searchTools).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("FX055");
  assert(calls.some(c => new URLSearchParams(c).get("query") === "FX055"));
  await expect(page.locator('[data-slot="tabs-content"]:not([hidden]) .data-list-caption')).toContainText("FX055");
  await expect(page.getByRole("button", { name: "搜索自建行情", exact: true })).toHaveAttribute("data-active", "true");
  await shot("search-tools-code-result");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(rows).toHaveCount(56);
  await expect(tab("外汇")).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "搜索自建行情", exact: true }).click();
  await searchInput.fill("不存在的品种");
  await searchInput.press("Enter");
  await expect(searchTools).toHaveCount(0);
  await expect(page.getByText("没有符合条件的自建行情", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(rows).toHaveCount(56);
  proof.checks.push("搜索工具批量提交条件；可搜索首屏外的自建；回车提交、空态、筛选标记及一键清除，保留当前分类");
  gate = new Promise((r) => (release = r));
  await top();
  await pull();
  await expect(page.getByText("正在刷新…", { exact: true })).toBeVisible();
  await tab("美股").click();
  release();
  gate = null;
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("AAPL");
  await expect(page.getByText("正在刷新…", { exact: true })).toHaveCount(0);
  proof.checks.push("刷新中切分类取消旧请求，迟到结果不覆盖新类别");
  for (const [code, label] of [
    ["ASAMPLE", "沪A"],
    ["HKSAMPLE", "港股"],
    ["BTCSAMPLE", "加密"],
    ["IDXSAMPLE", "股指"],
    ["FUTSAMPLE", "期货"],
    ["ETFSAMPLE", "ETF"],
    ["FUNDSAMPLE", "基金"],
    ["OTHERSAMPLE", "待分类"],
  ]) {
    const row = add(code, "other", "分类示例");
    row.mobile_identity.category = label;
  }
  await top();
  await pull();
  await expect(tab("其他")).toHaveCount(1);
  await tab("其他").click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("OTHERSAMPLE");
  proof.checks.push("多分类横向滚动可达；末端类别选择正常");
  for (const theme of ["light", "dark"])
    for (const width of [375, 412])
      for (const font of [14, 21]) {
        await page.getByRole("link", { name: "更多", exact: true }).click();
        if (
          (await page.locator(".mobile-app").getAttribute("data-theme")) !==
          theme
        )
          await page.getByRole("button", { name: /显示主题/ }).click();
        await page.getByRole("link", { name: "数据", exact: true }).click();
        await page.setViewportSize({ width, height: 880 });
        await page.evaluate(
          (f) => (document.documentElement.style.fontSize = f + "px"),
          font,
        );
        await tab("外汇").click();
        await expect(rows).toHaveCount(56);
        await top();
        if (process.env.MOBILE_TAB_SWIPE === "1") {
          const root = page.locator('.data-category-tabs');
          await require('./mobile-tab-swipe.helper.cjs').swipeContent(page, context, root, -100);
          await expect(tab('贵金属')).toHaveAttribute('aria-selected', 'true');
          await require('./mobile-tab-swipe.helper.cjs').swipeContent(page, context, root, 100);
          await expect(tab('外汇')).toHaveAttribute('aria-selected', 'true');
        }
        const g = await scroll.evaluate((el) => ({
          height: el.clientHeight,
          width: el.clientWidth,
          scrollWidth: el.scrollWidth,
          overflow: el.scrollWidth > el.clientWidth + 1,
        }));
        assert(
          g.height > 300 && !g.overflow,
          JSON.stringify({ theme, width, font, ...g }),
        );
        assert(
          (await page.locator(".data-category-nav").boundingBox()).height >= 44,
        );
        await shot(`list-${theme}-${width}-${font}`);
        await tab("美股").click();
        await expect(rows).toHaveCount(1);
        await shot(`stocks-${theme}-${width}-${font}`);
        await page.getByRole("button", { name: "搜索自建行情", exact: true }).click();
        const tools = page.getByRole("dialog", { name: "搜索自建行情", exact: true });
        await expect(tools.getByRole("searchbox", { name: "搜索自建行情", exact: true })).toBeVisible();
        await tools.getByRole("button", { name: "任务与来源", exact: true }).scrollIntoViewIfNeeded();
        await shot(`search-tools-${theme}-${width}-${font}`);
        await close("搜索自建行情");
      }
  await context.setOffline(true);
  await expect(
    page.getByRole("status").filter({ hasText: "当前离线" }),
  ).toBeVisible();
  await expect(rows).toHaveCount(1);
  const beforeOffline = calls.length;
  await top();
  await pull();
  await page.waitForTimeout(200);
  assert.equal(calls.length, beforeOffline);
  await context.setOffline(false);
  await expect(rows).toHaveCount(1);
  proof.checks.push(
    "离线禁用下拉，保留内容；375/412、深浅色、150%字号截图通过",
  );
  assert.deepEqual(errors, []);
  proof.passed = true;
  proof.calls = calls;
  fs.writeFileSync(
    path.join(out, "proof.json"),
    JSON.stringify(proof, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: proof.checks,
      screenshots: proof.screenshots.length,
      out,
    }),
  );
};
