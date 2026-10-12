const { chromium, expect } = require("@playwright/test");
const esbuild = require("esbuild"),
  fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const catalog = JSON.parse(
  execFileSync(
    path.join(root, ".venv/bin/python"),
    [
      "-c",
      "import json; from alerts.chart_indicators import public_catalog; print(json.dumps(public_catalog()))",
    ],
    {
      cwd: root,
      env: { ...process.env, PYTHONPATH: path.join(root, "backend") },
    },
  ),
);
const artifacts = path.resolve(
  process.env.TEST_ARTIFACT_DIR || path.join(root, "artifacts/ux-panels"),
);
fs.mkdirSync(artifacts, { recursive: true });
(async () => {
  const build = await esbuild.build({
    entryPoints: [path.join(__dirname, "fixtures/ux-panels.tsx")],
    bundle: true,
    write: false,
    outdir: "out",
    format: "iife",
  });
  const js = build.outputFiles.find((file) => file.path.endsWith(".js")).text,
    css = build.outputFiles.find((file) => file.path.endsWith(".css")).text;
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [],
    writes = [],
    checks = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://market-watch.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/ui.js")
      return route.fulfill({ contentType: "text/javascript", body: js });
    if (url.pathname === "/ui.css")
      return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname.startsWith("/api/")) {
      if (route.request().method() === "POST") writes.push(url.pathname);
      const result = url.pathname.endsWith("/capabilities")
        ? {
            sources: [
              {
                source: "dukascopy",
                series_kind: "managed",
                available: true,
                basis: "bid",
                calendar: "ny17",
              },
            ],
            modes: ["close", "intrabar"],
            indicators: ["MACD"],
            indicator_metadata: catalog,
          }
        : {
            items: ["registered", "catalog"].map((kind) => ({
              row_id: kind,
              source: "binance",
              version: "binance-pending-v1",
              scope: "当前来源 BTCUSDT",
              timezone: "UTC",
              regular_hours: "未核实",
              status: "unverified",
              checked_at: null,
              mappings: ["BTCUSDT"],
              evidence: ["https://example.test"],
              target_kind: kind,
              target_id: kind === "registered" ? "BTCUSDT" : "catalog:BTCUSDT",
              identity: {
                channel: "rest",
                environment: "public",
                account_scope: "public",
                price_basis: "last",
              },
              coverage_note: "无适用证据的部分保持未核实。",
            })),
            sources: ["binance"],
            review_due: 2,
          };
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(result),
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script src="/ui.js"></script></body></html>',
    });
  });
  try {
    await page.goto("http://market-watch.test/?mode=calendar");
    const rows = page.locator(".dc-calendar-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator("summary")).toContainText("已登记品种");
    await expect(rows.nth(1).locator("summary")).toContainText("来源目录");
    for (const row of await rows.all()) {
      await row.locator("summary").click();
      await expect(row).toContainText("每个适用对象独立审核");
      await expect(row).toContainText("未核实");
    }
    await expect(page.getByText(/待核实适用对象 2/)).toBeVisible();
    await page.screenshot({
      path: path.join(artifacts, "calendar-targets.png"),
    });
    checks.push(
      "UX-05: duplicate rules expose target kind, use and independent pending reviews",
    );
    await page.goto("http://market-watch.test/?mode=alert");
    const fast = page.getByLabel("快线周期", { exact: true }),
      slow = page.getByLabel("慢线周期", { exact: true }),
      signal = page.getByLabel("信号周期", { exact: true });
    await expect(fast).toHaveValue("12");
    await expect(slow).toHaveValue("26");
    await expect(signal).toHaveValue("9");
    await expect(
      page.getByLabel("输出", { exact: true }).locator('option[value="macd"]'),
    ).toHaveText("MACD 线");
    await expect(page.getByText(/保存后独立于图表参数/)).toBeVisible();
    await fast.fill("19");
    await expect
      .poll(() =>
        page.evaluate(() => window.draft.condition.left.indicator.params.fast),
      )
      .toBe(19);
    assert.deepEqual(
      await page.evaluate(() => window.draft.condition.left.indicator.params),
      { fast: 19, slow: 26, signal: 9 },
    );
    await page.getByLabel("输出", { exact: true }).selectOption("histogram");
    await expect
      .poll(() =>
        page.evaluate(() => window.draft.condition.left.indicator.output),
      )
      .toBe("histogram");
    await page.screenshot({
      path: path.join(artifacts, "indicator-alert-labels.png"),
    });
    checks.push(
      "UX-03: metadata parameter/output labels preserve numerical values and snapshot keys",
    );
    await page.goto("http://market-watch.test/?mode=replay");
    const completed = page.locator(".replay-completed-jobs");
    await expect(completed).not.toHaveAttribute("open", "");
    await expect(page.getByText("已完成", { exact: true })).not.toBeVisible();
    await expect(page.getByText("获取中", { exact: true })).toBeVisible();
    await expect(page.getByText("待核查", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "从断点重试" }).click();
    assert.equal(await page.evaluate(() => window.retried), "failed");
    await completed.locator("summary").click();
    await expect(page.getByText("已完成", { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(artifacts, "replay-task-records.png"),
    });
    checks.push(
      "S-03: completed tasks collapse, active/failed/review tasks and retry stay accessible",
    );
    assert.deepEqual(errors, []);
    assert(writes.every((url) => url.endsWith("/capabilities")));
    fs.writeFileSync(
      path.join(artifacts, "results.json"),
      JSON.stringify(
        {
          checks,
          errors,
          scope:
            "Actual components with fixture API; not native vendor or persistence validation",
        },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify({ checks, errors }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
