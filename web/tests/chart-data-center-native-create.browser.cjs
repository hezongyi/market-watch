// Deployed native catalog and real read-only preflight; scoped mutation/fault fixtures only.
const fs = require("node:fs"),
  path = require("node:path"),
  { expect } = require("@playwright/test"),
  f = require("./chart-data-center-fixture.cjs");
const out = path.join(f.root, "artifacts/creation-flow-redesign/browser");
fs.mkdirSync(out, { recursive: true });
(async () => {
  const b = await f.launch(),
    p = await b.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    { host, native } = f.frames(p);
  const dc = () => native().locator(".dc-window"),
    rows = () =>
      dc().locator('[data-name="symbol-search-dialog-content-item"]:visible'),
    search = () =>
      dc().getByRole("searchbox", { name: "搜索品种", exact: true });
  const report = {
    environment:
      "Ubuntu isolated Docker; deployed native catalog and real preflight; create/control faults intercepted without supplier work",
    passed: false,
    checks: [],
    errors: [],
  };
  let workspace,
    release = () => {};
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
    if (
      await dc().getByRole("button", { name: "放弃修改", exact: true }).count()
    )
      await dc().getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(dc()).toHaveCount(0);
  };
  const source = async (name) => {
    await dc().getByRole("button", { name: "来源", exact: true }).click();
    await native().getByRole("option", { name, exact: true }).click();
  };
  const prepare = async (code) => {
    await open("/market-data/datasets/new?source=dukascopy");
    await search().fill(code);
    await expect(rows()).toHaveCount(1, { timeout: 15000 });
    await rows()
      .first()
      .getByRole("button", { name: "选择", exact: true })
      .click();
    await dc().getByRole("button", { name: "配置历史 →", exact: true }).click();
    await expect(
      dc().getByLabel("起始交易日期", { exact: true }),
    ).toBeVisible();
    await dc().getByLabel("价格精度（必填）", { exact: true }).fill("5");
    await dc().getByLabel("起始交易日期", { exact: true }).fill("2026-10-07");
  };
  const submit = () =>
    dc().getByRole("button", { name: "创建并开始准备历史", exact: true });
  try {
    await p.goto(f.base + "/advanced-charts");
    await f.login(p);
    const { csrf } = await get("/session");
    const cr = await p.request.post(
      f.base + "/api/advanced-charts/workspaces",
      {
        data: { name: "添加自建行情流程验收", symbol: "MWP:EURUSD" },
        headers: { "X-CSRF-Token": csrf },
      },
    );
    expect(cr.ok()).toBe(true);
    workspace = await cr.json();
    await p.goto(f.base + "/advanced-charts");
    await expect.poll(() => !!native(), { timeout: 30000 }).toBe(true);
    await host().waitForFunction(
      () => ready && dataCenter && widget.activeChart().dataReady(),
      null,
      { timeout: 60000 },
    );
    p.on("pageerror", (e) => report.errors.push(e.message));
    const baseline = await host().evaluate(() => ({
      symbol: widget.activeChart().symbol(),
      epoch: workspaceEpoch,
    }));
    await expect(
      native().getByRole("button", { name: "创建告警", exact: true }),
    ).toHaveCount(0);
    await open("/market-data?tab=sources");
    await expect(
      dc().getByRole("heading", { name: "自建行情", exact: true }),
    ).toBeVisible();
    await expect(dc().getByText("来源与能力", { exact: true })).toHaveCount(0);
    await expect(dc().locator(".dc-window-nav button")).toHaveCount(4);
    await close();
    record(
      "top Create Alert removed; source/capabilities page and navigation removed; old source route resolves safely to managed list",
    );
    const catalog = await get(
      "/market-data/history-catalog/search?source=dukascopy&symbol_type=forex&limit=100",
    );
    let candidate;
    for (const item of catalog.items) {
      const r = await p.request.post(
        f.base + "/api/market-data/center/datasets/check",
        {
          data: {
            source: item.source,
            provider_symbol: item.provider_symbol,
            logical_symbol: item.logical_symbol,
            asset_class: item.asset_class,
            precision: 5,
            aggregation_calendar: "ny17",
            start_date: "2026-10-07",
          },
          headers: { "X-CSRF-Token": csrf },
        },
      );
      if (r.ok() && (await r.json()).status === "ready") {
        candidate = item;
        break;
      }
    }
    expect(candidate).toBeTruthy();
    const code = candidate.provider_symbol;
    const managed = await get("/market-data/center/datasets?page_size=1"),
      existing = await get(
        "/market-data/center/datasets/" + managed.items[0].id,
      );
    await open("/market-data/datasets/new");
    await expect(search()).toBeVisible();
    await expect(
      dc().getByRole("button", { name: "配置历史 →", exact: true }),
    ).toBeDisabled();
    await expect(
      dc().getByRole("navigation", { name: "列表分页" }),
    ).toHaveCount(0);
    await expect(
      native().locator('[data-dialog-name="选择来源品种"]'),
    ).toHaveCount(0);
    await dc().getByRole("button", { name: "来源", exact: true }).click();
    await expect(
      native().getByRole("option", { name: "Yahoo", exact: true }),
    ).toHaveCount(0);
    await expect(
      native().getByRole("option", { name: "Binance", exact: true }),
    ).toHaveCount(0);
    await native()
      .getByRole("option", { name: "Dukascopy", exact: true })
      .click();
    const filtered = p.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith("/history-catalog/search") &&
        url.searchParams.get("symbol_type") === "commodity" &&
        url.searchParams.get("query") === code
      );
    });
    await dc().getByRole("tab", { name: "金属", exact: true }).click();
    await search().fill(code);
    expect((await (await filtered).json()).items).toEqual([]);
    await expect(
      dc().getByText("没有代码符合您的条件", { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    // Native no-feed retains previous rows below a clipped, header-only list.
    // Locator visibility ignores that clipping, so check the scroll viewport.
    await expect
      .poll(
        () =>
          rows().evaluateAll(
            (nodes) =>
              nodes.filter((n) => {
                const rect = n.querySelector("button").getBoundingClientRect();
                const clip = n
                  .closest(".dc-platform-scroll")
                  .getBoundingClientRect();
                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  rect.bottom > clip.top &&
                  rect.top < clip.bottom
                );
              }).length,
          ),
        { timeout: 15000 },
      )
      .toBe(0);
    expect(
      await rows().evaluateAll((nodes) =>
        nodes.every((n) =>
          [...n.querySelectorAll("button")].every(
            (b) => b.disabled && b.tabIndex === -1,
          ),
        ),
      ),
    ).toBe(true);
    await dc().getByRole("tab", { name: "外汇", exact: true }).click();
    await expect(rows()).toHaveCount(1, { timeout: 15000 });
    await rows()
      .first()
      .getByRole("button", { name: "选择", exact: true })
      .click();
    await expect(
      dc().getByRole("heading", { name: "添加自建行情", exact: true }),
    ).toBeVisible();
    await expect(
      rows().first().getByRole("button", { name: "已选择", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    record(
      "single native embedded search/tabs/header source Select; supported sources only, no duplicate picker/pager; row selection does not navigate",
    );
    await dc().getByRole("button", { name: "配置历史 →", exact: true }).click();
    await expect(submit()).toBeDisabled();
    await expect(dc().getByLabel("创建摘要")).toContainText("待确认");
    await dc().getByLabel("价格精度（必填）", { exact: true }).fill("5");
    await dc().getByLabel("起始交易日期", { exact: true }).fill("2999-01-01");
    await expect(dc().getByRole("alert")).toContainText("历史起点");
    await expect(
      dc().getByLabel("起始交易日期", { exact: true }),
    ).toHaveAttribute("aria-invalid", "true");
    await expect(dc().locator("#create-day-error")).toContainText("历史起点");
    await expect(submit()).toBeDisabled();
    await dc().getByLabel("起始交易日期", { exact: true }).fill("2026-10-07");
    await expect(submit()).toBeEnabled({ timeout: 15000 });
    await expect(
      dc().getByRole("checkbox", { name: "M1", exact: true }),
    ).toBeDisabled();
    await expect(
      dc().getByRole("checkbox", { name: "M1", exact: true }),
    ).toBeChecked();
    await dc().getByRole("checkbox", { name: "H1", exact: true }).check();
    await dc().getByRole("button", { name: "日线划分", exact: true }).click();
    await native()
      .getByRole("option", { name: "UTC 00:00", exact: true })
      .click();
    await expect(dc().getByLabel("创建摘要")).toContainText("UTC0");
    await expect(submit()).toBeEnabled({ timeout: 15000 });
    await p.screenshot({ path: path.join(out, "config-light-1440.png") });
    record(
      "real read-only preflight enforces missing precision and invalid date; native M1/period controls and calendar conversion update live summary",
    );
    const checkPattern = "**/api/market-data/center/datasets/check";
    const duplicate = (route) =>
      route.fulfill({ json: { status: "existing", start: null, existing } });
    await p.route(checkPattern, duplicate);
    await dc().getByLabel("起始交易日期", { exact: true }).fill("2026-10-06");
    await expect(
      dc().getByRole("link", { name: "管理已有行情", exact: true }),
    ).toBeVisible();
    await expect(submit()).toBeDisabled();
    await p.unroute(checkPattern, duplicate);
    await dc().getByLabel("起始交易日期", { exact: true }).fill("2026-10-07");
    await expect(submit()).toBeEnabled({ timeout: 15000 });
    record(
      "existing-identity preflight provides exact existing management link and blocks overwrite; editing reruns draft check",
    );
    let submits = 0,
      payload;
    const created = {
      dataset: {
        ...existing,
        id: "f".repeat(64),
        logical_symbol: candidate.logical_symbol,
        display_symbol: candidate.display_symbol,
        identity: {
          ...existing.identity,
          source: candidate.source,
          provider_symbol: candidate.provider_symbol,
        },
        aggregation_calendar: "utc0",
        latest_version_id: null,
        usable_timeframes: [],
      },
      task: { id: "00000000-0000-0000-0000-000000009999", status: "pending" },
    };
    const held = new Promise((resolve) => (release = resolve));
    const post = async (route) => {
      submits++;
      payload = route.request().postDataJSON();
      await held;
      await route.fulfill({ json: created }).catch(() => {});
    };
    await p.route("**/api/market-data/center/datasets", post);
    await submit().evaluate((n) => {
      n.click();
      n.click();
    });
    await expect.poll(() => submits).toBe(1);
    expect(payload.create_only).toBe(true);
    expect(payload.dataset.provider_symbol).toBe(code);
    expect(payload.dataset.catalog_id).toBe(candidate.catalog_id);
    expect(payload.maintenance.timeframes).toContain("M1");
    expect(payload.maintenance.timeframes).toContain("H1");
    expect(payload.maintenance.target_start).toBe(
      Date.parse("2026-10-07T00:00:00Z"),
    );
    release();
    await expect(
      dc().getByRole("heading", { name: "创建结果", exact: true }),
    ).toBeVisible();
    await expect(dc()).toContainText("历史准备任务已提交");
    await expect(
      dc().getByRole("button", { name: "打开图表", exact: true }),
    ).toHaveCount(0);
    await expect(
      dc().getByRole("link", { name: "查看任务", exact: true }),
    ).toHaveAttribute("href", new RegExp("dataset_id=" + created.dataset.id));
    await p.screenshot({ path: path.join(out, "result-light-1440.png") });
    await dc()
      .getByRole("button", { name: "继续添加行情", exact: true })
      .click();
    await expect(search()).toBeVisible();
    await expect(
      dc().getByRole("button", { name: "配置历史 →", exact: true }),
    ).toBeDisabled();
    await close();
    await p.unroute("**/api/market-data/center/datasets", post);
    record(
      "duplicate click sends one exact create-only request; success stays on result with task/list/management actions, no premature chart open",
    );
    let tries = 0,
      lookups = 0;
    const failure = async (route) => {
      tries++;
      await route.fulfill({
        status: 502,
        json: { detail: "fixture unknown outcome" },
      });
    };
    const lookup = async (route) => {
      lookups++;
      await route.fulfill({
        json: lookups === 1 ? { found: false } : { found: true, ...created },
      });
    };
    await p.route("**/api/market-data/center/datasets", failure);
    await p.route("**/api/market-data/center/creations/*?*", lookup);
    await prepare(code);
    await expect(submit()).toBeEnabled({ timeout: 15000 });
    await submit().click();
    await expect(
      dc().getByRole("button", { name: "核查创建结果并重试", exact: true }),
    ).toBeEnabled();
    await expect(
      dc().getByLabel("起始交易日期", { exact: true }),
    ).toBeDisabled();
    await dc()
      .getByRole("button", { name: "核查创建结果并重试", exact: true })
      .click();
    await expect(
      dc().getByRole("heading", { name: "创建结果", exact: true }),
    ).toBeVisible();
    expect(tries).toBe(1);
    expect(lookups).toBe(2);
    await close();
    await p.unroute("**/api/market-data/center/datasets", failure);
    await p.unroute("**/api/market-data/center/creations/*?*", lookup);
    record(
      "unknown outcome pins draft and reconciles same submission; found result returns success without a second POST",
    );
    await open("/market-data/datasets/new");
    await dc().getByRole("button", { name: "手工登记", exact: true }).click();
    await dc().getByLabel("品种标识", { exact: true }).fill("testing");
    await dc().getByLabel("准确来源代码", { exact: true }).fill("TEST/ING");
    await dc().getByRole("button", { name: "资产类别", exact: true }).click();
    await native().getByRole("option", { name: "指数", exact: true }).click();
    await expect(submit()).toBeDisabled();
    await expect(
      dc().getByRole("button", { name: "日线划分", exact: true }),
    ).toContainText("请选择");
    await dc().getByRole("button", { name: "来源", exact: true }).click();
    await native()
      .getByRole("option", { name: "OANDA Practice", exact: true })
      .click();
    await expect(dc().getByLabel("准确来源代码", { exact: true })).toHaveValue(
      "",
    );
    await expect(dc().getByLabel("品种标识", { exact: true })).toHaveValue("");
    await close();
    record(
      "manual registration uses same content area; index requires explicit calendar; source change clears identity and precision instead of carrying stale values",
    );
    let calls = [];
    const many = async (route) => {
      const q = new URL(route.request().url()).searchParams,
        start = Number(q.get("offset") || 0);
      calls.push(start);
      await route.fulfill({
        json: {
          items: Array.from({ length: 125 }, (_, i) => ({
            ...candidate,
            catalog_id: "DK:" + String(i).padStart(36, "0"),
            logical_symbol: "T" + i,
            provider_symbol: "T" + i,
            display_symbol: "T" + i,
            label: "连续目录-" + i,
          })).slice(start, start + 50),
          total: 125,
          sources: [],
        },
      });
    };
    await p.route("**/api/market-data/history-catalog/search?*", many);
    await open("/market-data/datasets/new");
    await expect(rows()).toHaveCount(50, { timeout: 15000 });
    const list = dc().locator(".dc-platform-scroll");
    await list.evaluate((n) => (n.scrollTop = n.scrollHeight));
    await expect(rows()).toHaveCount(100, { timeout: 15000 });
    await list.evaluate((n) => (n.scrollTop = n.scrollHeight));
    await expect(rows()).toHaveCount(125, { timeout: 15000 });
    expect(calls).toContain(50);
    expect(calls).toContain(100);
    await close();
    await p.unroute("**/api/market-data/history-catalog/search?*", many);
    record(
      "native catalog sentinel reads qualified offsets through 125 rows without page buttons",
    );
    for (const theme of ["Light", "Dark"]) {
      await host().evaluate((theme) => widget.changeTheme(theme), theme);
      for (const width of [1440, 768, 375]) {
        await p.setViewportSize({ width, height: 900 });
        await prepare(code);
        await expect(submit()).toBeEnabled({ timeout: 15000 });
        expect(
          await dc()
            .locator(".dc-create-page")
            .evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
        ).toBe(true);
        await expect(submit()).toBeInViewport();
        await p.screenshot({
          path: path.join(out, `config-${theme.toLowerCase()}-${width}.png`),
        });
        await dc()
          .getByRole("button", { name: "返回选择品种", exact: true })
          .click();
        await expect(search()).toBeVisible();
        await expect(search()).toHaveValue(code);
        await dc()
          .getByRole("button", { name: "配置历史 →", exact: true })
          .click();
        await expect(
          dc().getByLabel("起始交易日期", { exact: true }),
        ).toHaveValue("2026-10-07");
        await expect(
          dc().getByLabel("价格精度（必填）", { exact: true }),
        ).toHaveValue("5");
        await dc()
          .getByRole("button", { name: "返回选择品种", exact: true })
          .click();
        await expect(
          dc().getByRole("button", { name: "配置历史 →", exact: true }),
        ).toBeInViewport();
        expect(
          await dc()
            .locator(".dc-create-page")
            .evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
        ).toBe(true);
        await p.screenshot({
          path: path.join(out, `catalog-${theme.toLowerCase()}-${width}.png`),
        });
        await close();
      }
    }
    record(
      "dark/light desktop/tablet/375px retain fixed actions and native catalog; config scrolls without horizontal overflow",
    );
    await p.setViewportSize({ width: 1440, height: 1000 });
    await prepare(code);
    await expect(submit()).toBeEnabled({ timeout: 15000 });
    let latePosts = 0;
    const latePromise = new Promise((resolve) => (release = resolve)),
      late = async (route) => {
        latePosts++;
        await latePromise;
        await route.fulfill({ json: created }).catch(() => {});
      };
    await p.route("**/api/market-data/center/datasets", late);
    await submit().click();
    await expect.poll(() => latePosts).toBe(1);
    await close();
    await open("/market-data?tab=platform&source=yahoo&query=MSFT");
    release();
    await expect(
      dc().getByRole("heading", { name: "平台行情", exact: true }),
    ).toBeVisible();
    await expect(
      dc().getByRole("heading", { name: "创建结果", exact: true }),
    ).toHaveCount(0);
    await close();
    record(
      "closing pending create and opening another page is safe; late completion cannot replace new content",
    );
    expect(
      await host().evaluate(() => ({
        symbol: widget.activeChart().symbol(),
        epoch: workspaceEpoch,
      })),
    ).toEqual(baseline);
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (e) {
    report.errors.push(e.message);
    await p.screenshot({ path: path.join(out, "failed.png") }).catch(() => {});
    throw e;
  } finally {
    release();
    if (workspace) {
      const before = await get("/advanced-charts/workspaces"),
        owned = before.find((row) => row.id === workspace.id);
      if (owned) {
        const { csrf } = await get("/session");
        const deleted = await p.request.post(
          f.base + "/api/advanced-charts/workspaces/" + owned.id + "/delete",
          {
            data: { revision: owned.revision },
            headers: { "X-CSRF-Token": csrf },
          },
        );
        expect(deleted.ok()).toBe(true);
        expect(
          (await get("/advanced-charts/workspaces"))
            .map((row) => row.id)
            .sort(),
        ).toEqual(
          before
            .filter((row) => row.id !== owned.id)
            .map((row) => row.id)
            .sort(),
        );
        report.cleanup = {
          onlyOwnedWorkspaceDeleted: true,
          noRealCreatePost: true,
        };
      }
    }
    fs.writeFileSync(
      path.join(out, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await b.close();
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
