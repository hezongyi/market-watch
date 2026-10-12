// Runs the built application with deterministic API fixtures, without a server.
// Real persistence and worker validation belong to the separate Docker check.
const { chromium, expect: baseExpect } = require("@playwright/test");
const expect = baseExpect.configure({ timeout: 1000 });
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const artifacts = path.resolve(
  process.env.TEST_ARTIFACT_DIR ||
    path.join(root, "../artifacts/home-watch-ux"),
);
fs.mkdirSync(artifacts, { recursive: true });
const longId = "MD:91e50d2d6c647d4b4bdd5c127:XAUUSD";
const instruments = [
  {
    id: "XAUUSD",
    label: "黄金 / 美元",
    symbol: "XAUUSD",
    source: "dukascopy",
    basis: "bid",
    calendar: "ny17",
    precision: 2,
  },
  {
    id: "EURUSD",
    label: "欧元 / 美元",
    symbol: "EURUSD",
    source: "dukascopy",
    basis: "bid",
    calendar: "ny17",
    precision: 5,
  },
  {
    id: "BTCUSDT",
    label: "比特币 / 泰达币",
    symbol: "BTCUSDT",
    source: "binance",
    basis: "last",
    calendar: "utc0",
    precision: 2,
  },
  {
    id: longId,
    label: "黄金 / 美元 · OANDA practice",
    symbol: "XAU_USD",
    logical_symbol: "XAUUSD",
    source: "oanda",
    basis: "bid",
    calendar: "ny17",
    precision: 2,
    dataset_identity: {
      source: "oanda",
      channel: "rest",
      environment: "practice",
      account_scope: "sha256:" + "a".repeat(64),
      provider_symbol: "XAU_USD",
      basis: "bid",
      calendar_version: "ny17-fixture-v1",
    },
  },
  {
    id: "MD:1111111111111111111111111:EURUSD",
    label: "欧元 / 美元 · 自建",
    symbol: "EURUSD",
    logical_symbol: "EURUSD",
    source: "dukascopy",
    basis: "bid",
    calendar: "ny17",
    precision: 5,
    dataset_identity: {
      source: "dukascopy",
      channel: "python",
      environment: "historical",
      account_scope: "public",
      provider_symbol: "EURUSD",
      basis: "bid",
      calendar_version: "ny17-fixture-v1",
    },
  },
  {
    id: "CUSTOM:LONG_ID_12345678901234567890",
    label: "自定义来源的很长品种名称_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    symbol: "CUSTOM_LONG_SYMBOL_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    source: "custom",
    basis: "last",
    calendar: "utc0",
    precision: 2,
  },
].map((row) => ({
  ...row,
  quality: "waiting",
  price: null,
  price_at: null,
  error: null,
}));
const composite = {
  id: "composite-fixture",
  ticker: "MWC:composite-fixture",
  symbol: "XAUUSD",
  display_symbol: "黄金组合",
  series_kind: "composite",
  dataset_id: "dataset-fixture",
  historical_source: "dukascopy",
  basis: "bid",
  calendar: "ny17",
  description: "fixture",
  created: true,
};
const failures = [],
  checks = [],
  submissions = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => checks.push(name))
    .catch((error) => failures.push({ name, error: String(error) }));
}
async function visibleBounds(locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = await locator
    .page()
    .evaluate(() => ({
      left: visualViewport.offsetLeft,
      top: visualViewport.offsetTop,
      width: visualViewport.width,
      height: visualViewport.height,
    }));
  assert(
    box.x >= viewport.left - 1 &&
      box.y >= viewport.top - 1 &&
      box.x + box.width <= viewport.left + viewport.width + 1 &&
      box.y + box.height <= viewport.top + viewport.height + 1,
    JSON.stringify({ box, viewport }),
  );
  return { box, viewport };
}
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  try {
    for (const [width, height, mobile] of [
      [375, 812, true],
      [390, 844, true],
      [844, 390, true],
      [1440, 1000, false],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [],
        writes = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await context.route("http://market-watch.test/**", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.pathname.startsWith("/api/")) {
          const endpoint = url.pathname.slice(4);
          let result =
            endpoint === "/session"
              ? { csrf: "fixture" }
              : endpoint === "/instruments"
                ? instruments
                : endpoint === "/health"
                  ? {}
                  : endpoint === "/session-range"
                    ? { complete: false }
                    : [];
          if (endpoint === "/market-data/series/page")
            result = { items: [composite], next_offset: null };
          if (endpoint === "/market-data/center/composite-candidates")
            result = { items: [], total: 0 };
          if (endpoint === "/events")
            return route.fulfill({
              status: 200,
              contentType: "text/event-stream",
              body: ": fixture\n\n",
            });
          if (request.method() === "POST") {
            writes.push(endpoint);
            if (endpoint === "/watches") {
              submissions.push(request.postDataJSON());
              result = { id: "fixture-watch" };
            }
          }
          return route.fulfill({
            status:
              endpoint === "/watches" && request.method() === "POST"
                ? 201
                : 200,
            contentType: "application/json",
            body: JSON.stringify(result),
          });
        }
        const file = path.join(
          root,
          "dist",
          url.pathname === "/" ? "index.html" : url.pathname,
        );
        if (!file.startsWith(path.join(root, "dist") + path.sep))
          throw new Error("Invalid fixture asset");
        const mime = file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html";
        return route.fulfill({
          status: 200,
          contentType: mime,
          body: fs.readFileSync(file),
        });
      });
      await page.goto("http://market-watch.test/");
      const trigger = page.getByRole("button", {
        name: "新建预警",
        exact: true,
      });
      await expect(page.locator(".market-card")).toHaveCount(
        instruments.length,
      );
      const gold = page.locator(".market-card").nth(3);
      await check(
        `${width}: layout fits visual viewport with long identifiers`,
        async () =>
          assert(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth <=
                  visualViewport.width + 1 &&
                innerWidth <= visualViewport.width + 1,
            ),
          ),
      );
      await check(
        `${width}: readable gold identity and correct icon`,
        async () => {
          await expect(gold.locator("strong")).toHaveText("XAUUSD");
          await expect(gold.locator(".instrument-icon")).toHaveText("Au");
          await expect(gold).toContainText("OANDA");
          await expect(gold).toContainText("practice");
          await expect(gold).toContainText("Bid");
        },
      );
      // Stress the layout independently of the title formatting fix.
      await gold
        .locator("strong")
        .evaluate((element, value) => (element.textContent = value), longId);
      await check(
        `${width}: arbitrary long title remains contained`,
        async () =>
          assert(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth <=
                visualViewport.width + 1,
            ),
          ),
      );
      await gold.click();
      await trigger.click();
      const dialog = page.locator("dialog");
      await expect(dialog).toBeVisible();
      await check(
        `${width}: named dialog`,
        async () =>
          await expect(
            page.getByRole("dialog", { name: "设置一条预警" }),
          ).toBeVisible(),
      );
      await check(
        `${width}: dialog and close fit visual viewport`,
        async () => {
          await visibleBounds(dialog);
          await visibleBounds(
            dialog.getByRole("button", { name: "关闭", exact: true }),
          );
        },
      );
      await dialog
        .getByRole("combobox", { name: "行情输入", exact: true })
        .selectOption("legacy");
      await dialog
        .getByRole("combobox", { name: "策略", exact: true })
        .selectOption("price");
      await dialog
        .getByLabel("预警名称", { exact: true })
        .fill(`UX fixture ${width}`);
      await dialog.getByLabel("目标价格", { exact: true }).fill("999999");
      await dialog.evaluate(
        (element) => (element.scrollTop = element.scrollHeight),
      );
      await check(
        `${width}: cancel and submit fit visual viewport after scroll`,
        async () => {
          await visibleBounds(
            dialog.getByRole("button", { name: "取消", exact: true }),
          );
          await visibleBounds(
            dialog.getByRole("button", { name: "开启监控", exact: true }),
          );
        },
      );
      await page.screenshot({
        path: path.join(artifacts, `watch-${width}.png`),
      });
      if (process.env.UX_REPRO_ONLY === "1") {
        await page.keyboard.press("Escape");
        await check(
          `${width}: escape restores trigger focus`,
          async () => await expect(trigger).toBeFocused(),
        );
        await context.close();
        continue;
      }
      if (mobile)
        await dialog.getByRole("button", { name: "取消", exact: true }).tap();
      else
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await check(
        `${width}: cancel restores trigger focus`,
        async () => await expect(trigger).toBeFocused(),
      );
      for (const opener of ["click", "Enter", "Space"]) {
        for (const closer of ["Escape", "取消", "关闭"]) {
          await trigger.focus();
          if (opener === "click") await trigger.click();
          else await page.keyboard.press(opener);
          await expect(dialog).toBeVisible();
          await page.keyboard.press("Tab");
          await check(
            `${width}: focus contained ${opener}/${closer}`,
            async () =>
              assert(
                await page.evaluate(
                  () => !!document.activeElement.closest("dialog"),
                ),
              ),
          );
          if (closer === "Escape") await page.keyboard.press("Escape");
          else
            await dialog
              .getByRole("button", { name: closer, exact: true })
              .click();
          await expect(dialog).not.toBeVisible();
          await check(
            `${width}: focus restored ${opener}/${closer}`,
            async () => await expect(trigger).toBeFocused(),
          );
        }
      }
      const emptyTrigger = page.getByRole("button", { name: "创建第一条预警" });
      await emptyTrigger.click();
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await check(
        `${width}: empty-state trigger focus restored`,
        async () => await expect(emptyTrigger).toBeFocused(),
      );
      await trigger.click();
      await dialog
        .getByRole("combobox", { name: "行情输入", exact: true })
        .selectOption("legacy");
      await dialog
        .getByRole("combobox", { name: "策略", exact: true })
        .selectOption("price");
      await dialog.getByLabel("目标价格", { exact: true }).fill("999999");
      await dialog
        .getByRole("button", { name: "开启监控", exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      await check(`${width}: save retains original instrument binding`, () =>
        assert.equal(submissions.at(-1).instrument_id, longId),
      );
      await check(
        `${width}: default name is readable and keeps separate source binding`,
        () => assert.equal(submissions.at(-1).name, "XAUUSD · 价格穿越"),
      );
      const btc = page.locator(".market-card").nth(2);
      await btc.click();
      await page.getByRole("button", { name: "M5", exact: true }).click();
      await trigger.click();
      await expect(
        dialog.getByRole("combobox", { name: "确认周期", exact: true }),
      ).toHaveValue("M5");
      await expect(dialog.getByText(/当前看盘：BTCUSDT/)).toBeVisible();
      await expect(
        dialog.getByRole("combobox", { name: "行情输入", exact: true }),
      ).toHaveValue("composite");
      await expect(
        dialog.getByRole("button", { name: "开启监控", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      checks.push(
        `${width}: S-01 carries M5 context and explains explicit composite selection without guessing binding`,
      );
      await check(`${width}: no page errors`, () =>
        assert.deepEqual(errors, []),
      );
      assert.deepEqual(writes, ["/watches"]);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(
    path.join(artifacts, "results.json"),
    JSON.stringify(
      {
        checks,
        failures,
        scope: "Built UI with fixture API; not database integration",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ checks: checks.length, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
