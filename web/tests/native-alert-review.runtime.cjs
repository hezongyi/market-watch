// Actual Ubuntu task API/worker/PostgreSQL; synthetic candles, no route mocks.
const { chromium, expect } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const PRIVATE = "/tmp/mw-native-alert-ui-runtime";
const APP = "https://localhost:19643",
  CHART = "https://127.0.0.1:19644";
const OUTPUT = process.env.MW_REVIEW_OUTPUT || "/tmp/mw-pr38-fix-runtime";
const compose = `docker compose --env-file ${PRIVATE}/compose.env -p mw-native-alert-ui-runtime -f compose.native-alert-ui.yaml`;
const owner = execFileSync(
  "sg",
  [
    "docker",
    "-c",
    "docker inspect mw-native-alert-ui-runtime-api-1 --format '{{index .Config.Labels \"com.docker.compose.project\"}}'",
  ],
  { encoding: "utf8" },
).trim();
assert.equal(owner, "mw-native-alert-ui-runtime");
const seed = JSON.parse(
  execFileSync("sg", ["docker", "-c", compose + " exec -T api python -"], {
    cwd: root,
    encoding: "utf8",
    input: `
import json,time,uuid
from decimal import Decimal
from alerts.storage import Instrument,Bar,transaction
now=int(time.time()*1000)
step=14_400_000
start=now//step*step-4*step
ident='PR38_'+uuid.uuid4().hex[:12]
with transaction() as db:
    db.add(Instrument(id=ident,label='Synthetic PR38 drawing-period fixture',source='binance',
        symbol='BTCUSDT',basis='last',calendar='utc0',precision=2))
    db.flush()
    for frame,span,count in [('H1',3_600_000,17),('H4',step,5)]:
        for index in range(count):
            stamp=start+index*span
            db.add(Bar(instrument_id=ident,timeframe=frame,start=stamp,end=stamp+span,
                open=Decimal(11),high=Decimal(11),low=Decimal(11),close=Decimal(11),
                complete=stamp+span<=now,observed_at=now))
print(json.dumps({'instrument':ident,'points':[{'time':start,'price':'10','index':0},
    {'time':start+step,'price':'12','index':4}]}))
`,
  }),
);
(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
  });
  const report = {
    scope:
      "Ubuntu Docker; actual licensed native UI, HTTPS API, PostgreSQL and autonomous worker; synthetic task-only candles",
    passed: false,
    cases: [],
    errors: [],
    credentials_sent_to_chart: [],
  };
  page.on("pageerror", (error) => report.errors.push(String(error)));
  page.on("request", (req) => {
    if (
      req.url().startsWith(CHART + "/") &&
      (req.headers().cookie || req.headers().authorization)
    )
      report.credentials_sent_to_chart.push(new URL(req.url()).pathname);
  });
  try {
    await page.goto(APP + "/");
    await page
      .getByLabel("管理员密码")
      .fill(JSON.parse(fs.readFileSync(PRIVATE + "/login.json")).password);
    await page.getByRole("button", { name: "登录工作台" }).click();
    await expect(page.getByLabel("管理员密码")).toHaveCount(0);
    const api = (route, body) =>
      page.evaluate(
        async ({ route, body }) => {
          const session = await (await fetch("/api/session")).json();
          const response = await fetch(
            "/api" + route,
            body === undefined
              ? {}
              : {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-CSRF-Token": session.csrf,
                  },
                  body: JSON.stringify(body),
                },
          );
          if (!response.ok) throw Error(route + " HTTP " + response.status);
          return response.json();
        },
        { route, body },
      );
    const workspace = await api("/advanced-charts/workspaces", {
      name: "PR38 修复验收",
    });
    await api("/advanced-charts/workspaces/" + workspace.id + "/save", {
      name: workspace.name,
      revision: workspace.revision,
      document: {
        engine: "tv31",
        schemaVersion: 1,
        symbol: "MWP:BTCUSDT",
        interval: "1",
      },
    });
    await page.goto(APP + "/advanced-charts");
    await expect
      .poll(
        () =>
          page.frames().some((frame) => frame.url().startsWith(CHART + "/?")),
        { timeout: 30000 },
      )
      .toBe(true);
    const host = page
      .frames()
      .find((frame) => frame.url().startsWith(CHART + "/?"));
    await host.waitForFunction(() => ready && !loading && alertUI, null, {
      timeout: 60000,
    });
    const native = host.childFrames()[0];
    const original = await api("/chart-alerts/geometry", {
      instrument: seed.instrument,
      source: "binance",
      series_kind: "managed",
      timeframe: "H1",
      kind: "trend_line",
      scale: "linear",
      extend_left: true,
      extend_right: true,
      points: seed.points.map(({ time, price }) => ({ time, price })),
    });
    assert.deepEqual(
      original.points.map((point) => point.index),
      [0, 4],
    );
    await host.evaluate(
      ({ workspaceId, seed, line }) => {
        const context = {
          request_id: crypto.randomUUID(),
          instrument: seed.instrument,
          source: "binance",
          series_kind: "managed",
          timeframe: "H1",
          published: false,
          line,
          association: {
            workspace_id: workspaceId,
            chart_id: "review-fixture",
            chart_index: 0,
            generation: "review",
            object_id: "review-trend",
            object_kind: "drawing",
          },
        };
        // Exercise the normal validated parent context round trip.
        send({ type: "chart-alert-context", context });
      },
      { workspaceId: workspace.id, seed, line: original },
    );
    const dialog = native.locator('[data-name="mw-native-alert-dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "消息", exact: true }).click();
    await dialog
      .getByLabel("警报名称")
      .fill("PR38 周期映射 " + seed.instrument);
    await dialog.getByRole("button", { name: "应用到草稿" }).click();
    await expect(
      dialog.getByRole("button", { name: "消息", exact: true }),
    ).toBeFocused();
    await dialog.getByRole("button", { name: "通知", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(
      dialog.getByRole("button", { name: "通知", exact: true }),
    ).toBeFocused();
    report.cases.push(
      "Message apply and notification Escape restore entry focus in the deployed native shell",
    );
    await dialog
      .locator(".alert-advanced-options")
      .evaluate((node) => (node.open = true));
    await dialog.getByRole("button", { name: "判定周期", exact: true }).click();
    await native.getByRole("option", { name: "H4", exact: true }).click();
    await dialog.getByRole("button", { name: "判定", exact: true }).click();
    await native
      .getByRole("option", { name: "盘中观察", exact: true })
      .click();
    const remap = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/chart-alerts/geometry") &&
        response.request().method() === "POST",
    );
    const save = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/chart-alerts") &&
        response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    assert.equal((await remap).status(), 200);
    const savedResponse = await save;
    assert.equal(savedResponse.status(), 201);
    const saved = await savedResponse.json();
    await expect(dialog).toHaveCount(0);
    assert.equal(saved.config.timeframe, "H4");
    assert.deepEqual(
      saved.config.condition.right.line.points.map((point) => point.index),
      [0, 1],
    );
    assert.equal(saved.config.association, null);
    await expect
      .poll(async () => (await api("/chart-alerts/" + saved.id)).health, {
        timeout: 30000,
      })
      .toBe("ready");
    const active = await api("/chart-alerts/" + saved.id);
    report.saved = {
      id: active.id,
      timeframe: active.config.timeframe,
      health: active.health,
      line_indices: active.config.condition.right.line.points.map(
        (point) => point.index,
      ),
    };
    report.cases.push(
      "H1 drawing changed to H4 remaps via real API, saves 201, and autonomous worker reaches ready",
    );
    await page.screenshot({ path: path.join(OUTPUT, "ready.png") });
    await api("/chart-alerts/" + active.id + "/lifecycle", {
      action: "archive",
      version: active.version,
      control_revision: active.control_revision,
      request_id: crypto.randomUUID(),
    });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.credentials_sent_to_chart, []);
    report.passed = true;
  } catch (error) {
    report.failure = String(error);
    await page.screenshot({ path: path.join(OUTPUT, "failure.png") });
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(
      path.join(OUTPUT, "result.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    await browser.close();
  }
})();
