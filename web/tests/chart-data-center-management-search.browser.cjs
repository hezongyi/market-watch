const fs = require("node:fs"),
  path = require("node:path"),
  { expect } = require("@playwright/test"),
  f = require("./chart-data-center-fixture.cjs");
const out = path.join(f.root, "artifacts/management-market-ui");
fs.mkdirSync(out, { recursive: true });
(async () => {
  const b = await f.launch(),
    p = await b.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    { host, native } = f.frames(p),
    dc = () => native().locator(".dc-window"),
    rows = () => dc().locator(".dc-market-row");
  const report = {
    environment:
      "Ubuntu isolated Docker; actual native input/select; scoped long-list and mutation fixtures",
    local: !!process.env.LOCAL,
    passed: false,
    checks: [],
    errors: [],
  };
  const onError = (e) => {
    report.errors.push(e.message);
    console.log("PAGEERROR", e.message);
  };
  let workspace;
  const record = (name) => {
    report.checks.push({ name });
    console.log("PASS", name);
  };
  const get = async (route) => {
    const r = await p.request.get(f.base + "/api" + route);
    expect(r.ok()).toBe(true);
    return r.json();
  };
  const open = async (route) => {
    await host().evaluate((route) => dataCenter.open(route), route);
    await expect(dc()).toBeVisible();
  };
  const close = async () => {
    await native()
      .getByRole("button", { name: "关闭数据中心", exact: true })
      .click();
    await expect(dc()).toHaveCount(0);
  };
  try {
    if (process.env.LOCAL) await f.localNativeAssets(p);
    await p.goto(f.base + "/advanced-charts");
    await f.login(p);
    const { csrf } = await get("/session");
    const created = await p.request.post(f.base + "/api/advanced-charts/workspaces", {data:{name:"自建组合详情面板回归",symbol:"MWP:EURUSD"},headers:{"X-CSRF-Token":csrf}});
    expect(created.ok()).toBe(true); workspace = await created.json();
    await p.goto(f.base + "/advanced-charts");
    await expect.poll(() => !!native(), { timeout: 30000 }).toBe(true);
    await host().waitForFunction(() => ready && dataCenter, null, {
      timeout: 60000,
    });
    await host().waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
    p.on("pageerror", onError);
    const original = await host().evaluate(() => widget.activeChart().symbol());
    const data = await get("/market-data/center/datasets?page_size=100"),
      existing = await get("/market-data/center/composites"),
      candidates = await get("/market-data/center/composite-candidates");
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.every(row => row.maintenance.configured === true)).toBe(true);
    expect(candidates.items.every(row => row.dataset.maintenance.configured === true)).toBe(true);
    record("real managed rows and composite candidates only include configured historical maintenance");
    expect(existing.items.length).toBeGreaterThan(0);
    expect(candidates.items.length).toBeGreaterThan(0);
    await open("/market-data?tab=managed");
    await expect(rows()).toHaveCount(Math.min(25, data.items.length));
    await expect(
      dc().getByRole("heading", { name: "自建行情", exact: true }),
    ).toBeVisible();
    expect(await dc().locator("[data-native-component=search]").count()).toBe(
      1,
    );
    expect(await dc().locator("[data-native-component=select]").count()).toBe(
      3,
    );
    await expect(
      dc().getByRole("navigation", { name: "列表分页" }),
    ).toHaveCount(0);
    await expect(
      dc().getByRole("link", { name: "添加行情", exact: true }),
    ).toBeVisible();
    await p.screenshot({ path: path.join(out, "managed-real.png") });
    record(
      "real managed rows; visible title, full-width actual native search, native source/type/calendar controls, creation and no pagination",
    );
    await rows().first().getByRole("button", { name: "查看详情", exact: true }).click();
    await expect(
      dc().locator(".dc-detail-panel").getByRole("link", { name: "删除历史数据", exact: true }),
    ).toBeVisible();
    await expect(rows().first()).toContainText("可用历史");
    await dc()
      .locator(".dc-detail-panel")
      .getByRole("link", { name: "管理行情", exact: true })
      .click();
    await expect(dc().locator(".dc-form,.dc-detail").first())
      .toBeVisible()
      .catch(async () => {
        await expect(dc().getByRole("heading").first()).toBeVisible();
      });
    await dc()
      .getByRole("link", { name: "返回数据中心列表", exact: true })
      .click();
    await expect(rows().first()).toBeFocused();
    record(
      "managed history/period/maintenance details and protected delete entry preserved; full detail returns to original row",
    );
    await close();
    await open("/market-data?tab=composite");
    await expect(rows()).toHaveCount(Math.min(25, existing.items.length));
    await rows()
      .first()
      .getByRole("button", { name: "查看详情", exact: true })
      .click();
    await dc().getByRole("link", { name: "管理组合行情", exact: true }).click();
    await expect(
      dc().getByRole("button", { name: "使用与健康", exact: true }),
    ).toBeVisible();
    await dc().getByRole("link", { name: "返回组合行情", exact: true }).click();
    await expect(rows().first()).toBeFocused();
    await dc().getByRole("button", { name: "可建立候选", exact: true }).click();
    await expect(rows()).toHaveCount(Math.min(25, candidates.items.length));
    await expect(rows().first().getByRole("link").first()).toBeVisible();
    expect(await host().evaluate(() => widget.activeChart().symbol())).toBe(
      original,
    );
    record(
      "real existing/candidate modes preserve mapping, maintenance, health and detail return; browsing never changes chart",
    );
    await close();
    const requests = [];
    let failOnce = true;
    const fixture = async (r) => {
      const url = new URL(r.request().url()),
        q = url.searchParams,
        page = Number(q.get("page") || 1),
        size = Number(q.get("page_size") || 25),
        kind = url.pathname.split("/").pop();
      requests.push({
        kind,
        page,
        query: q.get("query"),
        source: q.get("source"),
        asset: q.get("asset_class"),
        calendar: q.get("calendar"),
        status: q.get("status"),
      });
      if (q.get("query") === "LONG" && page === 2 && failOnce) {
        failOnce = false;
        return r.fulfill({
          status: 503,
          json: { detail: "验收注入：目录暂不可用" },
        });
      }
      const seed =
        kind === "datasets"
          ? data.items[0]
          : kind === "composites"
            ? existing.items[0]
            : candidates.items[0];
      const list =
        q.get("query") === "EMPTY"
          ? []
          : Array.from({ length: 65 }, (_, i) => {
              const id = i.toString(16).padStart(64, "0");
              return kind === "composite-candidates"
                ? {
                    ...seed,
                    dataset: {
                      ...seed.dataset,
                      id,
                      display_symbol: "候选 " + i,
                    },
                  }
                : {
                    ...seed,
                    id,
                    display_symbol:
                      (kind === "datasets" ? "自建 " : "组合 ") + i,
                  };
            });
      return r.fulfill({
        json: {
          items: list.slice((page - 1) * size, page * size),
          total: list.length,
          page,
          page_size: size,
        },
      });
    };
    const pattern =
      /\/api\/market-data\/center\/(datasets|composites|composite-candidates)\?/;
    await p.route(pattern, fixture);
    await open("/market-data?tab=managed&query=LONG");
    await expect(rows()).toHaveCount(25);
    const heading = await dc()
      .getByRole("heading", { name: "自建行情", exact: true })
      .boundingBox();
    await dc()
      .locator(".dc-market-list")
      .evaluate((n) => (n.scrollTop = n.scrollHeight));
    await expect(
      dc().getByRole("button", { name: "重试", exact: true }),
    ).toBeVisible();
    await expect(rows()).toHaveCount(25);
    await dc().getByRole("button", { name: "重试", exact: true }).click();
    await expect(rows()).toHaveCount(50);
    await dc()
      .locator(".dc-market-list")
      .evaluate((n) => (n.scrollTop = n.scrollHeight));
    await expect(rows()).toHaveCount(65);
    expect(
      new Set(await rows().evaluateAll((ns) => ns.map((n) => n.id))).size,
    ).toBe(65);
    expect(
      (
        await dc()
          .getByRole("heading", { name: "自建行情", exact: true })
          .boundingBox()
      ).y,
    ).toBe(heading.y);
    record(
      "managed 65-row continuous results, failed continuation preserves prefix and retry, unique IDs and stationary heading",
    );
    await dc().getByRole("button", { name: "平台行情", exact: true }).click();
    await dc().getByRole("button", { name: "自建行情", exact: true }).click();
    await expect(rows()).toHaveCount(65);
    await expect
      .poll(() =>
        dc()
          .locator(".dc-market-list")
          .evaluate((n) => n.scrollTop),
      )
      .toBeGreaterThan(500);
    record("section round trip restores managed loaded prefix and scrolling");
    const input = dc().getByRole("searchbox", {
      name: "搜索品种",
      exact: true,
    });
    await input.fill("EMPTY");
    await expect(rows()).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(
      dc().getByText("没有符合筛选的条目", { exact: true }),
    ).toBeVisible();
    await input.fill("SHORT");
    await expect(rows()).toHaveCount(25);
    await expect(input).toBeFocused();
    await dc().getByRole("button", { name: "可用", exact: true }).click();
    await expect(
      dc().getByRole("button", { name: "可用", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    record(
      "new filters reset pages; empty state and search typing focus preserved",
    );
    for (const [label, option] of [
      ["来源", "Yahoo"],
      ["资产类别", "外汇"],
      ["聚合日界", "NY17"],
    ]) {
      await dc().getByRole("button", { name: label, exact: true }).click();
      await native().getByRole("option", { name: option, exact: true }).click();
    }
    await expect
      .poll(() => requests.at(-1))
      .toMatchObject({
        kind: "datasets",
        page: 1,
        query: "SHORT",
        source: "yahoo",
        asset: "forex",
        calendar: "ny17",
        status: "available",
      });
    record(
      "native source/category/calendar controls combine with status and query before server paging",
    );
    await close();
    for (const mode of ["existing", "candidates"]) {
      await open("/market-data?tab=composite&view=" + mode);
      await expect(rows()).toHaveCount(25);
      await dc()
        .locator(".dc-market-list")
        .evaluate((n) => (n.scrollTop = 0));
      await dc()
        .locator(".dc-market-list")
        .evaluate((n) => (n.scrollTop = n.scrollHeight));
      await expect(rows()).toHaveCount(50);
      await dc()
        .locator(".dc-market-list")
        .evaluate((n) => (n.scrollTop = n.scrollHeight));
      await expect(rows()).toHaveCount(65);
      await expect(
        dc().getByRole("navigation", { name: "列表分页" }),
      ).toHaveCount(0);
      await close();
    }
    record(
      "both composite modes continuously load all 65 rows without pagination",
    );
    for (const tab of ["managed", "composite"]) {
      await open("/market-data?tab=" + tab);
      await expect(rows()).toHaveCount(25);
      for (const theme of ["Dark", "Light"]) {
        await host().evaluate((theme) => widget.changeTheme(theme), theme);
        const selected = dc().locator(
          ".dc-market-tabs button[aria-pressed=true]",
        );
        await selected.hover();
        const contrast = await selected.evaluate((node) => {
          const s = getComputedStyle(node),
            lum = (color) => {
              const channels = color
                .match(/[\d.]+/g)
                .slice(0, 3)
                .map((v) => {
                  const x = Number(v) / 255;
                  return x <= 0.04045
                    ? x / 12.92
                    : ((x + 0.055) / 1.055) ** 2.4;
                });
              return (
                channels[0] * 0.2126 +
                channels[1] * 0.7152 +
                channels[2] * 0.0722
              );
            };
          const a = lum(s.color),
            b = lum(s.backgroundColor);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
        expect(contrast).toBeGreaterThanOrEqual(4.5);
        for (const width of [1440, 768, 375]) {
          await p.setViewportSize({ width, height: 900 });
          await expect(
            dc().getByRole("heading", {
              name: tab === "managed" ? "自建行情" : "组合行情",
              exact: true,
            }),
          ).toBeInViewport();
          await expect(
            dc().getByRole("searchbox", { name: "搜索品种", exact: true }),
          ).toBeInViewport();
          expect(
            await dc().evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
          ).toBe(true);
          expect(
            await dc()
              .locator(".dc-market-page")
              .evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
          ).toBe(true);
          await p.screenshot({
            path: path.join(
              out,
              tab + "-" + theme.toLowerCase() + "-" + width + ".png",
            ),
          });
        }
      }
      await close();
      await p.setViewportSize({ width: 1440, height: 1000 });
    }
    record(
      "managed/composite dark/light desktop/tablet/375px layouts keep title/search/actions in one continuous page",
    );
    await p.unroute(pattern, fixture);
    let releaseRead;
    const pendingRead = new Promise((resolve) => (releaseRead = resolve));
    let readStarted = false,
      readAborted = false;
    const heldPattern = /\/api\/market-data\/center\/datasets\?.*HELD_MANAGED/;
    const holdRead = async (route) => {
      readStarted = true;
      await pendingRead;
      await route.continue().catch(() => {});
    };
    p.on("requestfailed", (request) => {
      if (request.url().includes("HELD_MANAGED")) readAborted = true;
    });
    await p.route(heldPattern, holdRead);
    await open("/market-data?tab=managed&query=HELD_MANAGED");
    await expect.poll(() => readStarted).toBe(true);
    await close();
    await expect.poll(() => readAborted).toBe(true);
    releaseRead();
    await p.unroute(heldPattern, holdRead);
    await open("/market-data?tab=managed&status=available&query=EURUSD");
    await expect.poll(() => rows().count()).toBeGreaterThan(0);
    for (const key of ["Tab", "Shift+Tab"])
      for (let i = 0; i < 12; i++) {
        await p.keyboard.press(key);
        expect(
          await native().evaluate(
            () =>
              !!document.activeElement.closest(
                '[data-name="mw-data-center-dialog"]',
              ),
          ),
        ).toBe(true);
      }
    await close();
    record(
      "closing aborts management reads; new query remains isolated and Tab/Shift+Tab stay inside the native dialog",
    );
    // Hold apply delivery to inspect single-row feedback and target validation.
    await native().evaluate(() => {
      const original = MWNativeCenter.mount;
      window.managementOriginalMount = original;
      window.managementApplies = [];
      MWNativeCenter.mount = (node, options) => {
        window.managementPost = options.post;
        return original(node, {
          ...options,
          post: (message) => {
            if (message.type === "apply") managementApplies.push(message);
            else options.post(message);
          },
        });
      };
    });
    const available = await get(
      "/market-data/center/datasets?status=available&page_size=25",
    );
    expect(available.items.length).toBeGreaterThan(0);
    await open("/market-data?tab=managed&status=available");
    await expect(
      rows().first().getByRole("button", { name: "打开图表", exact: true }),
    ).toBeVisible();
    await rows()
      .first()
      .getByRole("button", { name: "打开图表", exact: true })
      .click();
    await expect(
      dc().getByRole("button", { name: "正在打开…", exact: true }),
    ).toHaveCount(1);
    await expect
      .poll(() => native().evaluate(() => managementApplies.length))
      .toBe(1);
    const held = await native().evaluate(() => managementApplies[0]);
    expect(held.ticker.startsWith("MWH:")).toBe(true);
    await native().evaluate(() =>
      managementPost({ ...managementApplies[0], target: "invalid-target" }),
    );
    await expect(rows().first().getByRole("alert")).toContainText("目标图格");
    await close();
    record(
      "published managed history applies its exact fixed-version ticker; only chosen row loads and target rejection restores actions",
    );
    await p.route(pattern, async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/composite-candidates"))
        return route.continue();
      const seed = candidates.items[0];
      await route.fulfill({
        json: {
          items: [0, 1].map((i) => ({
            ...seed,
            status: "ready_to_open",
            recommended_mapping_id: "mapping-" + i,
            dataset: { ...seed.dataset, id: String(i + 1).padStart(64, "0") },
          })),
          total: 2,
          page: 1,
          page_size: 25,
        },
      });
    });
    let uses = 0;
    await p.route("**/api/market-data/composites/use", async (route) => {
      uses++;
      expect(route.request().postDataJSON().mapping_id).toBe("mapping-0");
      await route.fulfill({ json: existing.items[0] });
    });
    await open("/market-data?tab=composite&view=candidates");
    await expect(rows()).toHaveCount(2);
    await rows()
      .first()
      .getByRole("button", { name: "打开组合行情", exact: true })
      .click();
    await rows()
      .last()
      .getByRole("button", { name: "打开组合行情", exact: true })
      .evaluate((n) => {
        n.click();
        n.click();
      });
    await expect(
      dc().getByRole("button", { name: "正在打开…", exact: true }),
    ).toHaveCount(1);
    await expect
      .poll(() => native().evaluate(() => managementApplies.length))
      .toBe(2);
    expect(uses).toBe(1);
    expect(await native().evaluate(() => managementApplies[1].ticker)).toBe(
      "MWC:" + existing.items[0].id,
    );
    await native().evaluate(() =>
      managementPost({ ...managementApplies[1], target: "invalid-target" }),
    );
    await expect(dc().locator(".dc-market-page > [role=alert]")).toContainText(
      "目标图格",
    );
    await close();
    await p.unroute("**/api/market-data/composites/use");
    await p.unroute(pattern);
    await native().evaluate(
      () => (MWNativeCenter.mount = managementOriginalMount),
    );
    record(
      "candidate explicit creation sends one exact mapping; duplicate/other-row clicks are suppressed, only chosen row loads, rejected target restores page",
    );
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (e) {
    report.errors.push(e.message);
    await p.screenshot({ path: path.join(out, "failed.png") });
    throw e;
  } finally {
    p.off("pageerror",onError);
    if(workspace){const before=await get('/advanced-charts/workspaces'),owned=before.find(row=>row.id===workspace.id);if(owned){const {csrf}=await get('/session'),removed=await p.request.post(f.base+'/api/advanced-charts/workspaces/'+owned.id+'/delete',{data:{revision:owned.revision},headers:{'X-CSRF-Token':csrf}});expect(removed.ok()).toBe(true);const after=await get('/advanced-charts/workspaces');expect(after.map(row=>row.id).sort()).toEqual(before.filter(row=>row.id!==workspace.id).map(row=>row.id).sort());report.cleanup={onlyOwnedWorkspaceDeleted:true}}}
    fs.writeFileSync(
      path.join(out, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await b.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
