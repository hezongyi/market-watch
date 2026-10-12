// Task-owned Ubuntu Docker only; see docs/production-ux-fixes-20261012.md.
const { chromium, expect } = require("@playwright/test");
const fs = require("fs"),
  assert = require("assert/strict");
(async () => {
  const b = await chromium.launch({
    executablePath:
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await p.goto("http://127.0.0.1:19971/replay");
    await p
      .getByLabel("管理员密码")
      .fill(
        fs.readFileSync(
          "/tmp/mw-production-ux-20261012-private/password",
          "utf8",
        ),
      );
    await p.getByRole("button", { name: "登录工作台" }).click();
    const completed = p.locator(".replay-completed-jobs");
    await expect(completed).toBeVisible();
    assert(!(await completed.evaluate((e) => e.open)));
    const result = p.getByRole("heading", { name: "选择一段行情，开始演练" });
    await expect(result).toBeVisible();
    assert(
      (await result.evaluate((e) => e.getBoundingClientRect().top)) <
        (await completed.evaluate((e) => e.getBoundingClientRect().top)),
    );
    await expect(p.getByRole("button", { name: "从断点重试" })).toBeVisible();
    const at = await result.boundingBox();
    await p.screenshot({
      path:
        require("node:path").resolve(
          __dirname,
          "../../artifacts/production-ux-real/",
        ) + "/replay-result-priority.png",
      fullPage: true,
    });
    await completed.locator("summary").click();
    await expect(
      completed.getByText("已完成", { exact: true }).first(),
    ).toBeVisible();
    fs.writeFileSync(
      require("node:path").resolve(
        __dirname,
        "../../artifacts/production-ux-real/",
      ) + "/replay-results.json",
      JSON.stringify(
        {
          checks: [
            "Actual 31 completed and one failed database tasks: completed default collapsed, failure retry visible, replay result precedes task sections",
          ],
          resultPosition: at,
        },
        null,
        2,
      ),
    );
    console.log("Replay task placement verified");
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
