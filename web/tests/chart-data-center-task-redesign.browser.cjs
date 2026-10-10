// Actual deployed native UI; task mutations/faults are confined to explicit fixtures.
const fs = require("node:fs"),
  path = require("node:path"),
  { expect } = require("@playwright/test"),
  f = require("./chart-data-center-fixture.cjs");
const out = path.join(f.root, "artifacts/native-indicators-tasks/tasks");
fs.mkdirSync(out, { recursive: true });
(async () => {
  const b = await f.launch(),
    p = await b.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    { host, native } = f.frames(p);
  const dc = () => native().locator(".dc-window"),
    rows = () => dc().locator(".dc-task-row"),
    panel = () => dc().locator(".dc-detail-panel");
  const report = {
    environment:
      "Ubuntu isolated Docker; deployed native UI; real task feed read and scoped task control/pagination fixtures",
    passed: false,
    checks: [],
    errors: [],
  };
  const record = (name) => {
    console.log("PASS", name);
    report.checks.push({ name });
  };
  let workspace,
    hold = () => {},
    releaseControl = () => {};
  const get = async (route) => {
    const r = await p.request.get(f.base + "/api" + route);
    expect(r.ok()).toBe(true);
    return r.json();
  };
  const open = async () => {
    await host().evaluate(() => dataCenter.open("/market-data?tab=tasks"));
    await expect(dc()).toBeVisible();
  };
  const close = async () => {
    await native()
      .getByRole("button", { name: "关闭数据中心", exact: true })
      .click();
    await expect(dc()).toHaveCount(0);
  };
  try {
    await p.goto(f.base + "/advanced-charts");
    await f.login(p);
    const { csrf } = await get("/session");
    const created = await p.request.post(
      f.base + "/api/advanced-charts/workspaces",
      {
        data: { name: "任务页改版验收", symbol: "MWP:EURUSD" },
        headers: { "X-CSRF-Token": csrf },
      },
    );
    expect(created.ok()).toBe(true);
    workspace = await created.json();
    await p.goto(f.base + "/advanced-charts");
    await expect.poll(() => !!native(), { timeout: 30000 }).toBe(true);
    await host().waitForFunction(
      () => ready && dataCenter && widget.activeChart().dataReady(),
      null,
      { timeout: 60000 },
    );
    p.on("pageerror", (e) => report.errors.push(e.message));
    const baseline = await host().evaluate(() => ({
      symbol: widget.activeChart().symbol(),
      epoch: workspaceEpoch,
    }));
    const real = await get(
      "/market-data/center/task-feed?status=all&page_size=2",
    );
    expect(Array.isArray(real.items)).toBe(true);
    expect(typeof real.snapshot).toBe("number");
    await open();
    await expect(
      dc().getByRole("heading", { name: "任务与记录", exact: true }),
    ).toBeVisible();
    await expect(
      dc().getByRole("searchbox", { name: "搜索品种", exact: true }),
    ).toBeVisible();
    await expect(
      dc().getByRole("button", { name: "当前任务", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      await dc().getByRole("navigation", { name: "列表分页" }).count(),
    ).toBe(0);
    await close();
    record(
      "real deployed task feed and native title/search/status tabs/source Select replace old filter and pager",
    );
    const managed = await get("/market-data/center/datasets?page_size=1"),
      d = managed.items[0];
    expect(d).toBeTruthy();
    const stamp = 1700000000000;
    const tasks = Array.from({ length: 70 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
      dataset_id: d.id,
      dataset: {
        ...d,
        display_symbol: `任务品种-${String(i).padStart(2, "0")}`,
      },
      start: stamp,
      end: stamp + 600000,
      cursor: stamp + 180000,
      created_at: stamp - i * 60000,
      started_at: stamp,
      updated_at: stamp + 120000,
      completed_at: null,
      next_at: stamp + 360000,
      status:
        i === 1
          ? "paused"
          : i === 2
            ? "configuration_error"
            : i === 3
              ? "retrying"
              : "running",
      desired_state: i === 1 ? "paused" : "running",
      task_kind: "recheck",
      controllable: true,
      error: i === 2 ? "unauthorized" : i === 3 ? "rate_limited" : undefined,
    }));
    const requests = [];
    let failNext = false,
      newCount = 0,
      delayNext = false;
    const pattern = "**/api/market-data/center/task-feed?*";
    const feed = async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      if (delayNext && !url.searchParams.has("ids")) {
        delayNext = false;
        await new Promise((resolve) => (hold = resolve));
      }
      if (url.searchParams.has("ids"))
        return route.fulfill({
          json: {
            items: url.searchParams
              .get("ids")
              .split(",")
              .map((id) => tasks.find((t) => t.id === id))
              .filter(Boolean),
          },
        });
      if (failNext && url.searchParams.has("before")) {
        failNext = false;
        return route.fulfill({
          status: 503,
          json: { detail: "fixture continuation failed" },
        });
      }
      const query = url.searchParams.get("query") || "",
        source = url.searchParams.get("source") || "";
      let filtered =
        source && source !== d.identity.source
          ? []
          : tasks.filter((t) => t.dataset.display_symbol.includes(query));
      let offset = 0;
      if (url.searchParams.has("before")) {
        const id = url.searchParams.get("before").split(":")[1];
        offset = filtered.findIndex((t) => t.id === id) + 1;
      }
      const count = Number(url.searchParams.get("page_size") || 25),
        items = filtered.slice(offset, offset + count);
      return route.fulfill({
        json: {
          items,
          total: filtered.length,
          snapshot: stamp + 60000,
          next_cursor:
            offset + count < filtered.length
              ? `${items.at(-1).created_at}:${items.at(-1).id}`
              : null,
          new_count: newCount,
        },
      });
    };
    await p.route(pattern, feed);
    await open();
    await dc().getByRole("button", { name: "刷新列表", exact: true }).click();
    await expect(rows()).toHaveCount(25);
    expect(requests.every((q) => !q.includes("page="))).toBe(true);
    await rows().first().getByRole("button", { name: "查看任务详情" }).click();
    await expect(panel()).toContainText("固定开始");
    await expect(panel()).toContainText("时间记录");
    await expect(
      panel().getByRole("link", { name: "查看行情管理" }),
    ).toBeVisible();
    await p.keyboard.press("Escape");
    await expect(panel()).toHaveCount(0);
    await expect(
      rows().first().getByRole("button", { name: "查看任务详情" }),
    ).toBeFocused();
    record(
      "compact rows open complete task detail in one panel; Escape preserves list and trigger focus",
    );
    const list = dc().locator(".dc-market-list");
    failNext = true;
    await list.evaluate((n) => (n.scrollTop = n.scrollHeight));
    await expect(
      dc().getByRole("button", { name: "重试", exact: true }),
    ).toBeVisible();
    await expect(rows()).toHaveCount(25);
    await dc().getByRole("button", { name: "重试", exact: true }).click();
    await expect(rows()).toHaveCount(50);
    await list.evaluate((n) => (n.scrollTop = n.scrollHeight));
    await expect(rows()).toHaveCount(70);
    expect(
      await rows().evaluateAll((nodes) => new Set(nodes.map((n) => n.id)).size),
    ).toBe(70);
    record(
      "keyset scrolling loads 70 unique tasks; continuation failure retains rows and retry completes without pager",
    );
    const ids = await rows().evaluateAll((nodes) => nodes.map((n) => n.id));
    const scroll = await list.evaluate((n) => n.scrollTop);
    tasks[0].status = "published";
    tasks[0].controllable = false;
    tasks[0].completed_at = stamp + 240000;
    newCount = 1;
    await expect(
      dc().getByRole("button", { name: "刷新查看", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    expect(await rows().evaluateAll((nodes) => nodes.map((n) => n.id))).toEqual(
      ids,
    );
    expect(await list.evaluate((n) => n.scrollTop)).toBe(scroll);
    await expect(rows().first()).toContainText("已发布");
    record(
      "ID polling updates completed state in place; new records prompt refresh without reorder or scroll jumps",
    );
    await list.evaluate((n) => (n.scrollTop = 0));
    const actions = [];
    let actionFailure = false,
      delayControl = false;
    const control = async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-2),
        action = route.request().postDataJSON().action;
      actions.push({ id, action });
      if (delayControl) {
        delayControl = false;
        await new Promise((resolve) => (releaseControl = resolve));
      }
      if (actionFailure) {
        actionFailure = false;
        return route.fulfill({
          status: 409,
          json: { detail: "fixture task state conflict" },
        });
      }
      const task = tasks.find((t) => t.id === id);
      task.desired_state = {
        pause: "paused",
        resume: "running",
        cancel: "cancelled",
        retry: "running",
      }[action];
      task.status = {
        pause: "paused",
        resume: "pending",
        cancel: "cancelled",
        retry: "pending",
      }[action];
      task.controllable = task.status !== "cancelled";
      return route.fulfill({ json: task });
    };
    await p.route("**/api/market-data/tasks/*/control", control);
    delayControl = true;
    const running = rows().nth(4);
    await running
      .getByRole("button", { name: "暂停任务", exact: true })
      .click();
    await running.getByRole("button", { name: "查看任务详情" }).click();
    await expect(
      panel().getByRole("button", { name: "正在提交…", exact: true }),
    ).toBeDisabled();
    await expect(
      rows().nth(5).getByRole("button", { name: "暂停任务", exact: true }),
    ).toBeEnabled();
    expect(actions.filter((action) => action.id === tasks[4].id).length).toBe(
      1,
    );
    releaseControl();
    await expect(
      panel().getByRole("button", { name: "恢复任务", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await p.keyboard.press("Escape");
    record(
      "held task mutation shares busy state between row/detail, prevents duplicates and leaves other rows enabled",
    );
    const paused = rows().nth(1);
    await paused.getByRole("button", { name: "恢复任务", exact: true }).click();
    await expect(
      paused.getByRole("button", { name: "暂停任务", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await paused.getByRole("button", { name: "暂停任务", exact: true }).click();
    await expect(
      paused.getByRole("button", { name: "恢复任务", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await paused.getByRole("button", { name: "查看任务详情" }).click();
    await panel()
      .getByRole("button", { name: "取消任务", exact: true })
      .click();
    expect(actions.some((a) => a.action === "cancel")).toBe(false);
    await panel()
      .getByRole("button", { name: "保留任务", exact: true })
      .click();
    await panel()
      .getByRole("button", { name: "取消任务", exact: true })
      .click();
    await panel()
      .getByRole("button", { name: "确认取消任务", exact: true })
      .click();
    await expect(panel()).toContainText("此记录已结束", { timeout: 15000 });
    await p.keyboard.press("Escape");
    record(
      "resume/pause follow server state; cancellation is detail-only with keep/cancel confirmation and ended record retained",
    );
    const retry = rows().nth(3);
    actionFailure = true;
    await retry
      .getByRole("button", { name: "重试失败范围", exact: true })
      .click();
    await expect(retry.getByRole("alert")).toContainText("conflict");
    await retry
      .getByRole("button", { name: "重试失败范围", exact: true })
      .click();
    await expect(
      retry.getByRole("button", { name: "暂停任务", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await rows().nth(2).getByRole("button", { name: "查看任务详情" }).click();
    await expect(panel()).toContainText("来源授权失败");
    await panel()
      .getByRole("button", { name: "技术错误详情", exact: true })
      .click();
    await expect(panel()).toContainText("unauthorized");
    await expect(panel()).toContainText("连接由管理员在部署配置中维护");
    await expect(panel().locator('a[href*="tab=sources"]')).toHaveCount(0);
    await p.keyboard.press("Escape");
    record(
      "retry failure remains local and can retry; configuration errors expose safe reason and inline handling instructions without deleted-page links",
    );
    delayNext = true;
    const query = dc().getByRole("searchbox", {
      name: "搜索品种",
      exact: true,
    });
    await query.fill("任务品种-0");
    await expect
      .poll(() =>
        requests.some((q) => decodeURIComponent(q).includes("任务品种-0")),
      )
      .toBe(true);
    await query.fill("任务品种-69");
    hold();
    await expect(rows()).toHaveCount(1);
    await expect(rows().first()).toContainText("任务品种-69");
    await query.fill("");
    await expect(rows()).toHaveCount(25);
    await dc().getByRole("button", { name: "来源", exact: true }).click();
    const absent = d.identity.source === "yahoo" ? "Binance" : "Yahoo";
    await native().getByRole("option", { name: absent, exact: true }).click();
    await expect(rows()).toHaveCount(0);
    await dc().getByRole("button", { name: "来源", exact: true }).click();
    await native()
      .getByRole("option", { name: "全部来源", exact: true })
      .click();
    await expect(rows()).toHaveCount(25);
    record(
      "search and source reset feed; held stale response cannot overwrite later query and empty state remains clear",
    );
    await dc().getByRole("button", { name: "刷新列表", exact: true }).click();
    await expect(rows()).toHaveCount(25);
    await list.evaluate((n) => (n.scrollTop = n.scrollHeight));
    await expect(rows()).toHaveCount(50);
    const deep = rows().nth(40);
    await deep.getByRole("button", { name: "查看任务详情" }).click();
    await panel()
      .getByRole("link", { name: "查看行情管理", exact: true })
      .click();
    await expect(
      dc().getByRole("heading", { name: "任务与记录", exact: true }),
    ).toHaveCount(0);
    await dc()
      .getByRole("link", { name: "返回数据中心列表", exact: true })
      .click();
    await expect(rows()).toHaveCount(50);
    await expect(rows().nth(40)).toBeInViewport();
    record(
      "full management round trip restores loaded task prefix, exact task row and browsing context",
    );
    await close();
    for (const theme of ["Dark", "Light"]) {
      await host().evaluate((theme) => widget.changeTheme(theme), theme);
      for (const width of [1440, 768, 375]) {
        await p.setViewportSize({ width, height: 900 });
        await open();
        // Reopening restores the loaded prefix; explicitly refresh for layout checks.
        await dc()
          .getByRole("button", { name: "刷新列表", exact: true })
          .click();
        await expect(rows()).toHaveCount(25);
        await expect(
          dc().getByRole("button", { name: "来源", exact: true }),
        ).toBeInViewport();
        expect(
          await dc()
            .locator(".dc-window-content")
            .evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
        ).toBe(true);
        await p.screenshot({
          path: path.join(out, `list-${theme.toLowerCase()}-${width}.png`),
        });
        await rows()
          .first()
          .getByRole("button", { name: "查看任务详情" })
          .click();
        await expect(panel()).toBeInViewport();
        expect(
          await panel().evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
        ).toBe(true);
        if (width < 1000)
          for (const key of ["Tab", "Shift+Tab"])
            for (let i = 0; i < 5; i++) {
              await p.keyboard.press(key);
              expect(
                await native().evaluate(
                  () => !!document.activeElement.closest(".dc-detail-panel"),
                ),
              ).toBe(true);
            }
        await p.screenshot({
          path: path.join(out, `tasks-${theme.toLowerCase()}-${width}.png`),
        });
        await p.keyboard.press("Escape");
        await close();
      }
    }
    record(
      "dark/light desktop/tablet/375px keep source, rows and details reachable; no overflow and detail Tab/Escape restore focus",
    );
    expect(
      await host().evaluate(() => ({
        symbol: widget.activeChart().symbol(),
        epoch: workspaceEpoch,
      })),
    ).toEqual(baseline);
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    await p.screenshot({ path: path.join(out, "failed.png") }).catch(() => {});
    throw error;
  } finally {
    hold();
    releaseControl();
    if (workspace) {
      const before = await get("/advanced-charts/workspaces"),
        owned = before.find((row) => row.id === workspace.id);
      if (owned) {
        const { csrf } = await get("/session"),
          deleted = await p.request.post(
            f.base + "/api/advanced-charts/workspaces/" + owned.id + "/delete",
            {
              data: { revision: owned.revision },
              headers: { "X-CSRF-Token": csrf },
            },
          );
        expect(deleted.ok()).toBe(true);
        const after = await get("/advanced-charts/workspaces");
        expect(after.map((row) => row.id).sort()).toEqual(
          before
            .filter((row) => row.id !== owned.id)
            .map((row) => row.id)
            .sort(),
        );
        report.cleanup = { onlyOwnedWorkspaceDeleted: true };
      }
    }
    fs.writeFileSync(
      path.join(out, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await b.close();
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
