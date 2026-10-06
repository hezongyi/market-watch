const { chromium } = require("@playwright/test"),
  fs = require("node:fs"),
  assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://192.168.7.232:16243",
  CHART = process.env.RANGE_CHART || "https://192.168.7.232:16244",
  OUT =
    process.env.RANGE_OUTPUT ||
    "/tmp/mw-sync-settings-implementation/extended.json";
const report = { at: new Date().toISOString(), cases: [], errors: [] };
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  try {
    const f = await require("./fixtures/bar-range-acceptance.cjs")({
      browser,
      report,
      APP,
      CHART,
    });
    let { host, native } = f;
    const { page } = f;
    const record = (name, data) => report.cases.push({ name, ...data });
    const menu = () =>
      native.getByRole("button", { name: "布局设置", exact: true }).click();
    const open = async () => {
      if (!(await native.locator('[data-name="mw-sync-settings"]').isVisible()))
        await menu();
      await native.locator('[data-name="mw-sync-settings"]').click();
      return native.locator('[data-name="mw-sync-settings-dialog"]');
    };
    const values = () =>
      host.evaluate(() =>
        Array.from({ length: widget.chartsCount() }, (_, i) =>
          widget.chart(i).getTimeScale().barSpacing(),
        ),
      );
    const activate = async (i) => {
      const b = await f.box(i);
      await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.85);
      const hint = native.getByRole("button", { name: "了解!", exact: true });
      if (await hint.isVisible()) await hint.click();
      await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.85);
      return b;
    };
    const equal = async () => {
      const v = await values();
      assert.ok(
        v.every((s) => Math.abs(s - v[0]) < 1e-6),
        JSON.stringify(v),
      );
      return v;
    };
    const labels = () =>
      host.evaluate(() => Array.from({length:widget.chartsCount()}, (_,i) =>
        MWBarRangeMapping.labels(widget.chart(i)).filter(tag=>tag.visible).map(tag => tag.text).join("")));
    const verifyTargetLabels = async () => {
      const tags=await host.evaluate(()=>MWBarRangeMapping.labels(widget.chart(1)));
      assert.equal(tags.length,2,'both exterior prices have diagnostics');
      for(const tag of tags) {
        if(!tag.visible)assert.ok(['occupied','unmatched-extreme','outside-pane'].includes(tag.reason));
        else assert.ok(tag.box.y+tag.box.height<=tag.boundary-7||tag.box.y>=tag.boundary+7);
      }
      return tags;
    };
    await host.evaluate(() =>
      MWSyncCoordinator.configure({ date: false, barWidth: true, time: false }),
    );
    await activate(0);
    let b = await f.box(0),
      before = await values();
    await page.mouse.move(b.x + b.width * 0.7, b.y + b.height + 15);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.4, b.y + b.height + 15, {
      steps: 15,
    });
    await page.mouse.up();
    await page.waitForTimeout(300);
    let after = await equal();
    assert.notEqual(after[0], before[0]);
    record("time axis drag input", { before, after });
    // Native on-chart +/- buttons are displayed near the time axis on hover.
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height - 20);
    await page.waitForTimeout(100);
    report.controls = await native.locator("[data-name]").evaluateAll((es) =>
      es
        .filter((e) => /zoom|scale/.test(e.getAttribute("data-name")))
        .map((e) => ({
          name: e.getAttribute("data-name"),
          title: e.getAttribute("title"),
          visible: e.getBoundingClientRect().width > 0,
        })),
    );
    for (const direction of ["in", "out"]) {
      const zoom = native
        .locator(`.control-bar__btn--zoom-${direction}`)
        .first();
      assert.equal(
        await zoom.count(),
        1,
        "installed native zoom button missing",
      );
      before = await values();
      // The real control fades in on pane hover; pointer click still targets
      // the button even if its fading ancestor has not settled yet.
      await zoom.click({ force: true });
      await page.waitForTimeout(400);
      after = await equal();
      assert.notEqual(before[0], after[0]);
      record("native zoom " + direction + " button", { before, after });
    }
    await host.evaluate(async () => {
      await widget
        .chart(1)
        .setSymbol("MWP:BTCUSDT", { doNotActivateChart: true });
      await widget.chart(1).setResolution("5", { doNotActivateChart: true });
    });
    await f.settle();
    await activate(0);
    await page.mouse.wheel(0, -150);
    await page.waitForTimeout(300);
    record("different symbol period bar width", { values: await equal() });
    await host.evaluate(() =>
      MWBarRangeMapping.configure({ style: "rectangle" }),
    );
    await f.hoverLast(0);
    assert.equal((await labels())[1], "");
    record("different symbol range label excluded");
    await host.evaluate(async () => {
      await widget
        .chart(1)
        .setSymbol("MWP:EURUSD", { doNotActivateChart: true });
      await widget.chart(1).setResolution("1D", { doNotActivateChart: true });
    });
    await f.settle();
    // Extreme boundary offset is clamped by the vendor. Compare with legal after.
    for (const offset of [-200, 1000]) {
      await host.evaluate(
        (offset) => widget.chart(1).getTimeScale().setRightOffset(offset),
        offset,
      );
      await f.settle();
      const prior = await host.evaluate(() => {
        const s = widget.chart(1).getTimeScale();
        return {
          offset: s.rightOffset(),
          spacing: s.barSpacing(),
          range: widget.chart(1).getVisibleRange(),
        };
      });
      await activate(0);
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(300);
      await f.settle();
      const result = await host.evaluate(() => {
        const s = widget.chart(1).getTimeScale();
        return {
          offset: s.rightOffset(),
          spacing: s.barSpacing(),
          range: widget.chart(1).getVisibleRange(),
        };
      });
      if (offset < 0)
        assert.ok(result.offset < 0, "historical peer jumped to latest");
      record("boundary " + offset, { prior, result });
    }
    await host.evaluate(() =>
      widget.chart(1).getTimeScale().setRightOffset(10),
    );
    await f.settle();
    let d = await open();
    const original = await host.evaluate(() => MWBarRangeMapping.snapshot());
    await d.locator('[name="transparencyMode"]').selectOption("custom");
    await d.locator('[name="transparency"]').fill("24");
    await page.keyboard.press("Escape");
    assert.deepEqual(
      await host.evaluate(() => MWBarRangeMapping.snapshot()),
      original,
    );
    record("Esc cancels");
    d = await open();
    await d.locator('[data-action="defaults"]').click();
    await d.locator('[data-action="confirm"]').click();
    const defaults = await host.evaluate(() => ({
      config: MWBarRangeMapping.snapshot(),
      sync: MWSyncCoordinator.snapshot(),
    }));
    assert.equal(defaults.config.style, "background");
    assert.equal(defaults.config.colorMode, "theme");
    assert.equal(defaults.sync.barWidth, true);
    record("defaults preserve enabled and sync", { defaults });
    await host.evaluate(() => {
      MWBarRangeMapping.configure({ style: "rectangle" });
      widget.chart(1).getTimeScale().setBarSpacing(6);
      widget.chart(1).getTimeScale().setRightOffset(10);
    });
    await f.settle();
    await f.hoverLast(0);
    await page.screenshot({
      path: "/tmp/mw-sync-settings-implementation/extended-fail.png",
    });
    report.labelDebug = await host.evaluate(() => ({
      mapper: MWBarRangeMapping.diagnostics(),
      config: MWBarRangeMapping.snapshot(),
      charts: [0, 1].map((i) => ({
        r: widget.chart(i).resolution(),
        range: widget.chart(i).getVisibleRange(),
      })),
    }));
    await verifyTargetLabels();
    await host.evaluate(() =>
      widget.chart(1).getSeries().changePriceScale("new-left"),
    );
    await page.waitForTimeout(200);
    await f.hoverLast(0);
    record("exterior labels with native left axis",{tags:await verifyTargetLabels()});
    // The installed vendor rejects no-scale on the only main price source.
    // Left-axis coverage proves right-axis absence without an invalid state.
    await host.evaluate(() =>
      widget.chart(1).getSeries().changePriceScale("new-right"),
    );
    const study = await host.evaluate(() =>
      widget.chart(1).createStudy("Relative Strength Index", false, false),
    );
    await page.waitForTimeout(300);
    await f.hoverLast(0);
    record("exterior labels with subpane", { study,tags:await verifyTargetLabels() });
    await host.evaluate(() => widget.chart(1)._chartWidget.toggleFullscreen());
    await page.waitForTimeout(300);
    const rect = await host.evaluate(() => {
      const cw = widget.chart(1)._chartWidget,
        pane = cw.paneWidgets().find(p => p.containsMainSeries()).canvasElement().getBoundingClientRect();
      return {pane:{left:pane.left,right:pane.right}, axes:MWBarRangeMapping.labels(widget.chart(1)).filter(tag=>tag.visible)};
    });
    for(const tag of rect.axes) assert.ok(tag.box.y+tag.box.height<=tag.boundary-7 || tag.box.y>=tag.boundary+7);
    record("maximized chart exterior labels", { rect });
    await host.evaluate(() => widget.chart(1)._chartWidget.toggleFullscreen());
    await page.waitForTimeout(300);
    // Horizontal disjointness must never show fallback even when prices are valid.
    await host.evaluate(() =>
      widget.chart(1).getTimeScale().setRightOffset(-200),
    );
    await f.settle();
    await f.hoverLast(0);
    assert.equal((await labels())[1], "");
    record("horizontal offscreen clears fallback");
    await host.evaluate(() =>
      widget.chart(1).getTimeScale().setRightOffset(10),
    );
    await f.settle();
    for (let n = 0; n < 20; n++) {
      await host.evaluate((n) => widget.setLayout(n % 2 ? "4" : "2h"), n);
      await f.settle();
    }
    const resources = await host.evaluate(() => ({
      sync: MWSyncCoordinator.diagnostics(),
      rails: widget
        .chart(0)
        ._chartWidget.ownerDocument()
        .querySelectorAll('[data-name="mw-range-price-rail"]').length,
    }));
    assert.equal(resources.sync.bindings, 4);
    assert.equal(resources.sync.pauses, 0);
    assert.equal(resources.rails, 0);
    assert.ok(await host.evaluate(() => MWBarRangeMapping.diagnostics().labelPanes) <= 4);
    record("20 layout cycles stable resources", { resources });
    // One automatic interval must persist an appearance-only edit.
    await host.evaluate(() => {
      autoSave.select(true);
      MWBarRangeMapping.configure({
        transparencyMode: "custom",
        transparency: 21,
      });
    });
    await host.waitForFunction(() => !dirty && !nativeSaving, null, {
      timeout: 40000,
    });
    const autoRows = await (
      await f.ctx.request.get(APP + "/api/advanced-charts/workspaces")
    ).json();
    const autoDoc = autoRows.find((r) => r.id === f.w.id).document;
    const autoContent =
      typeof autoDoc.state.content === "string"
        ? JSON.parse(autoDoc.state.content)
        : autoDoc.state;
    assert.equal(autoContent._mwBarRangeMapping.transparency, 21);
    record("automatic appearance-only save");
    await host.evaluate(() => autoSave.select(false));
    // Save A waits at the server boundary, then config B must remain dirty.
    await host.evaluate(() =>
      MWBarRangeMapping.configure({
        transparencyMode: "custom",
        transparency: 30,
      }),
    );
    let intercepted, release;
    const reached = new Promise((r) => (intercepted = r)),
      gate = new Promise((r) => (release = r));
    await page.route(
      "**/api/advanced-charts/native-charts/save",
      async (route) => {
        intercepted();
        await gate;
        await route.continue();
      },
    );
    const saveA = host.evaluate(
      () =>
        new Promise((resolve, reject) =>
          widget.saveChartToServer(resolve, reject),
        ),
    );
    await reached;
    await host.evaluate(() =>
      MWBarRangeMapping.configure({ transparency: 40 }),
    );
    release();
    await saveA;
    await page.unroute("**/api/advanced-charts/native-charts/save");
    assert.equal(await host.evaluate(() => dirty), true);
    assert.equal(
      await host.evaluate(() => widget._innerAPI().hasChartChanges().value()),
      true,
    );
    await native.locator('[data-name="save-load-menu"]').click();
    const saveEntry = native.locator('[data-name="save-load-menu-item-save"]');
    assert.notEqual(await saveEntry.getAttribute("aria-disabled"), "true");
    record("pending save A cannot clean host or native config B");
    await saveEntry.click();
    await host.waitForFunction(() => !dirty && !nativeSaving, null, {
      timeout: 60000,
    });
    await page.waitForTimeout(6000);
    assert.equal(await host.evaluate(() => dirty), false);
    assert.equal(
      await host.evaluate(() => widget._innerAPI().hasChartChanges().value()),
      false,
    );
    const savedBRows = await (
      await f.ctx.request.get(APP + "/api/advanced-charts/workspaces")
    ).json();
    const savedBDoc = savedBRows.find((r) => r.id === f.w.id).document;
    const savedBState =
      typeof savedBDoc.state.content === "string"
        ? JSON.parse(savedBDoc.state.content)
        : savedBDoc.state;
    assert.equal(savedBState._mwBarRangeMapping.transparency, 40);
    record("real Save menu persists B and late debounce stays clean");
    // Persist distinct spacings: reload must not force equality merely because enabled.
    await host.evaluate(() => {
      for (let i = 0; i < widget.chartsCount(); i++)
        widget
          .chart(i)
          .getTimeScale()
          .setBarSpacing(6 + i);
    });
    await f.settle();
    await host.evaluate(
      () =>
        new Promise((resolve, reject) =>
          widget.saveChartToServer(resolve, reject),
        ),
    );
    await page.waitForTimeout(300);
    const saved = await values();
    await page.reload();
    host = undefined;
    for (let i = 0; i < 300 && !host; i++) {
      host = page.frames().find((f) => f.url().startsWith(CHART + "/"));
      if (!host) await page.waitForTimeout(100);
    }
    f.setHost(host);
    await f.settle();
    native = page.frames().find((f) => f.parentFrame() === host);
    assert.deepEqual(await values(), saved);
    const restored = await host.evaluate(() => ({
      sync: MWSyncCoordinator.snapshot(),
      config: MWBarRangeMapping.snapshot(),
    }));
    assert.equal(restored.sync.barWidth, true);
    assert.equal(restored.config.transparency, 40);
    record("reload restores choices without uniform spacing", {
      saved,
      restored,
    });
    // Existing failure protection retains a draft and requires a recovery copy.
    const originalRow = (
      await (
        await f.ctx.request.get(APP + "/api/advanced-charts/workspaces")
      ).json()
    ).find((r) => r.id === f.w.id);
    await host.evaluate(() =>
      MWBarRangeMapping.configure({ transparency: 22 }),
    );
    await page.route("**/api/advanced-charts/native-charts/save", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "acceptance injected save failure" }),
      }),
    );
    const failed = await host.evaluate(
      () =>
        new Promise((resolve) =>
          widget.saveChartToServer(
            () => resolve(false),
            () => resolve(true),
          ),
        ),
    );
    await page.unroute("**/api/advanced-charts/native-charts/save");
    assert.equal(failed, true);
    assert.equal(await host.evaluate(() => dirty), true);
    const retryBlocked = await host.evaluate(
      () =>
        new Promise((resolve) =>
          widget.saveChartToServer(
            () => resolve(false),
            () => resolve(true),
          ),
        ),
    );
    assert.equal(retryBlocked, true);
    assert.ok(
      await page.evaluate(
        (id) => !!localStorage.getItem("mw-tv-draft:" + id),
        f.w.id,
      ),
    );
    record("failed save retains dirty and blocks original-ID overwrite");
    await host.evaluate(() => widget.closePopupsAndDialogs());
    await native.getByRole("button", { name: "图表菜单", exact: true }).click();
    await native
      .getByRole("button", { name: "复制恢复草稿", exact: true })
      .click();
    const oldHost = host;
    host = undefined;
    for (let i = 0; i < 300 && !host; i++) {
      host = page
        .frames()
        .find(
          (frame) => frame !== oldHost && frame.url().startsWith(CHART + "/"),
        );
      if (!host) await page.waitForTimeout(100);
    }
    assert.ok(host);
    f.setHost(host);
    await f.settle();
    native = page.frames().find((frame) => frame.parentFrame() === host);
    const recovered = await host.evaluate(() => ({
      config: MWBarRangeMapping.snapshot(),
      sync: MWSyncCoordinator.snapshot(),
    }));
    recovered.id = await page
      .locator('iframe[title="专业图表工作区"]')
      .getAttribute("data-workspace-id");
    assert.notEqual(recovered.id, f.w.id);
    assert.equal(recovered.config.transparency, 22);
    assert.equal(recovered.sync.barWidth, true);
    const recoveredRows = await (
      await f.ctx.request.get(APP + "/api/advanced-charts/workspaces")
    ).json();
    assert.deepEqual(
      recoveredRows.find((r) => r.id === f.w.id),
      originalRow,
    );
    const recoveredDoc = recoveredRows.find(
      (r) => r.id === recovered.id,
    ).document;
    const recoveredState =
      typeof recoveredDoc.state.content === "string"
        ? JSON.parse(recoveredDoc.state.content)
        : recoveredDoc.state;
    assert.equal(recoveredState._mwBarRangeMapping.transparency, 22);
    assert.equal(recoveredState._mwSync.barWidth, true);
    record(
      "recovery copy preserves config and sync without overwriting original",
      { recovered },
    );
    assert.deepEqual(report.errors, []);
    await f.ctx.close();
  } catch (e) {
    report.failure = e.stack;
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        cases: report.cases.length,
        last: report.cases.at(-1)?.name,
        failure: report.failure,
        errors: report.errors,
      }),
    );
    await browser.close();
  }
})();
