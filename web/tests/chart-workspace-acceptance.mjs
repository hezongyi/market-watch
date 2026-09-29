// Development-only mutation acceptance. Never point this at the production domain.
import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
const base = "http://127.0.0.1:5183";
const browser = await chromium.launch({
  executablePath:
    "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1550, height: 1000 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const names = [];
async function call(path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const session = await (await fetch("/api/session")).json();
      const r = await fetch("/api/charts" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, data: await r.json() };
    },
    { path, body },
  );
}
async function current() {
  const list = (await call("/workspaces")).data;
  return list.find((w) => w.id === page.url().split("/").at(-1));
}
async function waitSaved() {
  await expect(page.locator(".cw-save-state")).toHaveText("已保存", {
    timeout: 12000,
  });
}
try {
  await page.goto(base + "/chart-workspaces");
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
  page.on("dialog", async (d) => {
    if (d.type() === "prompt") await d.accept("图表验收 " + Date.now());
    else await d.accept();
  });
  await page.getByLabel("新建工作区", { exact: true }).click();
  await expect(page.locator(".cw-pane-title")).toHaveCount(1);
  await expect(page.locator(".cw-pane-title")).toContainText("H4");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.getByRole("button", { name: "M5", exact: true }).click();
  await page.waitForTimeout(2000);
  expect((await current()).document.panels[0].timeframe).toBe("M5");
  await page.getByLabel("图表布局").selectOption("2h");
  await page.waitForTimeout(1500);
  await waitSaved();
  const tools = [
    ["水平线", 1],
    ["趋势线", 2],
    ["射线", 2],
    ["矩形区域", 2],
    ["斐波那契回撤", 2],
    ["文字", 1],
    ["平行通道", 3],
    ["多空盈亏比", 3],
  ];
  for (const [name, n] of tools) {
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name, exact: true }).click();
    const box = await page.locator(".cw-canvas").first().boundingBox();
    for (let j = 0; j < n; j++) {
      await page.mouse.move(
        box.x + 140 + j * 110,
        box.y + 160 + (j === 1 ? 60 : j === 2 ? -65 : 0),
        { steps: 5 },
      );
      await page.waitForTimeout(120);
      await page.mouse.click(
        box.x + 140 + j * 110,
        box.y + 160 + (j === 1 ? 60 : j === 2 ? -65 : 0),
      );
      await page.waitForTimeout(150);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);
    const w = await current();
    const objects = w.document.drawings.XAUUSD || [];
    console.log(name, objects.length);
    expect(objects.length).toBe(names.length + 1);
    names.push(name);
  }
  await waitSaved();
  await page.getByLabel("画线对象列表", { exact: true }).click();
  for (const [name] of tools) {
    await page
      .locator(".cw-object-list")
      .getByRole("button", { name, exact: true })
      .click();
    const editor = page.getByRole("dialog", { name: "画线属性" });
    const first = editor.locator("input[type=number]").first();
    const price = Number(await first.inputValue());
    await editor.getByLabel("颜色", { exact: true }).fill("#ef4444");
    await editor.getByLabel("线宽", { exact: true }).selectOption("3");
    if (name === "多空盈亏比") {
      await editor.getByLabel("止损价格").fill(String(price + 10));
      await editor.getByLabel("止盈价格").fill(String(price - 20));
      await expect(editor.locator(".cw-rr")).toContainText("做空 · R/R 2.00");
    } else await first.fill(String(price + 0.01));
    if (name === "文字") await editor.getByLabel("标注文字").fill("回落观察");
    if (name === "斐波那契回撤") {
      await editor
        .getByLabel("回撤级别（逗号分隔）")
        .fill("0,0.382,0.5,0.618,1");
      await editor.getByLabel("回撤级别（逗号分隔）").press("Tab");
    }
    await editor.getByRole("button", { name: "应用", exact: true }).click();
    await waitSaved();
    const styled = (await current()).document.drawings.XAUUSD.find(
      (d) =>
        d.toolType ===
        {
          矩形区域: "Rectangle",
          平行通道: "ParallelChannel",
          多空盈亏比: "LongShortPosition",
        }[name],
    );
    if (styled) {
      const line =
        styled.options.rectangle?.border ||
        styled.options.channelLine ||
        styled.options.entryPtRectangle?.border;
      expect(line.width).toBe(3);
      expect(line.color).toBe("#ef4444");
    }
    await editor.getByRole("button", { name: "删除", exact: true }).click();
    await waitSaved();
    expect((await current()).document.drawings.XAUUSD).toHaveLength(7);
    await page.getByLabel("撤销", { exact: true }).click();
    await waitSaved();
    expect((await current()).document.drawings.XAUUSD).toHaveLength(8);
  }
  await page.getByLabel("关闭对象列表").click();
  let w = await current();
  const id = w.id,
    original = w.document.drawings.XAUUSD;
  expect(original).toHaveLength(8);
  await page.getByLabel("重做", { exact: true }).click();
  await waitSaved();
  expect((await current()).document.drawings.XAUUSD).toHaveLength(7);
  await page.getByLabel("撤销", { exact: true }).click();
  await waitSaved();
  expect((await current()).document.drawings.XAUUSD).toHaveLength(8);
  await page.reload();
  await page.locator(".cw-app").waitFor();
  await page.waitForTimeout(1800);
  expect((await current()).document.drawings.XAUUSD).toEqual(original);
  await page.getByRole("button", { name: "H4", exact: true }).click();
  await page.waitForTimeout(1700);
  await waitSaved();
  expect((await current()).document.drawings.XAUUSD).toEqual(original);
  for (const layout of ["3top", "3bottom", "4", "2v", "1", "2h"]) {
    await page.getByLabel("图表布局").selectOption(layout);
    await page.waitForTimeout(350);
    expect(await page.locator(".cw-pane").count()).toBe(
      { 1: 1, "2h": 2, "2v": 2, "3top": 3, "3bottom": 3, 4: 4 }[layout],
    );
  }
  await page.getByRole("button", { name: "指标", exact: true }).click();
  for (const name of [
    "SMA",
    "EMA",
    "LWMA",
    "BBANDS",
    "RSI",
    "MACD",
    "ATR",
    "STOCH",
  ]) {
    await page.getByLabel("新增指标类型").selectOption(name);
    await page.getByRole("button", { name: "添加指标", exact: true }).click();
    await page.waitForTimeout(100);
  }
  await page.getByRole("button", { name: "保存当前组合" }).click();
  await page.getByLabel("关闭设置").click();
  await page.waitForTimeout(3000);
  await waitSaved();
  expect((await current()).document.panels[0].indicators).toHaveLength(8);
  expect((await call("/templates")).data.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "M30", exact: true }).click();
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "W1", exact: true }).click();
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "MN", exact: true }).click();
  await page.waitForTimeout(2200);
  await waitSaved();
  await page.getByRole("button", { name: "M5", exact: true }).click();
  await page.waitForTimeout(2000);
  await page.getByLabel("图表布局").selectOption("3top");
  await page.waitForTimeout(1500);
  await waitSaved();
  for (const status of await page.locator(".cw-data-status").all())
    await expect(status).toContainText("BID", { timeout: 20000 });
  await page.screenshot({
    path: "artifacts/chart-acceptance-desktop.png",
    fullPage: true,
  });
  const beforeMobile = await current();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1200);
  await expect(page.locator(".cw-save-state")).toHaveText("只读查看");
  expect(await page.locator(".cw-tools").count()).toBe(0);
  await page.locator(".cw-mobile-tabs button").nth(1).click();
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "artifacts/chart-acceptance-mobile.png",
    fullPage: true,
  });
  expect((await current()).revision).toBe(beforeMobile.revision);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.setViewportSize({ width: 1550, height: 1000 });
  await page.getByLabel("复制工作区", { exact: true }).click();
  await page.waitForTimeout(1400);
  const copied = await current();
  expect(copied.id).not.toBe(id);
  expect(copied.document.drawings.XAUUSD[0].id).not.toBe(original[0].id);
  const changed = structuredClone(copied.document);
  changed.sync = !changed.sync;
  expect(
    (
      await call(`/workspaces/${copied.id}/save`, {
        name: copied.name,
        document: changed,
        revision: copied.revision,
      })
    ).status,
  ).toBe(200);
  await page.getByRole("button", { name: "同步", exact: true }).click();
  await page.waitForTimeout(1500);
  await expect(
    page.getByRole("button", { name: "将草稿另存副本" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  console.log("ACCEPTANCE PASS", names);
  fs.writeFileSync(
    "artifacts/chart-acceptance.json",
    JSON.stringify(
      { tools: names, errors, workspace: id, passed: true },
      null,
      2,
    ),
  );
} catch (e) {
  await page.screenshot({
    path: "artifacts/chart-acceptance-failed.png",
    fullPage: true,
  });
  console.log("BROWSER ERRORS", errors);
  console.log((await page.locator(".cw-app").innerText()).slice(-2500));
  throw e;
} finally {
  await browser.close();
}
