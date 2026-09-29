import { chromium } from "@playwright/test";
import fs from "node:fs";
const browser = await chromium.launch({
  executablePath:
    "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1550, height: 1050 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => {
  if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
});
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
page.on("dialog", async (d) => {
  if (d.type() === "prompt") await d.accept("验收工作区");
  else await d.accept();
});
await page.getByRole("button", { name: "新建工作区", exact: true }).click();
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "M5", exact: true }).click();
await page.waitForTimeout(2500);
await page.getByLabel("图表布局").selectOption("2h");
await page.waitForTimeout(2500);
await page.getByRole("button", { name: "指标", exact: true }).click();
await page.getByRole("button", { name: "添加指标", exact: true }).click();
await page.waitForTimeout(1500);
await page.getByLabel("新增指标类型").selectOption("RSI");
await page.getByRole("button", { name: "添加指标", exact: true }).click();
await page.getByLabel("关闭设置").click();
await page.waitForTimeout(2500);
await page.screenshot({
  path: "artifacts/workspace-first.png",
  fullPage: true,
});
console.log("errors", errors);
console.log("text", (await page.locator(".cw-app").innerText()).slice(0, 2300));
await browser.close();
