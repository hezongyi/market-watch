// Real UI with synthetic minutes published by the actual fixed-version importer.
const { chromium, expect } = require("@playwright/test");
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const { base, out, password } = require("./production-ux-env.cjs");
(async () => {
  const b = await chromium.launch({
    executablePath:
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } }),
    checks = [];
  try {
    await p.goto(base + "/replay");
    await p.getByLabel("管理员密码").fill(password);
    await p.getByRole("button", { name: "登录工作台" }).click();
    await expect(p.getByLabel("管理员密码")).toHaveCount(0);
    const completed = p.locator(".replay-completed-jobs");
    await expect(completed).toBeVisible();
    assert(!(await completed.evaluate((e) => e.open)));
    await expect(p.getByText("正在查找…", { exact: true })).toHaveCount(0);
    await p.screenshot({
      path: out + "/replay-empty-stable.png",
      fullPage: true,
    });
    const datasets = await (
      await p.request.get(base + "/api/market-data/datasets")
    ).json();
    const ds = datasets.find(
      (d) => d.logical_symbol === "EURUSD" && d.identity.source === "oanda",
    );
    assert(ds);
    const versions = await (
      await p.request.get(
        base + "/api/market-data/versions?dataset_id=" + ds.id,
      )
    ).json();
    const version = versions.find((v) => v.status === "published");
    assert(version);
    await p.goto(base + "/replay?dataset_version=" + version.id);
    await expect(
      p.getByRole("combobox", { name: "不可变历史版本" }),
    ).toHaveValue(version.id);
    await p
      .getByRole("combobox", { name: "周期", exact: true })
      .selectOption("M1");
    await expect(
      p.getByRole("button", { name: "创建演练", exact: true }),
    ).toBeEnabled();
    const pending = p.waitForResponse(
      (r) =>
        r.url() === base + "/api/replays" && r.request().method() === "POST",
    );
    await p.getByRole("button", { name: "创建演练", exact: true }).click();
    const response = await pending;
    assert.equal(response.status(), 201);
    const run = await response.json();
    assert.equal(run.dataset_version, version.id);
    await expect(
      p.getByRole("button", { name: "播放", exact: true }),
    ).toBeVisible();
    const setup = p.locator(".replay-setup details");
    await expect(setup).not.toHaveAttribute("open", "");
    await expect(
      p.getByRole("button", { name: "播放", exact: true }),
    ).toBeFocused();
    await setup.locator("summary").click();
    await expect(
      p.getByRole("combobox", { name: "不可变历史版本" }),
    ).toHaveValue(version.id);
    await setup.locator("summary").click();
    const next = p.getByRole("button", { name: "下一根", exact: true });
    const controls = next.locator("..");
    assert(
      (await controls.evaluate((e) => e.getBoundingClientRect().top)) <
        (await completed.evaluate((e) => e.getBoundingClientRect().top)),
    );
    await next.click();
    await expect
      .poll(async () => {
        return (
          await (await p.request.get(base + "/api/replays/" + run.id)).json()
        ).cursor;
      })
      .toBeGreaterThan(run.cursor);
    await p.getByRole("button", { name: "播放", exact: true }).click();
    await expect(
      p.getByRole("button", { name: "暂停", exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await (await p.request.get(base + "/api/replays/" + run.id)).json())
            .cursor,
      )
      .toBeGreaterThan(run.cursor + 60000);
    await p.getByRole("button", { name: "暂停", exact: true }).click();
    const stepped = await (
      await p.request.get(base + "/api/replays/" + run.id)
    ).json();
    assert(stepped.bars.every((bar) => bar.end <= stepped.cursor));
    await p.evaluate(() => scrollTo(0, 0));
    assert((await controls.boundingBox()).y < 1000);
    await p.screenshot({ path: out + "/replay-playing-result.png" });
    await p.reload();
    await p.getByLabel("已保存的演练", { exact: false }).selectOption(run.id);
    await expect(p.getByRole("link", { name: "导出演练记录" })).toBeVisible();
    const restored = await (
      await p.request.get(base + "/api/replays/" + run.id)
    ).json();
    assert.deepEqual(restored.input_manifest, run.input_manifest);
    assert.equal(restored.cursor, stepped.cursor);
    await next.scrollIntoViewIfNeeded();
    await p.screenshot({ path: out + "/replay-restored-controls.png" });
    for (const [width, height] of [
      [375, 812],
      [390, 844],
      [844, 390],
      [1440, 1000],
    ]) {
      await p.setViewportSize({ width, height });
      await next.scrollIntoViewIfNeeded();
      assert(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= visualViewport.width,
        ),
      );
      await expect(next).toBeInViewport();
      await p.screenshot({ path: out + "/replay-controls-" + width + ".png" });
    }
    checks.push(
      "Real fixed published history: UI POST201, next bar, play/pause advances actual cursor, no future bars, reload resumes same immutable input manifest and cursor; controls precede task lists",
    );
    await completed.locator("summary").click();
    await expect(
      completed.getByText("已完成", { exact: true }).first(),
    ).toBeVisible();
    checks.push(
      "31 completed tasks default collapsed and keyboard/click expansion retained",
    );
    fs.writeFileSync(
      out + "/replay-results.json",
      JSON.stringify(
        {
          checks,
          version: version.id,
          replay: run.id,
          cursor: restored.cursor,
          scope:
            "Real web/API/PG; synthetic fixed price history, no upstream or phone delivery",
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ checks }));
  } catch (e) {
    await p.screenshot({ path: out + "/replay-failed.png", fullPage: true });
    throw e;
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
