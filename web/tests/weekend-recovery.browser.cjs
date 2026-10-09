// Real Ubuntu Docker/API/SSE/browser validation with status-only synthetic input.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("@playwright/test");
const root = path.resolve(__dirname, "../..");
const project = "mw-weekend-recovery-20261010";
const app = "http://127.0.0.1:15673";
const chart = "http://127.0.0.1:15674";
const dir = path.join(root, "artifacts/weekend-recovery");
const report = {
  passed: false,
  environment: "Ubuntu isolated Docker",
  synthetic: true,
  phases: [],
  exceptions: [],
};
function fixture(phase) {
  const command =
    "docker compose --env-file artifacts/weekend-recovery/config/compose.env -p " +
    project +
    " -f artifacts/weekend-recovery/compose.yaml exec -T api python - " +
    phase;
  execFileSync("sg", ["docker", "-c", command], {
    cwd: root,
    input: fs.readFileSync(
      path.join(root, "scripts/weekend_recovery_acceptance_fixture.py"),
    ),
    encoding: "utf8",
    timeout: 30000,
  });
}
(async () => {
  let browser, context, csrf;
  try {
    const labels = JSON.parse(
      execFileSync(
        "sg",
        [
          "docker",
          "-c",
          "docker inspect " +
            project +
            '-api-1 --format "{{json .Config.Labels}}"',
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(labels["com.docker.compose.project"], project);
    assert.equal(labels["io.market-watch.task"], project);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.exceptions.push(error.message));
    const login = await context.request.post(app + "/api/login", {
      data: JSON.parse(fs.readFileSync(path.join(dir, "config/login.json"))),
    });
    assert.equal(login.status(), 200);
    csrf = (await login.json()).csrf;
    for (const [phase, text] of [
      ["startup-auth", "OANDA 鉴权失败"],
      ["auth", "OANDA 鉴权失败"],
      ["maintenance", "OANDA 上游维护中"],
      ["closed", "市场已闭市"],
      ["recovering", "市场已闭市"],
    ]) {
      fixture(phase);
      await page.goto(app + "/market-data");
      const panel = page.getByRole("region", {
        name: "OANDA Practice 实时状态",
      });
      await panel
        .getByText(text, { exact: false })
        .first()
        .waitFor({ timeout: 15000 });
      const response = await context.request.get(app + "/api/market-data/live");
      assert.equal(response.status(), 200);
      const rows = await response.json();
      assert.ok(
        rows.every((row) => !row.quote_ready && !row.candle_ready),
        "No false readiness while paused",
      );
      if (phase === "closed") {
        assert.ok(
          rows.length && rows.every((row) => row.market_session === "closed"),
        );
        await panel
          .getByText("历史图表仍可查看", { exact: false })
          .first()
          .waitFor();
      }
      const provider = await (
        await context.request.get(app + "/api/market-data/live/provider-status")
      ).json();
      assert.equal(
        provider.authentication_hold,
        ["startup-auth", "auth", "maintenance"].includes(phase),
      );
      report.phases.push({
        phase,
        rows: rows.length,
        false_readiness: false,
        status_visible: true,
      });
    }
    await page.goto(app + "/advanced-charts");
    await page.locator('iframe[title="专业图表工作区"]').waitFor();
    for (
      let i = 0;
      i < 50 && !page.frames().some((f) => f.url().startsWith(chart + "/"));
      i++
    )
      await page.waitForTimeout(200);
    const frame = page.frames().find((f) => f.url().startsWith(chart + "/"));
    assert.ok(frame);
    await frame.waitForFunction(
      () =>
        typeof ready !== "undefined" &&
        ready &&
        !loading &&
        widget.activeChart().dataReady(),
      null,
      { timeout: 60000 },
    );
    report.native = await frame.evaluate(async () => {
      const saved = await new Promise((resolve) => widget.save(resolve));
      const count = widget.chartsCount();
      for (let i = 0; i < 3; i++) {
        widget.setLayout("s");
        await new Promise((resolve) => setTimeout(resolve, 200));
        await widget.load(saved);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return {
        initial_charts: count,
        restored_charts: widget.chartsCount(),
        restore_cycles: 3,
        symbols: Array.from({ length: widget.chartsCount() }, (_, i) =>
          widget.chart(i).symbol(),
        ),
      };
    });
    await frame.waitForFunction(() => widget.activeChart().dataReady());
    assert.equal(report.native.restored_charts, report.native.initial_charts);
    assert.ok(report.native.symbols.every((symbol) => symbol === "SSEFIXTURE"));
    await page.waitForTimeout(1500);
    assert.equal(
      report.exceptions.length,
      0,
      "No chart startup/restore exceptions",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(app + "/market-data");
    const panel = page.getByRole("region", { name: "OANDA Practice 实时状态" });
    await panel.getByText("市场已闭市", { exact: false }).first().waitFor();
    assert.ok(
      await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      "Status panel fits mobile width",
    );
    report.mobile_status = true;
    report.passed = true;
  } catch (error) {
    report.failure = error.message;
    process.exitCode = 1;
  } finally {
    if (context && csrf)
      await context.request
        .post(app + "/api/logout", { headers: { "X-CSRF-Token": csrf } })
        .catch(() => {});
    if (browser) await browser.close();
    fs.writeFileSync(
      path.join(dir, "browser.json"),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(report));
  }
})();
