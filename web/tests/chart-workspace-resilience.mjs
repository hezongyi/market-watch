// Local development only: resilience, editing, synchronization and scale checks.
import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
const browser = await chromium.launch({
  executablePath:
    "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
    viewport: { width: 1550, height: 1000 },
  }),
  page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) =>
  d.accept(d.type() === "prompt" ? "稳定性验收 " + Date.now() : undefined),
);
async function api(path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const { csrf } = await (await fetch("/api/session")).json();
      const r = await fetch("/api/charts" + path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) throw Error(await r.text());
      return r.json();
    },
    { path, body },
  );
}
async function current() {
  return (await api("/workspaces")).find((w) => page.url().endsWith(w.id));
}
const saved = () =>
  expect(page.locator(".cw-save-state")).toHaveText("已保存", {
    timeout: 15000,
  });
try {
  await page.goto("http://127.0.0.1:5183/chart-workspaces");
  await page
    .getByLabel("管理员密码")
    .fill(
      JSON.parse(
        fs.readFileSync(
          "/home/quant/repos/market-watch/artifacts/local-credentials.json",
        ),
      ).password,
    );
  await page.getByRole("button", { name: "登录工作台" }).click();
  await page.locator(".cw-app").waitFor();
  await page.getByLabel("新建工作区", { exact: true }).click();
  await expect(page.locator(".cw-pane-title")).toHaveCount(1);
  await expect(page.locator(".cw-pane-title")).toContainText("H4");
  await page.getByRole("button", { name: "M5", exact: true }).click();
  await saved();
  await page.waitForTimeout(1800);
  let w = await current();
  const data = await api("/data", {
    instrument: "XAUUSD",
    timeframe: "M5",
    limit: 500,
    indicators: [],
  });
  expect(data.bars.length).toBeGreaterThan(100);
  const b = data.bars.at(-30),
    price = +b.close;
  const doc = w.document;
  doc.layout = "4";
  doc.panels = Array.from({ length: 4 }, (_, i) => ({
    ...structuredClone(doc.panels[0]),
    id: "scale-" + i,
    timeframe: "M5",
    indicators: ["SMA", "EMA", "RSI", "MACD"].map((name, j) => ({
      id: `ind-${i}-${j}`,
      name,
      version: "1",
      params: {},
    })),
  }));
  doc.drawings.XAUUSD = Array.from({ length: 100 }, (_, i) => ({
    id: "scale-line-" + i,
    toolType: "HorizontalLine",
    points: [{ timestamp: b.start / 1000, price: price + (i - 50) * 0.1 }],
    options: {
      line: { color: "#2962ff", width: 1, style: 0 },
      visible: true,
      editable: true,
    },
  }));
  await api(`/workspaces/${w.id}/save`, {
    name: w.name,
    revision: w.revision,
    document: doc,
  });
  const start = Date.now();
  await page.reload();
  await page.locator(".cw-pane").nth(3).waitFor();
  await expect(page.locator(".cw-data-status").first()).toContainText("BID", {
    timeout: 15000,
  });
  const loadMs = Date.now() - start;
  const box = await page.locator(".cw-canvas").first().boundingBox();
  await page.waitForTimeout(400);
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.8, {
    steps: 15,
  });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  await saved();
  w = await current();
  expect(w.document.panels[0].range).toBeTruthy();
  expect(
    w.document.panels.every(
      (p) =>
        JSON.stringify(p.range) === JSON.stringify(w.document.panels[0].range),
    ),
  ).toBe(true);
  const split = page.getByRole("separator", { name: "左右分隔线" });
  if (await split.count()) {
    await split.focus();
    await page.keyboard.press("ArrowRight");
    await saved();
    expect((await current()).document.splitX).toBeGreaterThan(0.5);
  }
  await page.getByLabel("图表1最大化").click();
  expect(await page.locator(".cw-pane:not(.cw-hidden)").count()).toBe(1);
  await page.getByLabel("图表1最大化").click();
  await page.getByRole("button", { name: "画线对象列表", exact: true }).click();
  await page
    .locator(".cw-object-list")
    .getByRole("button", { name: "水平线", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog", { name: "画线属性" });
  await editor.getByLabel("锚点1价格").fill(String(price + 10));
  await editor.getByRole("button", { name: "应用", exact: true }).click();
  await saved();
  expect((await current()).document.drawings.XAUUSD[0].points[0].price).toBe(
    price + 10,
  );
  await page.getByLabel("关闭画线属性").click();
  await page.getByLabel("切换画线可见性").first().click();
  await saved();
  expect((await current()).document.drawings.XAUUSD[0].options.visible).toBe(
    false,
  );
  await page.getByLabel("切换画线锁定").first().click();
  await saved();
  expect((await current()).document.drawings.XAUUSD[0].options.editable).toBe(
    false,
  );
  await page.getByLabel("关闭画线属性").click();
  await page.getByLabel("删除画线", { exact: true }).first().click();
  await saved();
  expect((await current()).document.drawings.XAUUSD.length).toBe(99);
  await page.getByLabel("撤销", { exact: true }).click();
  await saved();
  expect((await current()).document.drawings.XAUUSD.length).toBe(100);
  await page.getByLabel("关闭对象列表").click();
  const before = (await current()).document.sync;
  await context.setOffline(true);
  await page.getByRole("button", { name: "同步", exact: true }).click();
  await expect(page.locator(".cw-save-state")).toHaveText("保存失败", {
    timeout: 15000,
  });
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).some((k) =>
        k.startsWith("market-watch-chart-draft:"),
      ),
    ),
  ).toBe(true);
  await context.setOffline(false);
  await saved();
  expect((await current()).document.sync).toBe(!before);
  await page.screenshot({
    path: "artifacts/chart-scale-100.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  fs.writeFileSync(
    "artifacts/chart-resilience.json",
    JSON.stringify(
      { passed: true, drawings: 100, panels: 4, loadMs, errors },
      null,
      2,
    ),
  );
  console.log("RESILIENCE PASS", loadMs);
} catch (e) {
  await page.screenshot({
    path: "artifacts/chart-resilience-failed.png",
    fullPage: true,
  });
  throw e;
} finally {
  await browser.close();
}
