// Real suppliers and licensed widget on the task-owned Ubuntu Docker instance.
// Only the chart JavaScript is instrumented to expose its widget handle.
// No API mocks, synthetic publications, SQL writes, or production access.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { chromium, expect } = require("@playwright/test");
const task = "mw-managed-live-rollover-20261113",
  origin = process.env.MW_ACCEPTANCE_ORIGIN || "https://127.0.0.1:18447";
assert(
  ["https://127.0.0.1:18447", "https://192.168.7.232:18447"].includes(origin),
);
const dir = path.join(
  process.env.HOME,
  ".local/share/market-watch-docker/previews",
  task,
);
const config = JSON.parse(fs.readFileSync(path.join(dir, "run.json")));
assert.equal(config.name, task);
assert(
  config.services.api.environment.ALERTS_DATABASE_URL.endsWith(
    "@postgres:5432/rollover",
  ),
);
const { login_password: password } = JSON.parse(
  fs.readFileSync(path.join(dir, "credentials.json")),
);
const out = process.env.MW_ACCEPTANCE_OUTPUT || "/tmp/mw-rollover-real";
fs.mkdirSync(out, { recursive: true });
const phase = process.argv[2] || "inspect";
assert(["inspect", "manual", "scheduled"].includes(phase));
const proof = {
  task,
  origin,
  phase,
  evidence: "real supplier / browser, not Android device",
  checks: [],
  history: [],
  screenshots: [],
  errors: [],
};
const persist = () =>
  fs.writeFileSync(
    path.join(out, `rollover-${phase}.json`),
    JSON.stringify(proof, null, 2) + "\n",
  );
