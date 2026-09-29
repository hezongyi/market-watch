// Development native and viewport autosave conflict recovery regression.
const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 950 },
  });
  const errors = [];
  let phase = "initial";
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 700));
  });
  page.on("response", async (r) => {
    if (
      r.url().includes("/api/charts/data") ||
      r.url().includes("/api/market-data/history")
    ) {
      const j = await r.json().catch(() => ({}));
      console.log(
        "RESPONSE",
        r.status(),
        r.url(),
        j.status,
        j.bars?.length,
        j.detail,
      );
    }
  });
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("RECOVERY_PAGE_ERROR", phase, e.stack);
  });
  await page.goto("http://127.0.0.1:5188/");
  await page
    .getByLabel("管理员密码")
    .fill(
      JSON.parse(
        fs.readFileSync(
          process.env.MARKET_WATCH_TEST_CREDENTIALS ||
            require("node:path").resolve(
              __dirname,
              "../../../market-watch/artifacts/local-credentials.json",
            ),
        ),
      ).password,
    );
  await page.getByRole("button", { name: "登录工作台" }).click();
  await page.waitForTimeout(1000);
  console.log(
    await page.evaluate(async () => {
      const session = await (await fetch("/api/session")).json();
      async function post(path, body) {
        let r = await fetch("/api" + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrf,
          },
          body: JSON.stringify(body),
        });
        return r.json();
      }
      const row = await post("/advanced-charts/workspaces", {
        name: "按需历史验收 NZDUSD",
      });
      await post("/advanced-charts/workspaces/" + row.id + "/save", {
        name: row.name,
        revision: row.revision,
        document: {
          engine: "tv31",
          schemaVersion: 1,
          recoveryMetadata: { marker: "preserve-workspace-metadata" },
          symbol: "OANDA:NZD_USD",
          interval: "5",
        },
      });
      const catalog = await (
        await fetch("/api/market-data/catalog?query=NZD_USD")
      ).json();
      return catalog;
    }),
  );
  await page.goto("http://127.0.0.1:5188/advanced-charts");
  await page.waitForTimeout(15000);
  const frame = page.frames().find((f) => f.url().includes(":5187/?"));
  await page.waitForTimeout(1000);
  const assert = require("node:assert/strict");
  await frame.evaluate(
    () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
  );
  phase = "inject-conflict";
  await page.route("**/api/advanced-charts/native-charts/save", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ detail: "acceptance conflict" }),
    }),
  );
  let failed;
  if (process.env.MARKET_WATCH_VIEWPORT_CONFLICT === "1") {
    const id = await page
      .locator("iframe[data-workspace-id]")
      .getAttribute("data-workspace-id");
    const conflict = page.waitForResponse(
      (r) => r.url().endsWith("/native-charts/save") && r.status() === 409,
    );
    await frame.evaluate(() =>
      widget.chart(0).getTimeScale().setRightOffset(4),
    );
    await conflict;
    await page
      .getByRole("alert")
      .filter({ hasText: "acceptance conflict" })
      .waitFor();
    const draft = await page.evaluate(
      (id) => JSON.parse(localStorage.getItem("mw-tv-draft:" + id)),
      id,
    );
    assert.equal(
      draft.state._mwViewports[0].offset,
      4,
      "Conflict draft must contain changed viewport",
    );
    failed = { id, content: JSON.stringify(draft.state) };
  } else
    failed = await frame.evaluate(async () => {
      const rows = await request({ op: "list", args: {} }, "workspace");
      const row = rows[0];
      const original = await request(
        { op: "load", args: { id: row.id } },
        "workspace",
      );
      try {
        await request(
          {
            op: "save",
            args: {
              id: row.id,
              name: "恢复验收",
              symbol: row.symbol,
              resolution: row.resolution,
              content: original.content,
              revision: row.revision,
            },
          },
          "workspace",
        );
      } catch {
        return { id: row.id, content: original.content };
      }
    });
  assert.ok(failed);
  assert.ok(
    await page.evaluate(
      (id) => localStorage.getItem("mw-tv-draft:" + id),
      failed.id,
    ),
  );
  await page.unroute("**/api/advanced-charts/native-charts/save");
  phase = "save-copy";
  const copied = await frame.evaluate(async (failed) => {
    const copy = await request(
      {
        op: "save",
        args: {
          name: "原生另存恢复",
          symbol: "OANDA:NZD_USD",
          resolution: "5",
          content: failed.content,
          revision: 0,
        },
      },
      "workspace",
    );
    const saved = await request(
      {
        op: "save",
        args: {
          id: copy.id,
          name: copy.name,
          symbol: "OANDA:NZD_USD",
          resolution: "5",
          content: failed.content,
          revision: copy.revision,
        },
      },
      "workspace",
    );
    return saved;
  }, failed);
  assert.equal(copied.revision, 2);
  assert.ok(
    await page.evaluate(
      (id) => localStorage.getItem("mw-tv-draft:" + id),
      failed.id,
    ),
    "Save As must retain original recovery draft",
  );
  // Make original latest again to exercise reload recovery from its retained draft.
  await page.evaluate(async (id) => {
    const session = await (await fetch("/api/session")).json();
    const rows = await (await fetch("/api/advanced-charts/workspaces")).json();
    const row = rows.find((r) => r.id === id);
    const r = await fetch("/api/advanced-charts/workspaces/" + id + "/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
      },
      body: JSON.stringify({
        name: row.name,
        revision: row.revision,
        document: row.document,
      }),
    });
    if (!r.ok) throw Error("fixture update failed");
  }, failed.id);
  phase = "reload-draft";
  await page.reload();
  await page.getByRole("alert").filter({ hasText: "存在未保存草稿" }).waitFor();
  phase = "recover-copy";
  await page.getByRole("button", { name: "复制恢复草稿", exact: true }).click();
  await page.waitForFunction(
    (id) => !localStorage.getItem("mw-tv-draft:" + id),
    failed.id,
  );
  const restored = await page.evaluate(
    async () =>
      (await (await fetch("/api/advanced-charts/workspaces")).json())[0],
  );
  assert.notEqual(restored.id, failed.id);
  assert.equal(
    restored.document.recoveryMetadata.marker,
    "preserve-workspace-metadata",
  );
  assert.deepEqual(restored.document.state, JSON.parse(failed.content));
  await page.waitForTimeout(3000);
  const recoveredFrame = page.frames().find((f) => f.url().includes(":5187/?"));
  await recoveredFrame.waitForFunction(
    () => ready && widget.chart(0).symbol() === "OANDA:NZD_USD",
  );
  assert.equal(await recoveredFrame.evaluate(() => widget.chartsCount()), 1);
  assert.deepEqual(errors, []);
  console.log(
    "Native save conflict: durable draft survived reload and recovered into separate workspace",
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
