// Real Ubuntu D0 acceptance. No authentication, quote, or persistence mocks.
// Interception appears only in named failure/recovery checks.
const { chromium, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const base = process.env.MW_ACCEPTANCE_URL || "https://192.168.7.232:18282";
const output = process.env.MW_ACCEPTANCE_OUTPUT || "/tmp/mw82-browser";
const password = JSON.parse(
  fs.readFileSync(
    process.env.MARKET_WATCH_TEST_CREDENTIALS ||
      "/tmp/mw-issue82-private/credentials.json",
  ),
).password;
fs.mkdirSync(output, { recursive: true });
const results = [],
  errors = [];
let browser, context, page;
async function record(name, run) {
  try {
    const value = await run();
    results.push({ name, passed: true, ...(value ? { evidence: value } : {}) });
    console.log("PASS", name);
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
    await page
      ?.screenshot({ path: path.join(output, "failure.png") })
      .catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify({ results, errors }, null, 2),
    );
  }
}
async function newContext(options = {}) {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
    ...options,
  });
  ctx.on("page", (p) =>
    p.on("pageerror", (e) => {
      errors.push(e.message);
      console.log("PAGEERROR", e.message);
    }),
  );
  return ctx;
}
async function login(p = page, next = "/advanced-charts/issue82-a") {
  await p.goto(base + "/login?next=" + encodeURIComponent(next));
  await p
    .getByLabel("管理员密码")
    .waitFor({ timeout: 15000 })
    .catch(async (error) => {
      console.log(
        "LOGIN LANDING",
        p.url(),
        await p.locator("body").innerText(),
      );
      await screenshot("login-failure", p);
      throw error;
    });
  await p.getByLabel("管理员密码").fill(password);
  await p.getByRole("button", { name: /登录并/ }).click();
  await expect(p).not.toHaveURL(/\/login/);
}
async function api(route, body, p = page) {
  return p.evaluate(
    async ({ route, body }) => {
      const session = await (await fetch("/api/session")).json();
      const r = await fetch("/api" + route, {
        method: body === undefined ? "GET" : "POST",
        headers:
          body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "X-CSRF-Token": session.csrf,
              },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await r.json();
      if (!r.ok) throw Error(r.status + ": " + JSON.stringify(value));
      return value;
    },
    { route, body },
  );
}
async function chart(p = page) {
  await p.locator("iframe[data-workspace-id]").waitFor();
  // FrameLocator exposes selectors; evaluation uses the Playwright Frame.
  let host;
  await expect
    .poll(
      () => !!(host = p.frames().find((f) => f.url().includes(":18283/?"))),
      { timeout: 30000 },
    )
    .toBe(true);
  await host.waitForFunction(
    () =>
      typeof widget !== "undefined" &&
      ready &&
      !loading &&
      typeof chartMenu !== "undefined" &&
      chartMenu,
    { timeout: 45000 },
  );
  const native = host.childFrames().find((f) => f.url().startsWith("blob:"));
  assert.ok(native, "real native chart iframe is required");
  await native.locator(".mw-chart-menu-button").waitFor();
  return { host, native };
}
async function appNavigate(action, p = page, discard = false) {
  const previous = new URL(p.url()).pathname;
  const { native } = await chart(p);
  await native.getByRole("button", { name: "图表菜单", exact: true }).click();
  await native.locator(`[data-app-action="${action}"]`).click();
  if (discard) {
    // Native panel/layout interactions may themselves mark the layout dirty.
    // Dedicated dirty tests exercise all choices; ordinary navigation discards.
    await expect
      .poll(
        async () =>
          new URL(p.url()).pathname !== previous ||
          (await p.getByRole("dialog", { name: "有未保存的更改" }).isVisible()),
      )
      .toBe(true);
    if (await p.getByRole("dialog", { name: "有未保存的更改" }).isVisible())
      await p.getByRole("button", { name: "放弃更改", exact: true }).click();
  }
}
async function watchlist({ host, native }, list = "issue82-list-a") {
  if ((await native.locator("[data-symbol-full]").count()) === 0)
    await native
      .getByRole("button", { name: "观察清单和详情", exact: true })
      .click();
  await host.evaluate(
    async (list) => (await widget.watchList()).setActiveList(list),
    list,
  );
  await expect(native.locator("[data-symbol-full]").first()).toBeVisible();
}
async function screenshot(name, p = page) {
  await p.screenshot({ path: path.join(output, name + ".png") });
}

(async () => {
  browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  context = await newContext();
  page = await context.newPage();
  const suite = process.env.MW_ACCEPTANCE_SUITE || "all";
  if (suite === "all" || suite === "login") {
    await record(
      "login: root, animation, focus/caret, error and real authentication",
      async () => {
        const chartRequests = [];
        page.on("request", (r) => {
          if (/18283|\/charts\/stream|\/market-data\/quotes/.test(r.url()))
            chartRequests.push(r.url());
        });
        await page.goto(base + "/");
        await expect(page.getByLabel("管理员密码")).toBeVisible();
        assert.equal(await page.title(), "登录");
        assert.equal(chartRequests.length, 0);
        assert.ok((await page.locator(".dot-pulse").count()) <= 64);
        assert.equal(await page.locator("pattern").count(), 1);
        const durations = await page
          .locator(".dot-pulse")
          .evaluateAll((nodes) =>
            nodes.map((n) => parseFloat(getComputedStyle(n).animationDuration)),
          );
        assert.ok(durations.every((n) => n >= 7 && n <= 12));
        await screenshot("login-dark-desktop");
        const input = page.getByLabel("管理员密码");
        await input.fill("wrong-password");
        await input.evaluate((n) => {
          globalThis.savedPasswordNode = n;
          n.setSelectionRange(2, 6);
        });
        await expect(page.locator(".dot-background")).toHaveAttribute(
          "data-paused",
          "true",
        );
        await page.getByRole("button", { name: "显示密码" }).click();
        assert.deepEqual(
          await input.evaluate((n) => ({
            same: n === globalThis.savedPasswordNode,
            start: n.selectionStart,
            end: n.selectionEnd,
            focused: n === document.activeElement,
          })),
          { same: true, start: 2, end: 6, focused: true },
        );
        await input.press("Enter");
        await expect(page.locator("#login-error")).not.toHaveText("");
        await page.getByRole("button", { name: "切换浅色主题" }).click();
        await screenshot("login-light-desktop");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect(page.locator(".dot-background")).toHaveAttribute(
          "data-paused",
          "true",
        );
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.evaluate(() => {
          Object.defineProperty(document, "hidden", {
            configurable: true,
            value: true,
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await expect(page.locator(".dot-background")).toHaveAttribute(
          "data-paused",
          "true",
        );
        await page.evaluate(() => {
          delete document.hidden;
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await input.fill(password);
        await input.press("Enter");
        await chart();
        await expect(page).toHaveURL(/\/advanced-charts\/[^/?]+/);
        assert.ok(chartRequests.length > 0);
      },
    );
    await record(
      "login: valid deep link keeps search/hash; illegal destinations fall back",
      async () => {
        for (const next of [
          "/signals?signal=issue82-legacy-signal#evidence",
          "https://example.com/",
          "//example.com/",
          "/login?next=/signals",
          "/api/session",
          "/chart-data-center?session=x",
        ]) {
          const ctx = await newContext(),
            p = await ctx.newPage();
          await login(p, next);
          if (next.startsWith("/signals"))
            await expect(p).toHaveURL(base + next);
          else await expect(p).toHaveURL(/\/advanced-charts(?:\/|$)/);
          await ctx.close();
        }
        await page.goto(
          base + "/login?next=" + encodeURIComponent("/settings/sound#test"),
        );
        await expect(page).toHaveURL(base + "/settings/sound#test");
        await expect(page.getByLabel("管理员密码")).toHaveCount(0);
      },
    );
    await record("login: mobile dark/light and read-only chart", async () => {
      const ctx = await newContext({
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
        }),
        p = await ctx.newPage();
      await p.goto(base + "/login");
      await expect(p.getByLabel("管理员密码")).toBeVisible();
      await screenshot("login-dark-mobile", p);
      await p.getByRole("button", { name: "切换浅色主题" }).click();
      await screenshot("login-light-mobile", p);
      assert.equal(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await p.getByLabel("管理员密码").fill(password);
      await p.getByRole("button", { name: /登录并/ }).click();
      await chart(p);
      await expect(p.getByText(/手机只读/)).toBeVisible();
      await screenshot("chart-mobile", p);
      await ctx.close();
    });
    await record(
      "mobile: platform entry never creates; desktop/mobile empty states are explicit",
      async () => {
        const ctx = await newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
          }),
          p = await ctx.newPage();
        const writes = [];
        p.on("request", (r) => {
          if (
            r.method() === "POST" &&
            /\/api\/advanced-charts\/(workspaces|preferences)/.test(r.url())
          )
            writes.push(r.url());
        });
        await login(p, "/advanced-charts?platform=MWP:EURUSD");
        await chart(p);
        await expect(p.getByText(/手机只读看盘/)).toBeVisible();
        assert.deepEqual(writes, []);
        // Explicit UI-boundary empty-list fixture; the real D0 database is retained.
        await p.route("**/api/advanced-charts/workspaces", (route) =>
          route.request().method() === "GET"
            ? route.fulfill({ json: [] })
            : route.continue(),
        );
        await p.goto(base + "/advanced-charts?platform=MWP:EURUSD");
        await expect(
          p.getByText("手机只读看盘，请在桌面浏览器创建工作区。", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          p.getByRole("button", { name: "新建工作区", exact: true }),
        ).toBeDisabled();
        assert.equal(await p.locator("iframe[data-workspace-id]").count(), 0);
        assert.deepEqual(writes, []);
        await screenshot("chart-empty-mobile", p);
        await ctx.close();
        const desktop = await context.newPage();
        await desktop.route("**/api/advanced-charts/workspaces", (route) =>
          route.request().method() === "GET"
            ? route.fulfill({ json: [] })
            : route.continue(),
        );
        await desktop.goto(base + "/advanced-charts");
        await expect(
          desktop.getByText("选择已有工作区，或新建工作区开始使用。", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          desktop.getByRole("button", { name: "新建工作区", exact: true }),
        ).toBeEnabled();
        await screenshot("chart-empty-desktop", desktop);
        await desktop.close();
      },
    );
  } else await login();
  if (suite === "all" || suite === "routes") {
    await record(
      "routes: explicit workspace, refresh, back/forward, unavailable and unknown",
      async () => {
        await page.goto(base + "/advanced-charts/issue82-a");
        await chart();
        await page.reload();
        await chart();
        assert.equal(
          await page
            .locator("iframe[data-workspace-id]")
            .getAttribute("data-workspace-id"),
          "issue82-a",
        );
        await page.goto(base + "/advanced-charts/issue82-b");
        await chart();
        await page.goBack();
        await chart();
        await expect(page).toHaveURL(/issue82-a$/);
        await page.goForward();
        await chart();
        await expect(page).toHaveURL(/issue82-b$/);
        await page.goto(base + "/advanced-charts/issue82-missing");
        await expect(
          page.getByRole("heading", { name: "工作区不可用", exact: true }),
        ).toBeVisible();
        assert.equal(await page.locator("iframe").count(), 0);
        await page.goto(base + "/market-data-invalid");
        await expect(page.getByText("页面不存在。")).toBeVisible();
        await page.goto(base + "/advanced-charts");
        await chart();
        await expect(page).toHaveURL(/issue82-b$/);
      },
    );
    await record(
      "navigation: native menu, pending count, alerts panel and return",
      async () => {
        let { host, native } = await chart();
        assert.equal(await page.locator(".app-header").count(), 0);
        await native
          .getByRole("button", { name: "图表菜单", exact: true })
          .click();
        const menu = native.locator("#mw-chart-menu");
        const pending = (await api("/signals/pending-count")).count;
        await expect(menu.locator('[data-app-action="signals"]')).toHaveText(
          "通知" + (pending > 0 ? `（${pending} 待确认）` : ""),
        );
        for (const action of [
          "charts",
          "signals",
          "replay",
          "settings",
          "legacy",
          "logout",
        ])
          await expect(
            menu.locator(`[data-app-action="${action}"]`),
          ).toBeVisible();
        assert.equal(
          await menu.getByText("数据中心", { exact: true }).count(),
          0,
        );
        await native
          .getByRole("button", { name: "图表菜单", exact: true })
          .click();
        await host.evaluate(() => alertUI.open());
        await expect(page).toHaveURL(/panel=alerts/);
        await appNavigate("signals", page, true);
        await expect(page).toHaveURL(/\/signals$/);
        await expect.poll(() => host.isDetached()).toBe(true);
        await expect(page).toHaveTitle("通知");
        await page.getByRole("link", { name: "返回图表" }).click();
        ({ host, native } = await chart());
        await expect(page).toHaveURL(/issue82-b\?panel=alerts$/);
        await expect
          .poll(() =>
            host.evaluate(async () => {
              const w = await widget.widgetbar();
              return (
                w._widgetbar.layout.getActivePage()?.name === "alerts" &&
                !w._widgetbar.layout.minimized
              );
            }),
          )
          .toBe(true);
        await host.evaluate(async () => {
          const w = await widget.widgetbar();
          w._widgetbar.layout.onTabClick(w._widgetbar.layout.getActivePage());
        });
        await expect(page).not.toHaveURL(/panel=alerts/);
        await screenshot("chart-desktop");
      },
    );
    await record(
      "workspace: native load keeps iframe, synchronizes URL and quote subscription",
      async () => {
        const { host } = await chart();
        await host.evaluate(async () => {
          const target = (
            await request({ op: "list", args: {} }, "workspace")
          ).find((r) => r.id === "issue82-a");
          globalThis.acceptanceLoad = widget.loadChartFromServer({
            id: target.id,
            name: target.name,
            image_url: "",
            modified_iso: target.timestamp,
            short_symbol: target.symbol,
            interval: target.resolution,
          });
        });
        await expect
          .poll(
            async () => {
              if (await page.getByRole("dialog").isVisible())
                await page
                  .getByRole("button", { name: "放弃更改", exact: true })
                  .click();
              return new URL(page.url()).pathname;
            },
            { timeout: 30000 },
          )
          .toBe("/advanced-charts/issue82-a");
        await chart();
        assert.equal(host.isDetached(), false);
        await expect(page).toHaveTitle(/^EURUSD /);
        await expect
          .poll(() =>
            host.evaluate(() => quoteSubscriptions.has("mw-active-tab")),
          )
          .toBe(true);
      },
    );
    await record(
      "data center: native window keeps chart and restores URL",
      async () => {
        const { host, native } = await chart();
        await native
          .getByRole("button", { name: "数据中心", exact: true })
          .click();
        await expect(page).toHaveURL(/data_center=/);
        assert.equal(host.isDetached(), false);
        await screenshot("data-center");
        const url = page.url();
        await page.goto(base + "/signals");
        await page.getByRole("link", { name: "返回图表" }).click();
        await chart();
        await expect(page).toHaveURL(url);
        assert.ok(page.frames().length >= 3);
      },
    );
    await record(
      "data center: failed native assets use real internal iframe and close cleanly",
      async () => {
        const p = await context.newPage();
        await p.route("**/data-center-native.js", (route) =>
          route.abort("failed"),
        );
        await p.goto(base + "/advanced-charts/issue82-a");
        const { host, native } = await chart(p);
        await native
          .getByRole("button", { name: "数据中心", exact: true })
          .click();
        await expect(
          native.getByRole("dialog", { name: "数据中心兼容窗口" }),
        ).toBeVisible();
        let internal;
        await expect
          .poll(
            () =>
              !!(internal = p
                .frames()
                .find((f) => f.url().includes("/chart-data-center?session="))),
            { timeout: 15000 },
          )
          .toBe(true);
        assert.match(internal.url(), /session=[a-f0-9-]{36}$/);
        await expect(
          internal.getByRole("heading", { name: "数据中心", exact: true }),
        ).toBeVisible();
        await expect(
          internal.getByRole("heading", { name: "自建行情", exact: true }),
        ).toBeVisible();
        await screenshot("data-center-fallback", p);
        await internal.getByRole("button", { name: "关闭数据中心" }).click();
        await expect(
          native.getByRole("dialog", { name: "数据中心兼容窗口" }),
        ).toHaveCount(0);
        await expect(p).not.toHaveURL(/data_center=/);
        assert.equal(host.isDetached(), false);
        await p.close();
      },
    );
    await record(
      "notifications: precise legacy/chart events, no view ack, retry and confirm",
      async () => {
        const before = await api("/signals/pending-count");
        const rows = await api("/signals");
        const legacy = rows.find((r) => r.id === "issue82-legacy-signal"),
          chartRow = rows.find((r) => r.evidence?.chart_alert);
        assert.ok(
          legacy && chartRow,
          "real persisted legacy and chart event fixtures required",
        );
        for (const row of [legacy, chartRow]) {
          await page.goto(base + "/signals?signal=" + row.id);
          const card = page.locator("#signal-" + row.id);
          await expect(card).toBeVisible();
          await expect(card).toBeFocused();
        }
        assert.deepEqual(await api("/signals/pending-count"), before);
        await page.getByRole("button", { name: "应用菜单" }).focus();
        await page.waitForTimeout(11000);
        await expect(
          page.getByRole("button", { name: "应用菜单" }),
        ).toBeFocused();
        await page.goto(base + "/signals?signal=" + legacy.id);
        const card = page.locator("#signal-" + legacy.id);
        const navs = [];
        page.on("framenavigated", (f) => {
          if (f === page.mainFrame()) navs.push(f.url());
        });
        await card.getByRole("button", { name: /重试/ }).click();
        assert.equal(navs.length, 0);
        if (!legacy.ack_at) {
          await card.getByRole("button", { name: /确认/ }).click();
          await expect
            .poll(
              async () => (await api("/signals?signal=" + legacy.id))[0].ack_at,
            )
            .toBeTruthy();
        }
        await screenshot("notifications");
      },
    );
    await record(
      "legacy: Watch cancel remains and old editor identity is retained",
      async () => {
        await page.goto(base + "/legacy/monitoring");
        await expect(page.getByText("旧 Watch 取消验收")).toBeVisible();
        const watches = await api("/watches");
        const watch = watches.find((w) => w.id === "issue82-watch");
        assert.ok(watch);
        if (watch.status === "active") {
          await page
            .getByRole("button", { name: /取消监控|取消/ })
            .first()
            .click();
          await expect
            .poll(
              async () =>
                (await api("/watches")).find((w) => w.id === watch.id).status,
            )
            .toBe("cancelled");
        }
        const old = (await api("/charts/workspaces")).find(
          (w) => w.id === "issue82-legacy",
        );
        await page.goto(base + "/chart-workspaces/issue82-legacy");
        await expect(page.locator(".cw-app, .chart-workspace")).toBeVisible();
        assert.equal(
          (await api("/charts/workspaces")).find((w) => w.id === old.id).id,
          old.id,
        );
        assert.ok(
          !(await api("/advanced-charts/workspaces")).some(
            (w) => w.id === old.id,
          ),
        );
        await screenshot("legacy-editor");
      },
    );
    await record(
      "replay: fixed dataset deep link creates and resumes same run",
      async () => {
        const versions = await api("/market-data/versions");
        const version = versions.find((v) => v.status === "published");
        assert.ok(version);
        await page.goto(base + "/replay?dataset_version=" + version.id);
        const create = page.getByRole("button", {
          name: "创建演练",
          exact: true,
        });
        await expect(create).toBeEnabled({ timeout: 30000 });
        await create.click();
        await expect(page).toHaveURL(/\/replay\/[a-f0-9-]+$/);
        const url = page.url(),
          id = url.split("/").at(-1);
        const run = await api("/replays/" + id);
        assert.equal(run.dataset_version, version.id);
        await page.reload();
        await expect(
          page.getByRole("button", { name: "创建演练", exact: true }),
        ).not.toBeVisible();
        assert.equal((await api("/replays/" + id)).id, id);
        await screenshot("replay");
      },
    );
  }
  if (suite === "all" || suite === "flags") {
    const listPreference = (await api("/advanced-charts/preferences")).find(
      (p) => p.name === "mw.watchlists.v1",
    );
    await api("/advanced-charts/preferences/save", {
      kind: "setting",
      name: "mw.watchlists.v1",
      tool: "",
      revision: listPreference.revision,
      content: {
        value: {
          active: "issue82-list-a",
          lists: [
            {
              id: "issue82-list-a",
              title: "验收列表 A",
              symbols: [
                "MWP:EURUSD",
                "MWP:XAUUSD",
                "MWP:BTCUSDT",
                "MWP:ALT_EURUSD",
              ],
            },
            {
              id: "issue82-list-b",
              title: "验收列表 B",
              symbols: ["MWP:XAUUSD", "MWP:EURUSD"],
            },
          ],
        },
      },
    });
    await record(
      "flags: seven choices, clear, identity, keyboard, retry and real persistence",
      async () => {
        await page.goto(base + "/advanced-charts/issue82-a");
        const { host, native } = await chart();
        await watchlist({ host, native });
        await expect(native.locator(".mw-symbol-flag").first()).toBeVisible();
        const ticker = "MWP:EURUSD",
          flag = () =>
            native.locator(`.mw-symbol-flag[data-ticker="${ticker}"]`);
        const active = await host.evaluate(() => widget.activeChart().symbol());
        for (const color of [
          "红色",
          "蓝色",
          "绿色",
          "黄色",
          "紫色",
          "青色",
          "粉色",
        ]) {
          await flag().click();
          await expect(
            native.getByRole("radiogroup", { name: "七色收藏" }),
          ).toBeVisible();
          await native.getByRole("radio", { name: color, exact: true }).click();
          await expect(flag()).toHaveAttribute("title", color + "收藏");
          assert.equal(
            await host.evaluate(() => widget.activeChart().symbol()),
            active,
          );
        }
        await flag().focus();
        await flag().press("Enter");
        await expect(
          native.getByRole("radio", { name: "粉色", exact: true }),
        ).toBeFocused();
        await native
          .getByRole("radio", { name: "粉色", exact: true })
          .press("Home");
        await expect(
          native.getByRole("radio", { name: "红色", exact: true }),
        ).toBeFocused();
        await native
          .getByRole("radio", { name: "红色", exact: true })
          .press("Escape");
        await expect(flag()).toBeFocused();
        await native
          .locator('.mw-symbol-flag[data-ticker="MWP:ALT_EURUSD"]')
          .click();
        await native.getByRole("radio", { name: "蓝色", exact: true }).click();
        await expect(flag()).toHaveAttribute("title", "粉色收藏");
        await page.route("**/api/advanced-charts/preferences/save", (route) => {
          const body = route.request().postDataJSON();
          return body.name === "mw.symbol-flags.v1"
            ? route.fulfill({
                status: 503,
                contentType: "application/json",
                body: '{"detail":"controlled acceptance failure"}',
              })
            : route.continue();
        });
        await flag().click();
        await native.getByRole("radio", { name: "绿色", exact: true }).click();
        await expect(native.getByText(/保存失败，修改尚未保存/)).toBeVisible();
        await expect(flag()).toHaveAttribute("title", "粉色收藏");
        await page.unroute("**/api/advanced-charts/preferences/save");
        await native.getByRole("button", { name: "重试保存" }).click();
        await expect(flag()).toHaveAttribute("title", "绿色收藏");
        await flag().click();
        await screenshot("flags-seven-color");
        await native.getByRole("button", { name: "关闭", exact: true }).click();
        await page.reload();
        const next = await chart();
        await expect(
          next.native.locator(`.mw-symbol-flag[data-ticker="${ticker}"]`),
        ).toHaveAttribute("title", "绿色收藏");
        const preferences = await api("/advanced-charts/preferences");
        const saved = preferences.find((p) => p.name === "mw.symbol-flags.v1");
        assert.equal(saved.content.value.flags[ticker], "green");
        assert.equal(saved.content.value.flags["MWP:ALT_EURUSD"], "blue");
        assert.equal(saved.content.value.version, 1);
      },
    );
    await record(
      "flags: cross-list/workspace, independent membership and concurrent revision rebase",
      async () => {
        let { host, native } = await chart();
        await host.evaluate(async () => {
          (await widget.watchList()).setActiveList("issue82-list-b");
        });
        await expect(
          native.locator('.mw-symbol-flag[data-ticker="MWP:EURUSD"]'),
        ).toHaveAttribute("title", "绿色收藏");
        await page.goto(base + "/advanced-charts/issue82-b");
        ({ host, native } = await chart());
        await expect(
          native.locator('.mw-symbol-flag[data-ticker="MWP:EURUSD"]'),
        ).toHaveAttribute("title", "绿色收藏");
        await host.evaluate(async () => {
          (await widget.watchList()).setActiveList("issue82-list-b");
        });
        await expect
          .poll(() =>
            host.evaluate(async () =>
              (await widget.watchList()).getActiveListId(),
            ),
          )
          .toBe("issue82-list-b");
        const second = await context.newPage();
        await second.goto(base + "/advanced-charts/issue82-a");
        const other = await chart(second);
        await native
          .locator('.mw-symbol-flag[data-ticker="MWP:EURUSD"]')
          .click();
        await native.getByRole("radio", { name: "紫色", exact: true }).click();
        await expect(
          native.locator('.mw-symbol-flag[data-ticker="MWP:EURUSD"]'),
        ).toHaveAttribute("title", "紫色收藏");
        await other.native
          .locator('.mw-symbol-flag[data-ticker="MWP:XAUUSD"]')
          .click();
        await other.native
          .getByRole("radio", { name: "黄色", exact: true })
          .click();
        await expect(
          other.native.locator('.mw-symbol-flag[data-ticker="MWP:XAUUSD"]'),
        ).toHaveAttribute("title", "黄色收藏");
        const flags = (await api("/advanced-charts/preferences")).find(
          (p) => p.name === "mw.symbol-flags.v1",
        ).content.value.flags;
        assert.equal(flags["MWP:EURUSD"], "purple");
        assert.equal(flags["MWP:XAUUSD"], "yellow");
        await second.close();
        await host.evaluate(async () => {
          const a = await widget.watchList();
          a.updateList("issue82-list-b", ["MWP:XAUUSD"]);
        });
        await expect(
          native.locator('.mw-symbol-flag[data-ticker="MWP:EURUSD"]'),
        ).toHaveCount(0);
        assert.equal(
          (await api("/advanced-charts/preferences")).find(
            (p) => p.name === "mw.symbol-flags.v1",
          ).content.value.flags["MWP:EURUSD"],
          "purple",
        );
        await host.evaluate(async () => {
          const a = await widget.watchList();
          a.updateList("issue82-list-b", ["MWP:XAUUSD", "MWP:EURUSD"]);
        });
        await native
          .locator('.mw-symbol-flag[data-ticker="MWP:EURUSD"]')
          .click();
        await native
          .getByRole("button", { name: "取消收藏", exact: true })
          .click();
        await expect(
          native.locator('.mw-symbol-flag[data-ticker="MWP:EURUSD"]'),
        ).toHaveAttribute("title", "添加颜色收藏");
        await appNavigate("logout", page, true);
        await expect(page.getByLabel("管理员密码")).toBeVisible();
        await login();
        ({ host, native } = await chart());
        await watchlist({ host, native }, "issue82-list-b");
        await expect(
          native.locator('.mw-symbol-flag[data-ticker="MWP:XAUUSD"]'),
        ).toHaveAttribute("title", "黄色收藏");
      },
    );
  }
  if (suite === "all" || suite === "title") {
    await record(
      "title: active pane, comparison, inactive edits, crosshair, off-list ticker and rapid switches",
      async () => {
        await page.goto(base + "/advanced-charts/issue82-a");
        const { host, native } = await chart();
        await expect(page).toHaveTitle(
          /^EURUSD [\d.,]+(?: [▲▼] [＋+−-]?[\d.]+%)?(?: · 迟延)?$/,
        );
        assert.ok(!/守望|Market Watch/.test(await page.title()));
        await host.evaluate(() => widget.setLayout("2h"));
        await host.waitForFunction(
          () => widget.chartsCount() === 2 && !loading,
        );
        await host.evaluate(async () => {
          await widget.chart(1).setSymbol("MWP:XAUUSD");
          widget.setActiveChart(1);
        });
        await expect(page).toHaveTitle(/^XAUUSD /);
        const before = await page.title();
        const comparison = await host.evaluate(() =>
          widget
            .activeChart()
            .createStudy(
              "Compare",
              true,
              false,
              { symbol: "MWP:BTCUSDT" },
              undefined,
              { priceScale: "new-left" },
            ),
        );
        assert.ok(comparison, "real native comparison was created");
        await expect(page).toHaveTitle(/^XAUUSD /);
        await expect(page).not.toHaveTitle(/XAUUSD [\d.,]+%/);
        await host.evaluate(async () => {
          await widget
            .chart(0)
            .setSymbol("MWP:BTCUSDT", { doNotActivateChart: true });
        });
        await expect(page).toHaveTitle(/^XAUUSD /);
        await native
          .locator("canvas")
          .first()
          .hover({ position: { x: 100, y: 100 } })
          .catch(() => {});
        assert.match(await page.title(), /^XAUUSD /);
        await host.evaluate(async () => {
          const a = await widget.watchList();
          const id = a.getActiveListId();
          a.updateList(
            id,
            (a.getList(id) || []).filter((s) => s !== "MWP:BTCUSDT"),
          );
          widget.setActiveChart(0);
        });
        await expect(page).toHaveTitle(/^BTCUSDT /);
        await host.evaluate(() => {
          widget.setActiveChart(1);
          widget.setActiveChart(0);
          widget.setActiveChart(1);
        });
        await expect(page).toHaveTitle(/^XAUUSD /);
        await screenshot("title-two-panes");
        return { title: await page.title(), previousTitle: before };
      },
    );
    await record(
      "title: missing values, historical/delayed labels, duplicate suppression and 1 Hz",
      async () => {
        const { host } = await chart();
        // Drive the existing quote consumer boundary; values are intentionally
        // controlled to cover missing fields and cadence, not supplier evidence.
        await page.evaluate(() => {
          globalThis.titleWrites = [];
          new MutationObserver(() =>
            globalThis.titleWrites.push(performance.now()),
          ).observe(document.querySelector("title"), {
            subtree: true,
            childList: true,
            characterData: true,
          });
        });
        await host.evaluate(() => {
          const row = quoteSubscriptions.get("mw-active-tab"),
            ticker = widget.activeChart().symbol();
          row.cb([{ n: ticker, v: { lp: 123.45, chp: -1.09 } }]);
        });
        await expect(page).toHaveTitle(/123.45.*▼ −1.09%/);
        await host.evaluate(async () => {
          const row = quoteSubscriptions.get("mw-active-tab"),
            ticker = widget.activeChart().symbol();
          for (let i = 0; i < 20; i++) {
            row.cb([{ n: ticker, v: { lp: 124 + i, chp: 1 } }]);
            await new Promise((r) => setTimeout(r, 40));
          }
        });
        await page.waitForTimeout(1200);
        const times = await page.evaluate(() => globalThis.titleWrites);
        assert.ok(
          times.slice(1).every((t, i) => t - times[i] >= 950),
          "continuous quote title changes are at most 1 Hz",
        );
        await host.evaluate(() => {
          const row = quoteSubscriptions.get("mw-active-tab");
          row.cb([
            {
              n: widget.activeChart().symbol(),
              v: { lp: 88.25, delay_seconds: 10 },
            },
          ]);
        });
        await expect(page).toHaveTitle(/88.25 · 迟延$/);
        await host.evaluate(() => {
          const row = quoteSubscriptions.get("mw-active-tab");
          row.cb([{ n: widget.activeChart().symbol(), v: {} }]);
        });
        await expect(page).toHaveTitle("XAUUSD");
        const versions = await api("/market-data/versions"),
          version = versions.find((v) => v.status === "published");
        await page.goto(base + "/advanced-charts/issue82-history");
        await chart();
        await expect(page).toHaveTitle(/ · 历史$/);
        await appNavigate("signals", page, true);
        await expect(page).toHaveTitle("通知");
      },
    );
  }
  if (suite === "all" || suite === "dirty") {
    await record(
      "dirty settings: cancel/discard/save, failure retains edits; network does not log out",
      async () => {
        await page.goto(base + "/settings/notifications");
        const priority = page.getByLabel("通知优先级");
        await expect(priority).toBeVisible();
        const original = await priority.inputValue();
        const changed = original === "5" ? "4" : "5";
        await priority.selectOption(changed);
        await page.getByRole("link", { name: "声音", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByRole("button", { name: "取消", exact: true }).click();
        await expect(priority).toHaveValue(changed);
        await page.getByRole("link", { name: "声音", exact: true }).click();
        await page
          .getByRole("button", { name: "放弃更改", exact: true })
          .click();
        await expect(page).toHaveURL(/settings\/sound$/);
        await page.getByRole("link", { name: "通知", exact: true }).click();
        await expect(priority).toHaveValue(original);
        await priority.selectOption(changed);
        await page.route("**/api/settings/notifications", (r) =>
          r.request().method() === "POST"
            ? r.fulfill({
                status: 503,
                contentType: "application/json",
                body: '{"detail":"controlled settings failure"}',
              })
            : r.continue(),
        );
        await page.getByRole("link", { name: "声音", exact: true }).click();
        await page
          .getByRole("button", { name: "保存后继续", exact: true })
          .click();
        await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
          "controlled settings failure",
        );
        assert.ok(!page.url().includes("/login"));
        await page.unroute("**/api/settings/notifications");
        await page
          .getByRole("button", { name: "保存后继续", exact: true })
          .click();
        await expect(page).toHaveURL(/settings\/sound$/);
        await expect(
          page.getByRole("button", { name: "试听网页声音" }),
        ).toBeEnabled();
        await page.getByRole("button", { name: "试听网页声音" }).click();
        await expect(page.getByRole("status")).toContainText("试听已播放");
        await page.getByRole("link", { name: "系统", exact: true }).click();
        await expect(
          page.getByRole("heading", { name: "后台运行状态" }),
        ).toBeVisible();
        await page.getByRole("link", { name: "账户", exact: true }).click();
        await expect(page.getByLabel("当前密码")).toBeVisible();
      },
    );
    await record(
      "dirty chart: cancel/discard/save, failed save, workspace and logout",
      async () => {
        await page.goto(base + "/advanced-charts/issue82-a");
        let { host, native } = await chart();
        assert.equal(await host.evaluate(() => autoSave.enabled), false);
        await host.evaluate(() =>
          widget
            .activeChart()
            .getTimeScale()
            .setRightOffset(
              widget.activeChart().getTimeScale().rightOffset() + 3,
            ),
        );
        await host.waitForFunction(() => dirty);
        await appNavigate("signals");
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByRole("button", { name: "取消", exact: true }).click();
        assert.equal(host.isDetached(), false);
        await page.route("**/api/advanced-charts/native-charts/save", (r) =>
          r.fulfill({
            status: 503,
            contentType: "application/json",
            body: '{"detail":"controlled workspace failure"}',
          }),
        );
        await appNavigate("signals");
        await page
          .getByRole("button", { name: "保存后继续", exact: true })
          .click();
        await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible({
          timeout: 20000,
        });
        assert.equal(host.isDetached(), false);
        await page.unroute("**/api/advanced-charts/native-charts/save");
        await page
          .getByRole("button", { name: "放弃更改", exact: true })
          .click();
        await expect(page).toHaveURL(/\/signals$/);
        await page.getByRole("link", { name: "返回图表" }).click();
        ({ host, native } = await chart());
        await host.evaluate(() =>
          widget
            .activeChart()
            .getTimeScale()
            .setRightOffset(
              widget.activeChart().getTimeScale().rightOffset() + 3,
            ),
        );
        await host.waitForFunction(() => dirty);
        await appNavigate("signals");
        await page
          .getByRole("button", { name: "保存后继续", exact: true })
          .click();
        await expect(page).toHaveURL(/\/signals$/, { timeout: 25000 });
        await page.getByRole("link", { name: "返回图表" }).click();
        ({ host, native } = await chart());
        await host.evaluate(() =>
          widget
            .activeChart()
            .getTimeScale()
            .setRightOffset(
              widget.activeChart().getTimeScale().rightOffset() + 3,
            ),
        );
        await host.waitForFunction(() => dirty);
        const switchWorkspace = () =>
          host.evaluate(async () => {
            const row = (
              await request({ op: "list", args: {} }, "workspace")
            ).find((r) => r.id === "issue82-b");
            globalThis.switchOutcome = "pending";
            widget
              .loadChartFromServer({
                id: row.id,
                name: row.name,
                image_url: "",
                modified_iso: row.timestamp,
                short_symbol: row.symbol,
                interval: row.resolution,
              })
              .then(
                () => (globalThis.switchOutcome = "loaded"),
                () => (globalThis.switchOutcome = "cancelled"),
              );
          });
        await switchWorkspace();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByRole("button", { name: "取消", exact: true }).click();
        await expect
          .poll(() => host.evaluate(() => globalThis.switchOutcome))
          .toBe("cancelled");
        await expect(page).toHaveURL(/issue82-a/);
        await switchWorkspace();
        await page
          .getByRole("button", { name: "放弃更改", exact: true })
          .click();
        await expect(page).toHaveURL(/issue82-b/);
        await chart();
        await host.evaluate(() =>
          widget
            .activeChart()
            .getTimeScale()
            .setRightOffset(
              widget.activeChart().getTimeScale().rightOffset() + 3,
            ),
        );
        await host.waitForFunction(() => dirty);
        await appNavigate("logout");
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByRole("button", { name: "取消", exact: true }).click();
        assert.equal(host.isDetached(), false);
      },
    );
    await record(
      "401: actual expired session preserves dirty chart and closes save dialog",
      async () => {
        await appNavigate("signals");
        const session = await api("/session");
        await page.route(
          "**/api/advanced-charts/native-charts/save",
          async (route) => {
            const logout = await context.request.post(base + "/api/logout", {
              headers: { "X-CSRF-Token": session.csrf },
              data: {},
            });
            assert.equal(logout.status(), 200);
            await route.continue();
          },
        );
        await page
          .getByRole("button", { name: "保存后继续", exact: true })
          .click();
        await expect(page.getByLabel("管理员密码")).toBeVisible({
          timeout: 20000,
        });
        await expect(page.getByRole("dialog")).toHaveCount(0);
        const drafts = await page.evaluate(() =>
          Object.keys(localStorage)
            .filter((k) => k.startsWith("mw-tv-draft:"))
            .map((k) => ({ key: k, value: JSON.parse(localStorage[k]) })),
        );
        assert.ok(
          drafts.some(
            (d) => d.value.engine === "tv31" && d.value.state?.charts?.length,
          ),
        );
        await page.unroute("**/api/advanced-charts/native-charts/save");
        await page.reload();
        await page.getByLabel("管理员密码").fill(password);
        await page.getByRole("button", { name: /登录并/ }).click();
        await expect(page).not.toHaveURL(/\/login/);
        const resumed = await chart();
        await expect
          .poll(() =>
            page.evaluate(() =>
              Object.keys(localStorage).some((k) =>
                k.startsWith("mw-tv-draft:"),
              ),
            ),
          )
          .toBe(true);
        const originalId = await page
          .locator("iframe[data-workspace-id]")
          .getAttribute("data-workspace-id");
        const original = await api("/advanced-charts/workspaces/" + originalId);
        const draft = drafts.find((d) => d.key === "mw-tv-draft:" + originalId);
        assert.ok(draft, "the restored workspace owns the captured layout");
        await resumed.native
          .getByRole("button", { name: "是", exact: true })
          .click();
        await expect
          .poll(
            () =>
              page
                .locator("iframe[data-workspace-id]")
                .getAttribute("data-workspace-id"),
            { timeout: 20000 },
          )
          .not.toBe(originalId);
        await chart();
        const copyId = await page
          .locator("iframe[data-workspace-id]")
          .getAttribute("data-workspace-id");
        const copy = await api("/advanced-charts/workspaces/" + copyId);
        assert.deepEqual(copy.document.state, draft.value.state);
        assert.deepEqual(
          (await api("/advanced-charts/workspaces/" + originalId)).document,
          original.document,
        );
        assert.equal(
          await page.evaluate((key) => localStorage.getItem(key), draft.key),
          null,
        );
      },
    );
  }
  if (suite === "all" || suite === "protocol") {
    await record(
      "protocol: API/device/action/MCP/health remain protocols; favicon and SPA routes",
      async () => {
        for (const route of [
          "/api",
          "/api/no-such-endpoint",
          "/api/device/sync",
          "/api/notification-actions/none/ack",
          "/mcp",
          "/mcp/unknown",
          "/assets/none.js",
          "/healthz",
          "/readyz",
        ]) {
          const r = await context.request.get(base + route);
          if (route.startsWith("/assets/")) {
            assert.equal(r.status(), 404);
            assert.ok(!(await r.text()).includes('id="root"'));
          } else
            assert.ok(
              !(r.headers()["content-type"] || "").includes("text/html"),
              route + " must not be SPA HTML",
            );
        }
        const icon = await context.request.get(base + "/favicon.svg");
        assert.equal(icon.status(), 200);
        assert.match(icon.headers()["content-type"], /svg/);
        const chartPage = await context.request.get(
          base + "/advanced-charts/issue82-a",
        );
        assert.match(await chartPage.text(), /favicon.svg/);
        const sse = await page.evaluate(async () => {
          const controller = new AbortController();
          try {
            const r = await fetch("/api/events", { signal: controller.signal });
            return { status: r.status, type: r.headers.get("Content-Type") };
          } finally {
            controller.abort();
          }
        });
        assert.equal(sse.status, 200);
        assert.match(sse.type, /text\/event-stream/);
      },
    );
  }
  assert.deepEqual(errors, [], "No uncaught application or iframe errors");
  await browser.close();
  console.log("RESULT", results.length, "checks passed");
})().catch(async (error) => {
  console.error(error);
  await browser?.close();
  process.exitCode = 1;
});
