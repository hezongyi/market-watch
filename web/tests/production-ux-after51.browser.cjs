// Combined PR #50/#51 acceptance against a new, isolated Ubuntu Docker task.
const { chromium, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { base, origin, out, password } = require("./production-ux-env.cjs");
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [],
    checks = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const name = "Ubuntu UX integrated " + Date.now();
  try {
    await page.goto(base + "/advanced-charts");
    await page.getByLabel("管理员密码").fill(password);
    await page.getByRole("button", { name: "登录工作台" }).click();
    await expect(page.getByLabel("管理员密码")).toHaveCount(0);
    async function frame() {
      await expect
        .poll(
          () => page.frames().some((f) => f.url().startsWith(origin + "/?")),
          { timeout: 30000 },
        )
        .toBe(true);
      const h = page.frames().find((f) => f.url().startsWith(origin + "/?"));
      await h.waitForFunction(
        () => ready && !loading && widget.activeChart().dataReady(),
        null,
        { timeout: 60000 },
      );
      return h;
    }
    let h = await frame(),
      ui = h.childFrames()[0];
    const ids = await h.evaluate(async () => {
      const c = widget.activeChart();
      for (const s of c.getAllStudies()) c.removeEntity(s.id);
      const macd = await c.createStudy("守望 Python MACD", false, false, {
        fast: 19,
        slow: 35,
        signal: 11,
      });
      const swing = await c.createStudy(
        "守望 Python SWING_SR_V1",
        false,
        false,
        { high_strength: 3, low_strength: 7 },
      );
      return { macd, swing };
    });
    await h.waitForFunction(
      () =>
        document
          .querySelector(".mw-swing-row")
          ?.textContent.includes("Swing 3 7"),
      null,
      { timeout: 60000 },
    );
    const definitions = await h.evaluate(() => ({
      macd: widget.getStudyInputs("守望 Python MACD"),
      swing: widget.getStudyInputs("守望 Python SWING_SR_V1"),
    }));
    for (const [id, name] of [
      ["fast", "快线周期"],
      ["slow", "慢线周期"],
      ["signal", "信号周期"],
    ])
      assert.equal(definitions.macd.find((x) => x.id === id).name, name);
    for (const [id, name] of [
      ["high_strength", "High strength"],
      ["low_strength", "Low strength"],
    ])
      assert.equal(definitions.swing.find((x) => x.id === id).name, name);
    await ui.getByRole("button", { name: "指标", exact: true }).click();
    const d = ui.locator('[data-name="indicators-dialog"]');
    await d
      .getByRole("button", { name: "当前图表已添加", exact: true })
      .click();
    await expect(
      d.locator('[data-instance-id="' + ids.macd + '"]'),
    ).toContainText("快线周期 19");
    await expect(
      d.locator('[data-instance-id="' + ids.swing + '"]'),
    ).toContainText("High strength 3");
    await expect(
      d.locator('[data-instance-id="' + ids.swing + '"]'),
    ).toContainText("Low strength 7");
    await page.screenshot({ path: out + "/integrated-added-indicators.png" });
    await d.getByRole("button", { name: "关闭指标窗口", exact: true }).click();
    checks.push(
      "Actual native MACD localized parameters and Swing High/Low strength coexist; Added summaries preserve19/35/11 and3/7",
    );
    async function menu(title) {
      await ui
        .getByRole("button", { name: "保存或应用指标模板", exact: true })
        .click();
      await ui
        .getByText(title, { exact: true })
        .filter({ visible: true })
        .click();
    }
    const rows = async () =>
      await (
        await page.request.get(base + "/api/advanced-charts/preferences")
      ).json();
    await menu("保存指标模板");
    await ui.locator('input[maxlength="64"]').fill(name);
    await page.screenshot({ path: out + "/integrated-template-save.png" });
    await ui.locator('input[maxlength="64"]').press("Enter");
    await ui
      .locator("dialog.mw-study-template-save")
      .waitFor({ state: "hidden" });
    assert.ok(
      (await rows()).some((r) => r.kind === "study" && r.name === name),
    );
    await h.evaluate(() => {
      for (const s of widget.activeChart().getAllStudies())
        widget.activeChart().removeEntity(s.id);
    });
    await menu(name);
    await h.waitForFunction(
      () => widget.activeChart().getAllStudies().length === 2,
    );
    async function waitMacdValues() {
      await expect
        .poll(
          async () =>
            ui
              .locator('[data-qa-id="legend-titles"]')
              .evaluateAll((rows) =>
                rows.some(
                  (row) =>
                    row.textContent.includes("PY MACD") &&
                    /0\.\d+/.test(row.parentElement.parentElement.textContent),
                ),
              ),
          { timeout: 60000 },
        )
        .toBe(true);
    }
    async function state() {
      return h.evaluate(() =>
        widget
          .activeChart()
          .getAllStudies()
          .map((s) => ({
            name: s.name,
            values: widget.activeChart().getStudyById(s.id).getInputValues(),
          })),
      );
    }
    function verify(studies) {
      for (const [suffix, values] of [
        ["MACD", { fast: 19, slow: 35, signal: 11 }],
        [
          "SWING_SR_V1",
          {
            high_strength: 3,
            low_strength: 7,
            show_average_spacing: true,
            statistics_position: "below_name",
          },
        ],
      ]) {
        const s = studies.find((s) => s.name === "守望 Python " + suffix);
        assert.ok(s);
        for (const [id, v] of Object.entries(values))
          assert.equal(s.values.find((x) => x.id === id).value, v);
      }
    }
    verify(await state());
    await waitMacdValues();
    await h.waitForFunction(() =>
      document
        .querySelector(".mw-swing-row")
        ?.textContent.includes("Swing 3 7"),
    );
    await page.screenshot({ path: out + "/integrated-template-applied.png" });
    await h.waitForFunction(
      () =>
        !loading &&
        !nativeSaving &&
        !rangeGuard?.busy() &&
        !edgeGuard?.busy() &&
        widget.activeChart().dataReady(),
    );
    await h.evaluate(
      () =>
        new Promise((resolve, reject) =>
          widget.saveChartToServer(resolve, reject),
        ),
    );
    await page.reload();
    h = await frame();
    ui = h.childFrames()[0];
    verify(await state());
    await waitMacdValues();
    await h.waitForFunction(
      () =>
        document
          .querySelector(".mw-swing-row")
          ?.textContent.includes("Swing 3 7"),
      null,
      { timeout: 60000 },
    );
    await page.screenshot({ path: out + "/integrated-workspace-reloaded.png" });
    await menu(name);
    verify(await state());
    await waitMacdValues();
    const actualOrigin = await h.evaluate(() => {
      const identity = MWSeries.decode(widget.activeChart().symbol());
      return alertCalculationOrigins.get(
        MWSeries.encode(identity.symbol, identity.series_kind) +
          "|" +
          widget.activeChart().resolution(),
      );
    });
    assert(Number.isSafeInteger(actualOrigin));
    await h.evaluate(() =>
      alertBridge.create({
        object: {
          type: "study",
          id: widget
            .activeChart()
            .getAllStudies()
            .find((s) => s.name === "守望 Python MACD").id,
        },
      }),
    );
    const alert = ui.locator(".chart-alert-dialog");
    await expect(alert).toBeVisible();
    await expect(alert.getByLabel("快线周期", { exact: true })).toHaveValue(
      "19",
    );
    await expect(alert).toContainText("此来源尚未确认告警交易日历");
    await expect(
      alert.getByRole("button", { name: "创建告警", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: out + "/integrated-dukascopy-alert-origin.png",
    });
    await alert
      .getByRole("button", { name: "取消（保留草稿）", exact: true })
      .click();
    checks.push(
      "Uppercase native Dukascopy ticker resolves canonical calculation origin; actual study-entry alert opens with19/35/11; unverified calendar correctly prevents submission",
    );
    checks.push(
      "Actual template UI save and apply restore both study numerical/display inputs; native workspace save and full reload retain values and Swing rendering; persisted template remains usable after reload",
    );
    await menu("删除 " + name);
    await ui.getByRole("button", { name: "是", exact: true }).click();
    await expect
      .poll(async () =>
        (await rows()).some((r) => r.kind === "study" && r.name === name),
      )
      .toBe(false);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      out + "/after51-results.json",
      JSON.stringify(
        {
          checks,
          errors,
          definitions,
          studies: await state(),
          scope:
            "Real merged app/API/PG/native template/workspace; synthetic task price cache. No upstream, worker alert decision or notification claim.",
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ checks, errors }));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
