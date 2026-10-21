// Requires the task-owned R1 fixture in docs/verification/composite-mapping-native-20261021.
// Real native chart controls + real save/use first; scoped fault injection afterward.
const { chromium, expect } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, "../.."),
  out = path.join(root, "artifacts/composite-mapping-native");
fs.mkdirSync(out, { recursive: true });
const base = process.env.MW_MAPPING_URL || "https://localhost:18481",
  chart = "https://localhost:18482";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw Error("This test only writes to isolated loopback R1");
const credentials =
  process.env.MW_MAPPING_CREDENTIALS ||
  "/home/quant/.local/share/market-watch-docker/previews/mw-composite-mapping-20261021/credentials.json";
const report = { checks: [], errors: [], passed: false },
  record = (name) => {
    report.checks.push(name);
    console.log("PASS", name);
  };
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] }),
    page = await browser.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
  page.on("pageerror", (e) => report.errors.push(e.message));
  page.setDefaultTimeout(20000);
  const host = () =>
      page.frames().find((f) => f.url().startsWith(chart + "/?")),
    native = () => page.frames().find((f) => f.url().startsWith("blob:")),
    dc = () => native().locator(".dc-window");
  const get = async (url) => {
    const r = await page.request.get(base + "/api" + url);
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const open = async (id) => {
    await host().evaluate(
      (route) => dataCenter.open(route),
      `/market-data/datasets/${id}/mapping`,
    );
    await expect(
      dc().getByRole("heading", { name: /^配置实时来源/ }),
    ).toBeVisible();
    await expect(
      dc().getByText("当前账户目录已读取", { exact: true }),
    ).toBeVisible();
  };
  const close = async () => {
    await native()
      .getByRole("button", { name: "关闭数据中心", exact: true })
      .click();
    if (
      await dc().getByRole("button", { name: "放弃修改", exact: true }).count()
    )
      await dc().getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(dc()).toHaveCount(0);
  };
  const select = async (code) => {
    const exact = (
      await get(
        `/market-data/history-catalog?source=oanda&query=${code}&page_size=50`,
      )
    ).items.find((r) => r.provider_symbol === code);
    await dc()
      .getByRole("button", { name: /^(选择品种|更换)$/ })
      .click();
    const picker = native().locator(
      '[data-dialog-name="选择 OANDA Practice 品种"]',
    );
    await expect(picker).toBeVisible();
    await picker.getByRole("searchbox").fill(code);
    await picker.locator(`[data-symbol-name="${exact.catalog_id}"]`).click();
    await expect(picker).toHaveCount(0);
    return exact;
  };
  const option = async (label, value) => {
    await dc().getByRole("button", { name: label, exact: true }).click();
    await native()
      .getByRole("option", { name: value, exact: true })
      .first()
      .click();
  };
  const proof = async () => {
    await dc()
      .getByRole("button", { name: /补充说明|查看 \/ 修改/ })
      .click();
    await option("产品关系", "相同产品");
    await dc()
      .getByLabel("历史产品官方依据", { exact: true })
      .fill("https://example.test/synthetic-history");
    await dc()
      .getByLabel("实时产品官方依据", { exact: true })
      .fill("https://example.test/synthetic-live");
    await dc()
      .getByLabel("核对说明", { exact: true })
      .fill(
        "Synthetic fixture: reviewed exact underlying, currency, product and Bid basis.",
      );
    await dc().getByRole("checkbox").check();
  };
  let mappingRoute, lateRoute;
  try {
    if (process.env.MW_LOCAL_ASSETS)
      for (const ext of ["js", "css"])
        await page.route("**/data-center-native." + ext, (r) =>
          r.fulfill({
            path: path.join(root, "web/dist/data-center-native." + ext),
            contentType: ext === "js" ? "application/javascript" : "text/css",
          }),
        );
    await page.goto(base + "/advanced-charts/D1_EURUSD");
    await page
      .getByLabel("管理员密码")
      .fill(JSON.parse(fs.readFileSync(credentials)).login_password);
    await page.locator("button.auth-submit").click();
    await expect
      .poll(() => !!host() && !!native(), { timeout: 60000 })
      .toBe(true);
    await host().waitForFunction(
      () => typeof ready !== "undefined" && ready && !loading,
      null,
      { timeout: 60000 },
    );
    const datasets = (
      await get("/market-data/center/datasets?source=dukascopy&page_size=100")
    ).items;
    const usd = datasets.find((d) => d.logical_symbol === "USDCAD"),
      eur = datasets.find((d) => d.logical_symbol === "EURUSD"),
      gold = datasets.find((d) => d.logical_symbol === "XAUUSD");
    expect(usd && eur && gold).toBeTruthy();
    for (const [d, baseCode, currency] of [
      [eur, "EUR", "USD"],
      [gold, "XAU", "USD"],
      [usd, "USD", "CAD"],
    ]) {
      await open(d.id);
      await select(d.identity.provider_symbol.replace("/", "_"));
      await expect(dc().locator(".dc-mapping-facts")).toContainText(baseCode);
      await expect(dc().locator(".dc-mapping-facts")).toContainText(currency);
      await expect(dc().getByRole("checkbox")).not.toBeChecked();
      expect(
        await dc()
          .getByRole("button", { name: "保存映射版本", exact: true })
          .count(),
      ).toBe(0);
      if (d !== usd) await close();
    }
    record(
      "native single picker, FX/metal defaults and fresh manual confirmation",
    );
    await dc().getByRole("button", { name: "仅保存", exact: true }).click();
    await expect(
      dc().getByRole("alert").filter({ hasText: "请补充并核对匹配说明" }),
    ).toBeVisible();
    await expect(dc().getByLabel("核对说明", { exact: true })).toBeVisible();
    // Validation has expanded the details already.
    await option("产品关系", "相同产品");
    await dc()
      .getByLabel("历史产品官方依据", { exact: true })
      .fill("https://example.test/synthetic-history");
    await dc()
      .getByLabel("实时产品官方依据", { exact: true })
      .fill("https://example.test/synthetic-live");
    await dc()
      .getByLabel("核对说明", { exact: true })
      .fill(
        "Synthetic fixture: exact USD/CAD products and Bid prices explicitly reviewed.",
      );
    await dc().getByRole("checkbox").check();
    expect(
      await dc()
        .getByLabel("核对说明", { exact: true })
        .evaluate(
          (n) =>
            n.tagName === "TEXTAREA" &&
            n.required &&
            n.minLength === 10 &&
            !!n.closest('[data-native-component="textarea"]'),
        ),
    ).toBe(true);
    for (const name of ["仅保存", "保存并打开图表", "刷新目录"])
      expect(
        await dc()
          .getByRole("button", { name, exact: true })
          .evaluate((n) => !!n.closest('[data-native-component="button"]')),
      ).toBe(true);
    await native()
      .getByRole("button", { name: "关闭数据中心", exact: true })
      .click();
    await expect(dc().getByRole("alertdialog")).toBeVisible();
    await dc().getByRole("button", { name: "继续编辑", exact: true }).click();
    const compositesBefore = (await get("/market-data/center/composites"))
      .total;
    let useWrites = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/composites/use"))
        useWrites++;
    });
    const saving = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith(`/datasets/${usd.id}/mappings`),
    );
    await dc().getByRole("button", { name: "仅保存", exact: true }).click();
    const savedResponse = await saving;
    expect(savedResponse.status(), await savedResponse.text()).toBe(201);
    const savedMapping = await savedResponse.json();
    await expect(
      dc().getByRole("heading", { name: "组合行情", exact: true }),
    ).toBeVisible();
    expect(useWrites).toBe(0);
    expect((await get("/market-data/center/composites")).total).toBe(
      compositesBefore,
    );
    await close();
    record(
      "native buttons/textarea semantics, dirty guard and real save-only without composite use",
    );
    await host().evaluate(() => widget.setLayout("2h"));
    await expect
      .poll(() => host().evaluate(() => widget.chartsCount()))
      .toBe(2);
    const chartBefore = await host().evaluate(() => ({
      active: widget.activeChartIndex(),
      panes: Array.from({ length: widget.chartsCount() }, (_, i) => ({
        symbol: widget.chart(i).symbol(),
        resolution: widget.chart(i).resolution(),
      })),
    }));
    await open(usd.id);
    await expect(dc().locator(".dc-mapping-source").last()).toContainText(
      "USD_CAD",
    );
    await expect(dc().getByRole("checkbox")).not.toBeChecked();
    await dc().getByRole("checkbox").check();
    const opening = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" && r.url().endsWith("/composites/use"),
    );
    await dc()
      .getByRole("button", { name: "保存并打开图表", exact: true })
      .click();
    const used = await opening;
    expect(used.status(), await used.text()).toBe(201);
    const composite = await used.json();
    await expect(dc()).toHaveCount(0, { timeout: 30000 });
    await expect
      .poll(
        () =>
          host().evaluate(() => widget.activeChart().symbol().toLowerCase()),
        { timeout: 30000 },
      )
      .toBe("mwc:" + composite.id);
    await expect
      .poll(() => host().evaluate(() => widget.activeChart().dataReady()), {
        timeout: 45000,
      })
      .toBe(true);
    const other = 1 - chartBefore.active;
    expect(
      await host().evaluate(
        (i) => ({
          symbol: widget.chart(i).symbol(),
          resolution: widget.chart(i).resolution(),
        }),
        other,
      ),
    ).toEqual(chartBefore.panes[other]);
    record(
      "saved mapping hydrates, re-review required; exact composite loads and other pane remains unchanged",
    );
    // Current-account directory missing and refresh failure are separate states.
    let empty = true,
      refreshes = 0;
    const catalogPattern = "**/api/market-data/history-catalog?*";
    const catalogHandler = async (r) => {
      if (empty)
        await r.fulfill({
          json: {
            items: [],
            total: 0,
            page: 1,
            page_size: 1,
            requires_refresh: true,
          },
        });
      else await r.continue();
    };
    await page.route(catalogPattern, catalogHandler);
    await host().evaluate(
      (route) => dataCenter.open(route),
      `/market-data/datasets/${eur.id}/mapping`,
    );
    await expect(
      dc().getByRole("button", { name: "读取品种", exact: true }),
    ).toBeVisible();
    expect(await dc().getByLabel("核对说明", { exact: true }).count()).toBe(0);
    await page.route(
      "**/api/market-data/history-catalog/refresh",
      async (r) => {
        refreshes++;
        if (refreshes === 1)
          await r.fulfill({
            status: 422,
            json: { detail: "Synthetic directory temporarily unavailable" },
          });
        else {
          empty = false;
          await r.fulfill({ json: { total: 3 } });
        }
      },
    );
    await dc().getByRole("button", { name: "读取品种", exact: true }).click();
    await expect(dc().getByRole("alert")).toContainText("品种目录读取失败");
    await dc().getByRole("button", { name: "读取品种", exact: true }).click();
    await expect(
      dc().getByRole("button", { name: "选择品种", exact: true }),
    ).toBeVisible();
    await page.unroute(catalogPattern, catalogHandler);
    await close();
    record(
      "empty directory hides the form; refresh failure has an explicit retry",
    );
    // Lost save reply: lock draft, reconcile exact proof, then retry use without resaving.
    const pattern = `**/api/market-data/datasets/${eur.id}/mappings`;
    let saves = 0,
      pending = null,
      useAttempts = 0,
      readsBeforeRetry = 0;
    mappingRoute = async (r) => {
      if (r.request().method() === "POST") {
        saves++;
        const body = r.request().postDataJSON();
        pending = {
          ...savedMapping,
          id: "a".repeat(64),
          target_identity: {
            ...savedMapping.target_identity,
            provider_symbol: "EUR_USD",
          },
          target_display_symbol: "EURUSD",
          match: body.match,
        };
        await r.fulfill({
          status: 503,
          json: { detail: "Synthetic lost save reply" },
        });
      } else await r.fulfill({ json: { items: pending ? [pending] : [] } });
    };
    await page.route(pattern, mappingRoute);
    const useHandler = async (r) => {
      useAttempts++;
      await r.fulfill({
        status: 503,
        json: { detail: "Synthetic open failed" },
      });
    };
    await page.route("**/api/market-data/composites/use", useHandler);
    const compositeHandler = async (r) => {
      readsBeforeRetry++;
      await r.continue();
    };
    await page.route(
      "**/api/market-data/center/composites?*",
      compositeHandler,
    );
    await open(eur.id);
    await select("EUR_USD");
    await proof();
    await dc()
      .getByRole("button", { name: "保存并打开图表", exact: true })
      .click();
    await expect(
      dc().getByRole("button", { name: "核查保存结果", exact: true }),
    ).toBeVisible();
    await expect(dc().getByLabel("核对说明", { exact: true })).toBeDisabled();
    await dc()
      .getByRole("button", { name: "核查保存结果", exact: true })
      .click();
    await expect(dc().getByRole("status")).toContainText("已确认配置保存成功");
    await dc()
      .getByRole("button", { name: "保存并打开图表", exact: true })
      .click();
    await expect(
      dc().getByRole("button", { name: "重试打开图表", exact: true }),
    ).toBeVisible();
    await dc()
      .getByRole("button", { name: "重试打开图表", exact: true })
      .click();
    await expect.poll(() => useAttempts).toBe(2);
    expect(saves).toBe(1);
    expect(readsBeforeRetry).toBeGreaterThan(0);
    await expect(
      dc().getByRole("button", { name: "重试打开图表", exact: true }),
    ).toBeEnabled();
    await close();
    record(
      "uncertain save reconciles; failed open retains mapping ID and reads before idempotent retry",
    );
    await page.unroute("**/api/market-data/composites/use", useHandler);
    await page.unroute(
      "**/api/market-data/center/composites?*",
      compositeHandler,
    );
    // Multiple mappings never silently choose newest; account mismatch never restores.
    const multiple = async (r) =>
      r.fulfill({
        json: { items: [pending, { ...pending, id: "c".repeat(64) }] },
      });
    await page.unroute(pattern, mappingRoute);
    mappingRoute = multiple;
    await page.route(pattern, mappingRoute);
    await open(eur.id);
    await expect(
      dc().getByRole("button", { name: "使用已保存配置", exact: true }),
    ).toBeVisible();
    await expect(dc().getByRole("checkbox")).toHaveCount(0);
    await expect(
      dc().getByRole("button", { name: "保存并打开图表", exact: true }),
    ).toBeDisabled();
    await option("使用已保存配置", /EURUSD/);
    await expect(dc().getByRole("checkbox")).not.toBeChecked();
    await close();
    record("multiple mappings require explicit choice and fresh confirmation");
    await page.unroute(pattern, mappingRoute);
    mappingRoute = async (r) =>
      r.fulfill({ json: { items: [{ ...pending, current_account: false }] } });
    await page.route(pattern, mappingRoute);
    await open(eur.id);
    await expect(
      dc().getByText("已有配置属于其他账户，请为当前账户重新选择。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(dc().getByRole("checkbox")).toHaveCount(0);
    await close();
    record("old-account mappings cannot restore a current selection");
    await page.unroute(pattern, mappingRoute);
    mappingRoute = async (r) => r.fulfill({ json: { items: [pending] } });
    await page.route(pattern, mappingRoute);
    await open(eur.id);
    await expect(dc().getByRole("checkbox")).toBeEnabled();
    await dc().getByRole("checkbox").check();
    const exactQuery =
      "**/api/market-data/history-catalog?source=oanda&query=EUR_USD&page_size=100";
    const disappeared = async (r) =>
      r.fulfill({ json: { items: [], total: 0, requires_refresh: false } });
    await page.route(exactQuery, disappeared);
    await dc().getByRole("button", { name: "刷新目录", exact: true }).click();
    await expect(dc().getByRole("alert")).toContainText(
      "原品种已不在当前账户目录",
    );
    await expect(
      dc().getByRole("button", { name: "保存并打开图表", exact: true }),
    ).toBeDisabled();
    await page.unroute(exactQuery, disappeared);
    await close();
    record(
      "refresh revalidates the selected exact code and clears invalid selection",
    );
    // A completed save/use reply after leaving must not apply to the later page.
    await page.unroute(pattern, mappingRoute);
    mappingRoute = async (r) =>
      r.fulfill({
        json: r.request().method() === "POST" ? pending : { items: [pending] },
      });
    await page.route(pattern, mappingRoute);
    let release;
    const delayed = new Promise((resolve) => (release = resolve));
    lateRoute = async (r) => {
      await delayed;
      await r.fulfill({ json: { id: composite.id } });
    };
    await page.route("**/api/market-data/composites/use", lateRoute);
    await open(eur.id);
    await expect(dc().getByRole("checkbox")).toBeEnabled();
    await dc().getByRole("checkbox").check();
    const before = await host().evaluate(() => widget.activeChart().symbol());
    await dc()
      .getByRole("button", { name: "保存并打开图表", exact: true })
      .click();
    await expect(dc().getByRole("status")).toContainText("正在打开组合行情");
    await dc().getByRole("button", { name: "自建行情", exact: true }).click();
    await expect(
      dc().getByRole("heading", { name: "自建行情", exact: true }),
    ).toBeVisible();
    const lateReply = page.waitForResponse((r) =>
      r.url().endsWith("/composites/use"),
    );
    release();
    await lateReply;
    await native().evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect
      .poll(() => host().evaluate(() => widget.activeChart().symbol()))
      .toBe(before);
    await close();
    record(
      "late use response after navigation cannot apply or navigate a later form",
    );
    await page.unroute("**/api/market-data/composites/use", lateRoute);
    await page.unroute(pattern, mappingRoute);
    const toast = native().getByRole("button", {
      name: "关闭即时通知",
      exact: true,
    });
    // Fault-injection notifications may auto-dismiss during their exit animation.
    // Clear them atomically for screenshots; this is not an interaction assertion.
    await toast.evaluateAll((buttons) =>
      buttons.forEach((button) => button.click()),
    );
    await expect(toast).toHaveCount(0);
    await host().evaluate(() => widget.changeTheme("Dark"));
    await open(gold.id);
    await expect(dc()).toHaveAttribute("data-theme", "dark");
    await select("XAU_USD");
    await dc().getByRole("button", { name: "补充说明", exact: true }).click();
    await expect(
      dc().getByRole("button", { name: "历史产品类型", exact: true }),
    ).toContainText("现货金属");
    await dc()
      .locator(".dc-mapping-scroll")
      .evaluate((n) => (n.scrollTop = n.scrollHeight));
    await page.screenshot({ path: path.join(out, "mapping-proof-dark.png") });
    await dc().getByRole("button", { name: "收起", exact: true }).click();
    await dc()
      .locator(".dc-mapping-scroll")
      .evaluate((n) => (n.scrollTop = 0));
    await page.screenshot({ path: path.join(out, "mapping-dark.png") });
    await host().evaluate(() => widget.changeTheme("Light"));
    await expect(dc()).toHaveAttribute("data-theme", "light");
    await page.screenshot({ path: path.join(out, "mapping-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      dc().getByRole("button", { name: "保存并打开图表", exact: true }),
    ).toBeInViewport();
    expect(await dc().evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: path.join(out, "mapping-mobile.png") });
    record(
      "real metal products, light/dark theme and narrow viewport with visible actions",
    );
    await close();
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (e) {
    report.failure = e.message;
    report.ui = native()
      ? await dc()
          .innerText()
          .catch(() => null)
      : await page.locator("body").innerText();
    await page
      .screenshot({ path: path.join(out, "failure.png") })
      .catch(() => {});
    throw e;
  } finally {
    fs.writeFileSync(
      path.join(out, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
