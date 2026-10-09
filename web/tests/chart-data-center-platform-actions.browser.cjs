// Supplementary platform actions: real directory, no form submissions or chart changes.
const fs = require("node:fs"),
  path = require("node:path"),
  { expect } = require("@playwright/test"),
  f = require("./chart-data-center-fixture.cjs");
const out = path.join(f.root, "artifacts/platform-market-ui");
fs.mkdirSync(out, { recursive: true });
(async () => {
  const b = await f.launch(),
    p = await b.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    { host, native, center } = f.frames(p),
    dc = () => native().locator(".dc-window");
  const report = {
    environment:
      "Ubuntu isolated Docker; deployed assets; real catalog; no form submits",
    passed: false,
    checks: [],
    errors: [],
  };
  p.on("pageerror", (e) => report.errors.push(e.message));
  const record = (name) => {
    report.checks.push({ name });
    console.log("PASS", name);
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
    await p.goto(f.base + "/advanced-charts");
    await f.login(p);
    await expect.poll(() => !!native(), { timeout: 30000 }).toBe(true);
    await host().waitForFunction(() => ready && dataCenter, null, {
      timeout: 60000,
    });
    await open(
      "/market-data?tab=platform&source=oanda&asset_class=forex&query=EURUSD",
    );
    const rows = dc().locator("[data-name=symbol-search-dialog-content-item]");
    await expect(rows.first()).toBeVisible();
    await rows.first().getByRole("button", { name: "详情" }).click();
    await dc().getByRole("link", { name: "配置原生参数", exact: true }).click();
    await expect(
      dc().getByRole("heading", { name: "配置原生行情" }),
    ).toBeVisible();
    await expect(
      dc().getByRole("button", { name: "价格口径", exact: true }),
    ).toBeEnabled({ timeout: 15000 });
    await dc().getByRole("link", { name: "返回平台行情", exact: true }).click();
    await expect(rows.first()).toBeVisible();
    await expect(
      dc().getByRole("searchbox", { name: "搜索品种", exact: true }),
    ).toHaveValue("EURUSD");
    record(
      "OANDA row details enter native parameter configuration and return to original filters/row without saving",
    );
    await close();
    await open(
      "/market-data?tab=platform&source=dukascopy&asset_class=forex&query=EURUSD",
    );
    await expect(rows).toHaveCount(1);
    await rows.getByRole("button", { name: "详情" }).click();
    await dc()
      .getByRole("link", { name: "添加为自建行情", exact: true })
      .click();
    await expect(
      dc().getByRole("heading", { name: "添加自建行情" }),
    ).toBeVisible();
    await expect(dc().getByLabel("准确来源代码", { exact: true })).toHaveValue(
      "EUR/USD",
    );
    await dc().getByRole("link", { name: "取消", exact: true }).click();
    if (await dc().getByRole("button", { name: "放弃修改" }).count())
      await dc().getByRole("button", { name: "放弃修改" }).click();
    await expect(rows).toHaveCount(1);
    await expect(
      dc().getByRole("searchbox", { name: "搜索品种", exact: true }),
    ).toHaveValue("EURUSD");
    record(
      "Dukascopy row details fill create form and cancel returns to original platform row; no mutation",
    );
    await close();
    await native().evaluate(() => {
      const original = MWNativeCenter.mount;
      window.extraMount = original;
      window.extraApplies = [];
      MWNativeCenter.mount = (node, o) => {
        window.extraPost = o.post;
        return original(node, {
          ...o,
          post: (m) => {
            if (m.type === "apply") extraApplies.push(m);
            else o.post(m);
          },
        });
      };
    });
    await open("/market-data?tab=platform&source=yahoo&query=MSFT");
    await expect(rows).toHaveCount(1);
    await dc()
      .getByRole("searchbox", { name: "搜索品种", exact: true })
      .focus();
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("Enter");
    await expect
      .poll(() => native().evaluate(() => extraApplies.length))
      .toBe(1);
    const held = await native().evaluate(() => extraApplies[0]);
    expect(held.ticker.startsWith("MWP:YAHOO:")).toBe(true);
    await native().evaluate(() =>
      extraPost({ ...extraApplies[0], target: "invalid-target" }),
    );
    await expect(dc().locator(".dc-platform > [role=alert]")).toContainText(
      "目标图格",
    );
    await close();
    record(
      "ArrowDown/Enter submits only the selected platform ticker through target guard",
    );
    await p.reload();
    await expect.poll(() => !!native(), { timeout: 30000 }).toBe(true);
    await host().waitForFunction(() => ready && dataCenter, null, {
      timeout: 60000,
    });
    await host().evaluate(() => {
      TradingView.version = () => "incompatible-extra-test";
    });
    await native()
      .getByRole("button", { name: "数据中心", exact: true })
      .click();
    await expect.poll(() => !!center(), { timeout: 30000 }).toBe(true);
    await center()
      .getByRole("button", { name: "平台行情", exact: true })
      .click();
    await center()
      .getByRole("combobox", { name: "来源", exact: true })
      .selectOption("yahoo");
    const input = center().getByRole("searchbox", {
      name: "搜索品种",
      exact: true,
    });
    await input.fill("MSFT");
    await expect(input).toBeFocused();
    await expect(center().locator(".dc-platform-fallback-row")).toHaveCount(1);
    await expect(center().locator(".dc-platform-fallback-row")).toContainText(
      "微软",
    );
    await expect(
      center().getByRole("navigation", { name: "列表分页" }),
    ).toHaveCount(0);
    await center()
      .getByRole("button", { name: "关闭数据中心", exact: true })
      .click();
    record(
      "version fallback keeps native-like continuous workflow, real Yahoo filtering and typing focus",
    );
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (e) {
    report.errors.push(e.message);
    await p.screenshot({ path: path.join(out, "supplement-failed.png") });
    throw e;
  } finally {
    fs.writeFileSync(
      path.join(out, "supplement-report.json"),
      JSON.stringify(report, null, 2),
    );
    await b.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
