/**
 * Issue #75 acceptance: unified notification center.
 *
 * Runs against an isolated Ubuntu Docker stack. Authenticates through the real
 * login form, exercises the parent-page entry, the anchored bubble, the
 * paginated center, observations, offline intake and the degraded chart shell.
 *
 * Environment:
 *   MW_ACCEPTANCE_URL       default http://127.0.0.1:18176
 *   MW_ACCEPTANCE_PASSWORD  required (read from the private env file by the runner)
 *   MW_EVIDENCE_DIR         default docs/verification/unified-notifications-20261017
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium, expect } = require("@playwright/test");

const BASE = (process.env.MW_ACCEPTANCE_URL || "http://127.0.0.1:18176").replace(/\/$/, "");
const PASSWORD = process.env.MW_ACCEPTANCE_PASSWORD || "";
const EVIDENCE = path.resolve(
  process.env.MW_EVIDENCE_DIR || "docs/verification/unified-notifications-20261017");
const SHOTS = path.join(EVIDENCE, "screenshots");
const CHROME = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const results = [];
const pageErrors = [];

async function check(id, title, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ id, title, ok: true, ms: Date.now() - started, detail });
    console.log(`PASS ${id} ${title}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    results.push({ id, title, ok: false, ms: Date.now() - started, error: String(error) });
    console.log(`FAIL ${id} ${title} — ${error}`);
  }
}

async function login(page) {
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".sidebar, input[type=password]", { timeout: 20000 });
  if (await page.locator(".sidebar").isVisible().catch(() => false)) {
    await expect(page.getByTestId("notification-entry")).toBeVisible();
    return;
  }
  await page.getByLabel("管理员密码").fill(PASSWORD);
  const login = page.waitForResponse((response) => response.url().endsWith("/api/login"));
  await page.getByRole("button", { name: "登录工作台" }).click();
  expect((await login).status()).toBe(200);
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.getByTestId("notification-entry")).toBeVisible();
}

async function openCenter(page) {
  const panel = page.getByTestId("notification-panel");
  if (await panel.count()) return;
  await page.getByTestId("notification-entry").click({ force: true });
  await expect(panel).toBeVisible({ timeout: 10000 });
}

async function dismissBubbles(page) {
  const close = page.getByRole("button", { name: "关闭提示" });
  while (await close.count()) await close.first().click();
}

async function closeCenter(page) {
  await page.getByRole("button", { name: "关闭通知中心" }).click();
  await expect(page.getByTestId("notification-panel")).toHaveCount(0);
}

async function report(page, payload) {
  return page.evaluate((body) => window.MWNotificationCenter.report(body), payload);
}

async function state(page) {
  return page.evaluate(() => window.MWNotificationCenter.getState());
}

async function api(page, requestPath) {
  return page.evaluate(async (target) => {
    const response = await fetch(`/api${target}`, { credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  }, requestPath);
}

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

async function waitForEvent(page, title) {
  return expect.poll(async () => {
    const pageState = await state(page);
    return pageState.items.some((item) => item.title === title);
  }, { timeout: 15000 }).toBe(true);
}

async function main() {
  if (!PASSWORD) throw new Error("MW_ACCEPTANCE_PASSWORD is required");
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await login(page);

    await check("A1.entry", "父页面顶部有唯一通知入口与未读角标", async () => {
      const entries = await page.getByTestId("notification-entry").count();
      expect(entries).toBe(1);
      const label = await page.getByTestId("notification-entry").getAttribute("aria-label");
      expect(label).toContain("通知中心");
      const unread = (await state(page)).unread;
      if (unread > 0) await expect(page.getByTestId("notification-badge")).toBeVisible();
      await shot(page, "a1-entry");
      return `entry=1 unread=${unread}`;
    });

    await check("A1.single-bubble", "一次发生只出现一个锚定气泡，不四角堆叠", async () => {
      await report(page, {
        kind: "failure", severity: "warning",
        title: `验收气泡 ${Date.now()}`,
        summary: "单条锚定气泡，不改变图表高度。",
        dedupe_key: "acceptance:bubble",
      });
      await expect(page.getByTestId("notification-bubble")).toBeVisible();
      expect(await page.getByTestId("notification-bubble").count()).toBe(1);
      await shot(page, "a1-bubble");
      await page.getByRole("button", { name: "关闭提示" }).click();
      await expect(page.getByTestId("notification-bubble")).toHaveCount(0);
      return "bubble=1";
    });

    await check("A2.api-pagination", "稳定分页可连续读取超过 500 条", async () => {
      const outcome = await page.evaluate(async () => {
        let before = null;
        const seen = new Set();
        let pages = 0;
        for (let index = 0; index < 12; index += 1) {
          const query = new URLSearchParams({ limit: "100" });
          if (before) query.set("before", before);
          const response = await fetch(`/api/notification-center/events?${query}`,
            { credentials: "same-origin" });
          const body = await response.json();
          body.items.forEach((item) => seen.add(item.id));
          pages += 1;
          before = body.next_before;
          if (!before) break;
        }
        return { count: seen.size, pages };
      });
      expect(outcome.count).toBeGreaterThan(500);
      expect(outcome.pages).toBeGreaterThanOrEqual(6);
      return `${outcome.count} events / ${outcome.pages} pages`;
    });

    await check("A2.filters", "类型/级别筛选与关键词过滤生效", async () => {
      await openCenter(page);
      await page.getByLabel("按类型筛选").selectOption("alert");
      await expect.poll(async () => (await state(page)).items.every((item) => item.kind === "alert"))
        .toBe(true);
      const alertCount = (await state(page)).items.length;
      await page.getByLabel("搜索通知").fill("验收规则");
      await expect.poll(async () => {
        const items = (await state(page)).items;
        return items.length > 0 && items.every((item) => /验收规则/.test(item.title));
      }, { timeout: 15000 }).toBe(true);
      await page.getByLabel("按类型筛选").selectOption("");
      await page.getByLabel("搜索通知").fill("");
      await closeCenter(page);
      return `alerts=${alertCount}`;
    });

    await check("A2.window-pagination", "中心列表在内存预算内翻页而不无限增长", async () => {
      await openCenter(page);
      const before = (await state(page)).items.length;
      const more = page.getByTestId("notification-more");
      if (await more.count()) {
        await more.click();
        await expect.poll(async () => (await state(page)).items.length).toBeGreaterThan(0);
      }
      const after = (await state(page)).items.length;
      expect(after).toBeLessThanOrEqual(200);
      await closeCenter(page);
      return `items ${before}→${after}`;
    });

    await check("A3.detail-timeline", "详情显示稳定 ID、来源、本地/UTC 时间与观察时间线", async () => {
      const title = `验收详情 ${Date.now()}`;
      await report(page, { kind: "failure", severity: "warning", title,
        summary: "详情时间线验收", dedupe_key: "acceptance:detail" });
      await waitForEvent(page, title);
      await openCenter(page);
      await page.getByTestId("notification-item").filter({ hasText: title }).first().click();
      const detail = page.getByTestId("notification-detail");
      await expect(detail).toBeVisible();
      await expect(detail).toContainText("事件 ID");
      await expect(detail).toContainText("UTC");
      await expect(page.getByTestId("notification-timeline")).toContainText("原始发生");
      await expect(page.getByTestId("notification-timeline")).toContainText("服务器记录");
      await shot(page, "a3-detail");
      const before = await state(page);
      const item = before.items.find((row) => row.title === title);
      expect(item.read).toBe(true);
      return `event=${item.id}`;
    });

    await check("A4.alert-evidence", "告警详情保留实际值/阈值/规则版本/图表代次", async () => {
      await page.getByRole("button", { name: "返回通知列表" }).click();
      await page.getByLabel("按类型筛选").selectOption("alert");
      await expect.poll(async () => (await state(page)).items[0]?.kind, { timeout: 15000 })
        .toBe("alert");
      await page.getByTestId("notification-item").first().click();
      const detail = page.getByTestId("notification-detail");
      await expect(detail).toContainText("实际值");
      await expect(detail).toContainText("阈值");
      await expect(detail).toContainText("规则版本");
      await expect(detail).toContainText("图表代次");
      await shot(page, "a4-alert-detail");
      await page.getByRole("button", { name: "返回通知列表" }).click();
      await page.getByLabel("按类型筛选").selectOption("");
      await closeCenter(page);
      return "evidence fields present";
    });

    await check("A5.channels", "网页、手机接受与设备回执分别记录", async () => {
      const outcome = await page.evaluate(async () => {
        const response = await fetch("/api/notification-center/events?limit=100",
          { credentials: "same-origin" });
        const body = await response.json();
        const alert = body.items.find((item) =>
          (item.context?.channels || []).some((channel) => channel.channel === "device"));
        if (!alert) return null;
        const detail = await fetch(`/api/notification-center/events/${encodeURIComponent(alert.id)}`,
          { credentials: "same-origin" }).then((row) => row.json());
        return {
          id: alert.id,
          channels: alert.context.channels,
          observations: detail.observations.map((row) => row.kind),
        };
      });
      expect(outcome).not.toBeNull();
      const kinds = outcome.channels.map((channel) => channel.channel);
      expect(kinds).toContain("ntfy");
      expect(kinds).toContain("device");
      expect(outcome.channels.find((channel) => channel.channel === "ntfy").status)
        .toBe("accepted");
      return `channels=${kinds.join(",")}`;
    });

    await check("A6.incident-grouping", "同一事故保留逐次发生并显示计数", async () => {
      const outcome = await page.evaluate(async () => {
        const response = await fetch("/api/notification-center/events?limit=100",
          { credentials: "same-origin" });
        const body = await response.json();
        return body.items.filter((item) => item.incident && item.incident.count >= 3).length;
      });
      expect(outcome).toBeGreaterThan(0);
      return `grouped=${outcome}`;
    });

    await check("A7.success-short", "普通成功短提示且可回查", async () => {
      await dismissBubbles(page);
      const title = `保存成功 ${Date.now()}`;
      await report(page, { kind: "success", severity: "info", title,
        summary: "普通成功只做短提示", dedupe_key: "acceptance:success" });
      await expect(page.getByTestId("notification-bubble")).toBeVisible();
      await waitForEvent(page, title);
      await openCenter(page);
      await page.getByLabel("按类型筛选").selectOption("success");
      await expect(page.getByTestId("notification-item").filter({ hasText: title }).first())
        .toBeVisible();
      await page.getByLabel("按类型筛选").selectOption("");
      await closeCenter(page);
      return "success retained";
    });

    await check("A10.offline-intake", "离线通知立即展示、本机待同步，恢复后幂等补传", async () => {
      const offline = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const tab = await offline.newPage();
      tab.on("pageerror", (error) => pageErrors.push(String(error)));
      await login(tab);
      await offline.setOffline(true);
      const title = `离线故障 ${Date.now()}`;
      await report(tab, { kind: "failure", severity: "critical", title,
        summary: "离线期间产生的故障", dedupe_key: "acceptance:offline" });
      await expect(tab.getByTestId("notification-bubble")).toBeVisible();
      await expect.poll(async () => (await state(tab)).pending).toBeGreaterThan(0);
      await shot(tab, "a10-offline");
      await offline.setOffline(false);
      await expect.poll(async () => (await state(tab)).pending, { timeout: 30000 }).toBe(0);
      await tab.reload();
      await expect(tab.getByTestId("notification-entry")).toBeVisible();
      await openCenter(tab);
      await expect(tab.getByTestId("notification-item").filter({ hasText: title }).first())
        .toBeVisible();
      await closeCenter(tab);
      await offline.close();
      return "pending drained after reconnect";
    });

    await check("A14.read-vs-phone", "网页已读不停止手机；显式停止才写旧确认", async () => {
      const outcome = await page.evaluate(async () => {
        const response = await fetch("/api/notification-center/events?limit=100",
          { credentials: "same-origin" });
        const body = await response.json();
        const target = body.items.find((item) =>
          item.kind === "alert" && item.actions?.phone_stop && !item.context?.phone_stopped_at);
        return target ? { id: target.id, notification_id: target.notification_id } : null;
      });
      expect(outcome).not.toBeNull();
      await page.evaluate((id) =>
        window.MWNotificationCenter.observe(id, "viewed", { profile_id: "acceptance" }), outcome.id);
      const detail = await api(page, `/notification-center/events/${encodeURIComponent(outcome.id)}`);
      expect(detail.body.event.context?.phone_stopped_at).toBeUndefined();
      await page.evaluate((id) =>
        window.MWNotificationCenter.observe(id, "phone_stop"), outcome.id);
      await expect.poll(async () => {
        const row = await api(page, `/notification-center/events/${encodeURIComponent(outcome.id)}`);
        return Boolean(row.body.event.context?.phone_stopped_at);
      }).toBe(true);
      return `event=${outcome.id}`;
    });

    await check("A15.chart-fallback", "图表宿主不可用时父页面入口仍可查看记录", async () => {
      const blocked = await browser.newContext({ viewport: { width: 1500, height: 900 } });
      const tab = await blocked.newPage();
      tab.on("pageerror", (error) => pageErrors.push(String(error)));
      await tab.route("http://127.0.0.1:18177/**", (route) => route.abort());
      await login(tab);
      await tab.goto(`${BASE}/advanced-charts`);
      await expect(tab.getByTestId("notification-entry")).toBeVisible();
      await openCenter(tab);
      await expect(tab.getByTestId("notification-panel")).toBeVisible();
      await expect(tab.getByTestId("notification-item").first()).toBeVisible();
      await shot(tab, "a15-fallback");
      await closeCenter(tab);
      await blocked.close();
      return "fallback entry usable";
    });

    await check("A16.shared-sound", "双标签页共享声音预留，自动尝试至多一次", async () => {
      const shared = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await shared.addInitScript(() => localStorage.setItem("mw-notification-sound", "1"));
      const first = await shared.newPage();
      const second = await shared.newPage();
      [first, second].forEach((tab) =>
        tab.on("pageerror", (error) => pageErrors.push(String(error))));
      await login(first);
      await login(second);
      const title = `共享声音 ${Date.now()}`;
      await report(first, { kind: "failure", severity: "critical", title,
        summary: "两个标签页共享一次自动尝试", dedupe_key: "acceptance:sound" });
      await waitForEvent(second, title);
      await expect.poll(async () => {
        const outcome = await second.evaluate(async (target) => {
          const list = await fetch("/api/notification-center/events?limit=100",
            { credentials: "same-origin" }).then((row) => row.json());
          const event = list.items.find((item) => item.title === target);
          if (!event) return null;
          const detail = await fetch(`/api/notification-center/events/${encodeURIComponent(event.id)}`,
            { credentials: "same-origin" }).then((row) => row.json());
          return detail.observations.filter((row) => row.kind === "sound_reserved").length;
        }, title);
        return outcome;
      }, { timeout: 20000 }).toBe(1);
      await shared.close();
      return "sound_reserved=1";
    });

    await check("A13.reconnect-poll", "断线重连后仅靠补拉也能收敛到新事件", async () => {
      const pair = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      const stable = await pair.newPage();
      const writer = await pair.newPage();
      [stable, writer].forEach((tab) =>
        tab.on("pageerror", (error) => pageErrors.push(String(error))));
      await login(stable);
      await login(writer);
      await pair.setOffline(true);
      // The stable tab loses SSE; the writer stays local but cannot upload.
      const title = `重连收敛 ${Date.now()}`;
      await writer.evaluate((body) => window.MWNotificationCenter.report(body), {
        kind: "failure", severity: "warning", title, dedupe_key: "acceptance:reconnect",
      });
      await pair.setOffline(false);
      await expect.poll(async () => (await state(stable)).connection, { timeout: 30000 })
        .not.toBe("offline");
      await expect.poll(async () => {
        const current = await state(writer);
        return current.pending === 0 && current.items.some((item) => item.title === title);
      }, { timeout: 30000 }).toBe(true);
      await pair.close();
      return "writer pending drained, stable tab online";
    });

    await check("A17.sound-blocked", "声音未解锁时记录 blocked 而不是假装已响", async () => {
      const title = `静音故障 ${Date.now()}`;
      await page.evaluate(async (body) => {
        await window.MWNotificationCenter.report(body);
      }, { kind: "failure", severity: "critical", title, dedupe_key: "acceptance:blocked" });
      await waitForEvent(page, title);
      await expect.poll(async () => {
        const kinds = await page.evaluate(async (target) => {
          const list = await fetch("/api/notification-center/events?limit=100",
            { credentials: "same-origin" }).then((row) => row.json());
          const event = list.items.find((item) => item.title === target);
          if (!event) return [];
          const detail = await fetch(`/api/notification-center/events/${encodeURIComponent(event.id)}`,
            { credentials: "same-origin" }).then((row) => row.json());
          return detail.observations.map((row) => row.kind);
        }, title);
        return kinds.includes("sound_blocked");
      }, { timeout: 15000 }).toBe(true);
      return "sound_blocked recorded";
    });

    await check("A17.sound-expired", "超过 30 秒的事件不再补响，记录 expired", async () => {
      const title = `过期声音 ${Date.now()}`;
      await page.evaluate((body) => window.MWNotificationCenter.report(body),
        { kind: "failure", severity: "critical", title, dedupe_key: "acceptance:expired" });
      await waitForEvent(page, title);
      await page.waitForTimeout(31_000);
      const outcome = await page.evaluate(async (target) => {
        const current = window.MWNotificationCenter.getState();
        const event = current.items.find((item) => item.title === target);
        return window.MWNotificationCenter.soundAttempt(event.id);
      }, title);
      expect(outcome).toBe("expired");
      return outcome;
    });

    await check("A18.cross-instrument", "跨品种同名故障不混为同一事故", async () => {
      const groups = await page.evaluate(async () => {
        const body = await fetch("/api/notification-center/events?limit=100&q="
          + encodeURIComponent("验收规则 acc-cross"), { credentials: "same-origin" })
          .then((row) => row.json());
        return body.items.map((item) => ({
          instrument: item.context?.instrument,
          incident: item.incident_id,
        }));
      });
      const instruments = new Set(groups.map((row) => row.instrument));
      const incidents = new Set(groups.map((row) => row.incident));
      expect(instruments.size).toBeGreaterThanOrEqual(2);
      expect(incidents.size).toBeGreaterThanOrEqual(2);
      return `${instruments.size} instruments / ${incidents.size} incidents`;
    });

    await check("A19.storm", "突发故障不阻塞中心打开，内存有界", async () => {
      const started = Date.now();
      await page.evaluate(async () => {
        const reports = Array.from({ length: 40 }, (_, index) =>
          window.MWNotificationCenter.report({
            kind: "failure", severity: index % 10 === 0 ? "critical" : "warning",
            title: `风暴 ${index}`, summary: "批量故障注入",
            dedupe_key: `acceptance:storm:${index % 4}`,
          }));
        await Promise.all(reports);
      });
      await openCenter(page);
      await expect(page.getByTestId("notification-list")).toBeVisible();
      const elapsed = Date.now() - started;
      const current = await state(page);
      expect(current.items.length).toBeLessThanOrEqual(200);
      expect(current.connection).not.toBe("offline");
      await shot(page, "a19-storm");
      await closeCenter(page);
      return `40 reports in ${elapsed}ms, items=${current.items.length}`;
    });

    await check("A20.keyboard", "Escape 关闭面板且焦点回到入口", async () => {
      const entry = page.getByTestId("notification-entry");
      await entry.focus();
      await entry.click();
      await expect(page.getByTestId("notification-panel")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("notification-panel")).toHaveCount(0);
      expect(await entry.evaluate((node) => node === document.activeElement
        || node.contains(document.activeElement))).toBe(true);
      return "escape closes and focus returns";
    });

    expect(pageErrors, `page errors: ${pageErrors.join("\n")}`).toEqual([]);
    await context.close();
  } finally {
    await browser.close();
  }

  const summary = {
    base: BASE,
    at: new Date().toISOString(),
    passed: results.filter((row) => row.ok).length,
    failed: results.filter((row) => !row.ok).length,
    results,
    pageErrors,
  };
  fs.writeFileSync(path.join(EVIDENCE, "playwright-results.json"),
    JSON.stringify(summary, null, 2));
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  if (summary.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
