// Ubuntu isolated instance, real source snapshots and pinned history replay.
const { chromium, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const root = path.resolve(__dirname, "../..");
  const base = process.env.MW_DATA_ACCEPTANCE_URL || "http://127.0.0.1:16589";
  const password = JSON.parse(
    fs.readFileSync(path.join(root, "artifacts/data-integration/login.json")),
  ).password;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const result = {};
  try {
    await page.goto(base);
    await page.getByLabel("管理员密码").fill(password);
    await page.getByRole("button", { name: "登录工作台" }).click();
    await expect(page.getByLabel("管理员密码")).not.toBeVisible();
    await page.goto(base + "/market-data");
    await expect(
      page.getByRole("heading", { name: "行情来源与历史版本" }),
    ).toBeVisible();
    await expect(
      page.getByText("浏览器订阅已连接", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("canvas").first()).toBeVisible();
    await expect(page.locator(".error")).toHaveCount(0);
    const live = await page.evaluate(async () =>
      (await fetch("/api/market-data/live")).json(),
    );
    expect(
      live.filter((row) => ["EURUSD", "XAUUSD"].includes(row.logical_symbol))
        .length,
    ).toBe(2);
    expect(
      live.every(
        (row) => row.identity.environment === "practice" && !row.fallback_ready,
      ),
    ).toBeTruthy();
    result.initial = live.map((row) => ({
      symbol: row.logical_symbol,
      quality: row.quality,
      epoch: row.connection_epoch,
    }));
    await page.screenshot({
      path: path.join(
        root,
        "docs/verification/data-integration/market-data-desktop.png",
      ),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: path.join(
        root,
        "docs/verification/data-integration/market-data-mobile.png",
      ),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const state = await context.storageState();
    const more = await Promise.all(
      [1, 2].map(async () => {
        const other = await browser.newContext({ storageState: state });
        const tab = await other.newPage();
        await tab.goto(base + "/market-data");
        await expect(
          tab.getByText("浏览器订阅已连接", { exact: true }),
        ).toBeVisible();
        return other;
      }),
    );
    const after = await page.evaluate(async () =>
      (await fetch("/api/market-data/live")).json(),
    );
    expect(after.map((row) => row.connection_epoch)).toEqual(
      live.map((row) => row.connection_epoch),
    );
    result.concurrent_browsers = 3;
    result.browser_connections_changed_upstream_epoch = false;
    await Promise.all(more.map((other) => other.close()));
    await context.setOffline(true);
    await expect(
      page.getByText("浏览器订阅断开，正在重连", { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await context.setOffline(false);
    await expect(
      page.getByText("浏览器订阅已连接", { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    const reconnected = await page.evaluate(async () =>
      (await fetch("/api/market-data/live")).json(),
    );
    expect(reconnected.map((row) => row.connection_epoch)).toEqual(
      after.map((row) => row.connection_epoch),
    );
    result.browser_disconnect_recovered = true;
    const datasets = await page.evaluate(async () =>
      (await fetch("/api/market-data/datasets")).json(),
    );
    const third = datasets.find(
      (row) =>
        row.logical_symbol === "GBPUSD" && row.identity.source === "oanda",
    );
    expect(third).toBeTruthy();
    await page
      .locator(".replay-controls")
      .first()
      .locator("select")
      .selectOption(third.id);
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const rows = await (await fetch("/api/market-data/live")).json();
            return rows.filter(
              (row) =>
                ["EURUSD", "XAUUSD", "GBPUSD"].includes(row.logical_symbol) &&
                row.quality === "healthy",
            ).length;
          }),
        { timeout: 90000 },
      )
      .toBe(3);
    result.three_instruments_shared_stream = true;
    await expect(page.locator(".error")).toHaveCount(0);
    await page.getByLabel("价格阈值").fill("999999");
    const watchResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/watches") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "创建价格穿越监控", exact: true })
      .click();
    const watchReply = await watchResponse;
    expect(watchReply.status()).toBe(201);
    const watch = await watchReply.json();
    expect(watch.instrument_id).toBe(third.instrument_id);
    try {
      await expect
        .poll(
          async () =>
            page.evaluate(async (id) => {
              const rows = await (await fetch("/api/watches")).json();
              return rows.find((row) => row.id === id)?.state.last_event ?? 0;
            }, watch.id),
          { timeout: 75000 },
        )
        .toBeGreaterThan(watch.state.last_event ?? 0);
      result.same_source_watch_advanced_on_real_m1 = true;
    } finally {
      await page.evaluate(async (id) => {
        const session = await (await fetch("/api/session")).json();
        const response = await fetch(`/api/watches/${id}/cancel`, {
          method: "POST",
          headers: { "X-CSRF-Token": session.csrf },
        });
        if (!response.ok) throw Error("Could not cancel the acceptance watch");
      }, watch.id);
    }
    await page.getByRole("link", { name: "选择此版本演练" }).first().click();
    await expect(page.getByLabel("不可变历史版本")).not.toHaveValue("");
    const selected = await page.getByLabel("不可变历史版本").inputValue();
    const replayResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/replays") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "创建演练", exact: true }).click();
    const response = await replayResponse;
    expect(response.status()).toBe(201);
    const replay = await response.json();
    expect(replay.dataset_version).toBe(selected);
    expect(replay.input_manifest.identity.source).toBe("dukascopy");
    const stepped = page.waitForResponse((response) =>
      response.url().endsWith(`/api/replays/${replay.id}/step`),
    );
    await page.getByRole("button", { name: "下一根", exact: true }).click();
    const step = await (await stepped).json();
    expect(step.bars.length).toBeGreaterThan(0);
    expect(step.dataset_version).toBe(selected);
    result.replay = {
      version: selected,
      source: replay.input_manifest.identity.source,
      observed_minutes: replay.input_manifest.rows,
      visible_after_step: step.bars.length,
    };
    const chart = await page.evaluate(
      async (instrument) => {
        const session = await (await fetch("/api/session")).json();
        async function post(path, body) {
          const response = await fetch("/api" + path, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": session.csrf,
            },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw Error("Chart acceptance setup failed");
          return response.json();
        }
        const workspace = await post("/charts/workspaces", {
          name: "行情接入验收",
        });
        workspace.document.panels[0].instrument = instrument;
        workspace.document.panels[0].timeframe = "M1";
        await post(`/charts/workspaces/${workspace.id}/save`, {
          name: workspace.name,
          revision: workspace.revision,
          document: workspace.document,
        });
        return workspace.id;
      },
      live.find((row) => row.logical_symbol === "EURUSD").instrument_id,
    );
    const chartReply = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/charts/data") &&
        response.request().postDataJSON().instrument ===
          live.find((row) => row.logical_symbol === "EURUSD").instrument_id,
    );
    await page.goto(base + `/chart-workspaces/${chart}`);
    const chartResponse = await chartReply;
    expect(chartResponse.status()).toBe(200);
    expect((await chartResponse.json()).bars.length).toBeGreaterThan(0);
    await expect(page.getByLabel("当前图表品种")).toHaveValue(
      live.find((row) => row.logical_symbol === "EURUSD").instrument_id,
    );
    result.qualified_identity_in_existing_chart_workspace = true;
    result.errors = errors;
    expect(errors).toEqual([]);
    fs.writeFileSync(
      path.join(
        root,
        "docs/verification/data-integration/browser-acceptance.json",
      ),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