const check = (message) => {
  proof.checks.push(message);
  persist();
  console.log("PASS:", message);
};
(async () => {
  const browser = await chromium.launch(),
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
      serviceWorkers: "block",
    });
  const instrument = async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        "const Original=TradingView.widget;TradingView.widget=function(...args){const widget=new Original(...args);globalThis.MW_TEST_WIDGET=widget;return widget;};\n" +
        (await response.text()) +
        `
const mount=MWChartAdapter.mount;MWChartAdapter.mount=(...args)=>{const adapter=mount(...args),update=adapter.update;adapter.update=function(message){if(message.type==='market-event'){const v=message.event,last=v?.latest_bar?.at(-1)||v?.bars?.at(-1);globalThis.MW_TEST_EVENTS.push({at:Date.now(),type:v?.type,reason:v?.reason,revision:v?.resolved_revision_id,last:last?.start,complete:last?.complete,generation:v?.generation});}return update.call(this,message);};return adapter;};`,
    });
  };
  await context.route(/\/chart\.[a-f0-9]+\.js$/, instrument);
  await context.addInitScript(() => {
    window.MW_TEST_EVENTS = [];
    addEventListener("message", (event) => {
      if (event.data?.type === "market-event") {
        const v = event.data.event,
          last = v?.latest_bar?.at(-1) || v?.bars?.at(-1);
        window.MW_TEST_EVENTS.push({
          at: Date.now(),
          type: v?.type,
          reason: v?.reason,
          revision: v?.resolved_revision_id,
          last: last?.start,
          complete: last?.complete,
          generation: v?.generation,
        });
      }
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => proof.errors.push(e.message));
  page.on("response", async (r) => {
    if (!r.ok() || !/\/api\/charts\/(data|history-loads)/.test(r.url())) return;
    const body = await r.json().catch(() => ({})),
      v = body.result || body;
    if (v.bars?.length)
      proof.history.push({
        at: Date.now(),
        revision: v.revision_id || v.resolved_revision_id,
        input: v.input_revision,
        count: v.bars.length,
        first: v.bars[0].start,
        last: v.bars.at(-1).start,
        current: v.bars.at(-1).complete === false,
      });
  });
  async function request(url, body) {
    const csrf =
      body === undefined
        ? null
        : (await (await context.request.get(origin + "/api/session")).json())
            .csrf;
    const r = await context.request.fetch(origin + "/api" + url, {
      method: body === undefined ? "GET" : "POST",
      headers: csrf ? { "x-csrf-token": csrf } : {},
      data: body,
      timeout: 120000,
    });
    assert(r.ok(), `${url}: HTTP ${r.status()} ${await r.text()}`);
    return r.json();
  }
  const ready = (target = page) =>
    expect
      .poll(
        () =>
          target.evaluate(() => {
            try {
              return !!window.MW_TEST_WIDGET?.activeChart().dataReady();
            } catch {
              return false;
            }
          }),
        { timeout: 120000 },
      )
      .toBe(true);
  const state = (target = page) =>
    target.evaluate(() => {
      const c = window.MW_TEST_WIDGET.activeChart();
      return {
        symbol: c.symbol(),
        resolution: c.resolution(),
        visible: c.getVisibleRange(),
        studies: c.getAllStudies(),
        shapes: c.getAllShapes(),
      };
    });
  async function shot(name, target = page) {
    await target.waitForTimeout(450);
    await target.screenshot({
      path: path.join(out, name + ".png"),
      fullPage: true,
    });
    proof.screenshots.push(name);
    persist();
  }
  let restorePlan, desktop;
  try {
    await page.goto(origin + "/m/data");
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "添加自建", exact: true }),
    ).toBeVisible();
    const rows = (
      await request("/market-data/center/dataset-summaries?page_size=25")
    ).items;
    const euro = rows.find(
      (d) => (d.provider_display_symbol || d.display_symbol) === "EURUSD",
    );
    assert(euro, "Real EURUSD must already be created/enabled via mobile UI");
    proof.dataset = euro.id;
    const live = () => request(`/market-data/datasets/${euro.id}/continuation`),
      before = await live();
    assert.equal(before.enabled, true);
    assert(before.composite?.revision);
    proof.before = {
      composite: before.composite.id,
      revision: before.composite.revision,
      preparation: before.composite.preparation,
      rollover: before.rollover,
    };
    const prior = new Set(
      (
        await request(`/market-data/center/tasks?dataset_id=${euro.id}`)
      ).items.map((t) => t.id),
    );
    const pinned = await request("/charts/data", {
      series_kind: "history",
      instrument: before.composite.revision.history_version_id,
      timeframe: "M1",
      limit: 20,
    });
    await page
      .locator(".data-managed-row")
      .filter({ hasText: "EURUSD" })
      .click();
    await page
      .getByRole("dialog", { name: "自建行情", exact: true })
      .getByRole("button", { name: "打开图表", exact: true })
      .click();
    await ready();
    await page.evaluate(async () => {
      const c = window.MW_TEST_WIDGET.activeChart();
      await c.setResolution("5");
      await c.createStudy("Moving Average", false, false, { length: 10 });
      c.createShape(
        { time: Math.floor(Date.now() / 1000) - 3600, price: 1.17 },
        { shape: "horizontal_line" },
      );
    });
    await ready();
    proof.chartBefore = await state();
    assert.equal(
      proof.chartBefore.symbol.toLowerCase(),
      "mwc:" + before.composite.id,
    );
    assert(proof.chartBefore.studies.length && proof.chartBefore.shapes.length);
    await shot(`rollover-${phase}-before`);
    check("Real licensed MWC chart loaded with M5, study and drawing");
    if (phase === "inspect") return;
    if (phase === "scheduled") {
      const desktopContext = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 1000 },
        serviceWorkers: "block",
        storageState: { cookies: await context.cookies(), origins: [] },
      });
      await desktopContext.route(/\/chart\.[a-f0-9]+\.js$/, instrument);
      await desktopContext.addInitScript(() => {
        window.MW_TEST_EVENTS = [];
      });
      desktop = await desktopContext.newPage();
      desktop.on("pageerror", (e) => proof.errors.push(e.message));
      const workspace = await request("/advanced-charts/workspaces", {
        name: "基线轮换隔离验收",
      });
      await desktop.goto(origin + "/advanced-charts/" + workspace.id);
      await expect
        .poll(
          () =>
            desktop.evaluate(() => {
              try {
                return Boolean(window.MW_TEST_WIDGET?.activeChart());
              } catch {
                return false;
              }
            }),
          { timeout: 60000 },
        )
        .toBe(true);
      await desktop.evaluate(async (ticker) => {
        const c = window.MW_TEST_WIDGET.activeChart();
        await c.setSymbol(ticker);
        await c.setResolution("5");
        await c.createStudy("Moving Average", false, false, { length: 10 });
        c.createShape(
          { time: Math.floor(Date.now() / 1000) - 3600, price: 1.17 },
          { shape: "horizontal_line" },
        );
      }, "MWC:" + before.composite.id);
      await ready(desktop);
      proof.desktopBefore = await state(desktop);
      await shot("rollover-scheduled-desktop-before", desktop);
    }
    const controls = await context.newPage();
    await controls.goto(origin + "/m/data");
    await controls
      .locator(".data-managed-row")
      .filter({ hasText: "EURUSD" })
      .click();
    const detail = controls.getByRole("dialog", {
      name: "自建行情",
      exact: true,
    });
    const started = Date.now();
    if (phase === "manual") {
      await detail
        .getByRole("button", { name: "立即更新", exact: true })
        .click();
      check("Immediate update submitted via actual mobile UI");
    } else {
      restorePlan = await request(
        `/market-data/datasets/${euro.id}/maintenance`,
      );
      const at = new Date(Date.now() + 65000);
      await detail
        .getByRole("button", { name: "维护设置", exact: true })
        .click();
      const editor = controls.getByRole("dialog", {
        name: "维护设置",
        exact: true,
      });
      await editor.getByLabel("维护时区", { exact: true }).fill("UTC");
      await editor
        .getByLabel("维护时间", { exact: true })
        .fill(at.toISOString().slice(11, 16));
      await editor
        .getByRole("button", { name: "保存维护设置", exact: true })
        .click();
      await expect(editor.getByText(/维护设置已保存/)).toBeVisible();
      check("Daily maintenance set shortly ahead via UI; host clock unchanged");
    }
    let latest;
    await expect
      .poll(
        async () => {
          latest = await live();
          if (latest.rollover?.status === "deferred")
            proof.lastDeferral = latest.rollover.reason;
          persist();
          return (
            latest.composite.revision.id !== before.composite.revision.id &&
            latest.rollover?.status === "updated"
          );
        },
        { timeout: 300000, intervals: [1000, 2000, 5000] },
      )
      .toBe(true);
    assert.equal(latest.enabled, true);
    assert(
      latest.composite.preparation.confirmed_end >=
        before.composite.preparation.confirmed_end,
    );
    assert.equal(latest.composite.id, before.composite.id);
    assert.equal(latest.default_mapping_id, before.default_mapping_id);
    assert(latest.composite.revision.seam >= before.composite.revision.seam);
    proof.after = {
      composite: latest.composite.id,
      revision: latest.composite.revision,
      preparation: latest.composite.preparation,
      rollover: latest.rollover,
      elapsedMs: Date.now() - started,
    };
    proof.newTasks = (
      await request(`/market-data/center/tasks?dataset_id=${euro.id}`)
    ).items
      .filter((t) => !prior.has(t.id))
      .map((t) => ({ id: t.id, status: t.status }));
    assert(proof.newTasks.some((t) => t.status === "published"));
    check(
      "Successful real maintenance automatically changed baseline; MWC, mapping and live switch retained",
    );
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window.MW_TEST_EVENTS.some((e) => e.type === "reset"),
          ),
        { timeout: 120000 },
      )
      .toBe(true);
    await ready();
    await expect
      .poll(
        () =>
          proof.history.some(
            (h) => h.revision === latest.composite.revision.id,
          ),
        { timeout: 120000 },
      )
      .toBe(true);
    proof.chartAfter = await state();
    assert.equal(proof.chartAfter.symbol, proof.chartBefore.symbol);
    assert.equal(proof.chartAfter.resolution, proof.chartBefore.resolution);
    assert.deepEqual(proof.chartAfter.studies, proof.chartBefore.studies);
    assert.deepEqual(proof.chartAfter.shapes, proof.chartBefore.shapes);
    for (const edge of ["from", "to"])
      assert(
        Math.abs(
          proof.chartAfter.visible[edge] - proof.chartBefore.visible[edge],
        ) <= 300,
        "Viewport moved more than one bar",
      );
    proof.events = await page.evaluate(() => window.MW_TEST_EVENTS);
    assert(
      proof.history.some(
        (h) => h.revision === latest.composite.revision.id && h.current,
      ),
      "Forming bar on new revision observed",
    );
    if (desktop) {
      await expect
        .poll(
          () =>
            desktop.evaluate(
              (revision) =>
                window.MW_TEST_EVENTS.some(
                  (e) => e.type === "reset" && e.revision === revision,
                ),
              latest.composite.revision.id,
            ),
          { timeout: 120000 },
        )
        .toBe(true);
      await ready(desktop);
      proof.desktopAfter = await state(desktop);
      for (const key of ["symbol", "resolution", "studies", "shapes"])
        assert.deepEqual(proof.desktopAfter[key], proof.desktopBefore[key]);
      for (const edge of ["from", "to"])
        assert(
          Math.abs(
            proof.desktopAfter.visible[edge] -
              proof.desktopBefore.visible[edge],
          ) <= 300,
        );
      proof.desktopEvents = await desktop.evaluate(() => window.MW_TEST_EVENTS);
      await shot("rollover-scheduled-desktop-after", desktop);
      check(
        "Desktop chart also retained symbol, period, viewport, drawing and study across the same real rotation",
      );
    }
    const pinnedAfter = await request("/charts/data", {
      series_kind: "history",
      instrument: before.composite.revision.history_version_id,
      timeframe: "M1",
      limit: 20,
    });
    assert.deepEqual(pinnedAfter.bars, pinned.bars);
    proof.fixedHistory = {
      version: before.composite.revision.history_version_id,
      count: pinned.bars.length,
      unchanged: true,
    };
    check(
      "Original chart accepted stream reset, retained viewport/timeframe/study/drawing and forming bar; MWH fixed history unchanged",
    );
    await shot(`rollover-${phase}-after`);
    assert.deepEqual(proof.errors, []);
  } finally {
    if (restorePlan) {
      const current = await request(
        `/market-data/datasets/${proof.dataset}/maintenance`,
      );
      await request(`/market-data/datasets/${proof.dataset}/maintenance`, {
        target_start: restorePlan.target_start,
        timeframes: restorePlan.timeframes,
        frequency: restorePlan.frequency,
        timezone: restorePlan.timezone,
        daily_minute: restorePlan.daily_minute,
        overlap_minutes: restorePlan.overlap_minutes,
        expected_configuration_revision: current.configuration_revision,
        frame_plan: restorePlan.frame_plan,
      });
    }
    persist();
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
