const assert = require("node:assert/strict"),
  vm = require("node:vm"),
  { build } = require("esbuild");
(async () => {
  const bundle = await build({
    entryPoints: ["src/mobile/alertView.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "View",
    platform: "browser",
  });
  const scope = { console, Date };
  vm.createContext(scope);
  vm.runInContext(bundle.outputFiles[0].text, scope);
  const { ruleState, eventHandled, monitorState, ruleProgress } = scope.View;
  const now = 1000000;
  const check = (chart_alerts) =>
    monitorState({ chart_alerts }, true, now, true, now);
  assert.equal(
    check({ enabled: true, loop: { state: "idle" } }).verified,
    false,
    "HTTP success without heartbeat does not prove a running monitor",
  );
  const absent = check({
    enabled: false,
    loop: { state: "unknown" },
    runtime_roles: [{ role: "chart_alert", state: "missing" }],
  });
  assert.equal(
    ruleState({ status: "active" }, absent, now).label,
    "服务未开启",
  );
  assert.equal(
    ruleState(
      { status: "active" },
      check({ enabled: true, loop: { state: "stale" } }),
      now,
    ).label,
    "监控已中断",
  );
  assert.equal(
    ruleState(
      { status: "active" },
      monitorState({}, false, now, true, now),
      now,
    ).label,
    "离线待确认",
  );
  const healthy = check({
    enabled: true,
    loop: { state: "idle", heartbeat_at: now },
  });
  assert.equal(
    ruleProgress({
      activity: { last_evaluated_at: now, last_outcome: "seam_baseline" },
    }).label,
    "基准已建立",
  );
  assert.equal(
    ruleState(
      {
        status: "active",
        health: "ready",
        runtime: { closed: true },
        activity: { last_checked_at: now },
      },
      healthy,
      now,
    ).label,
    "休市",
  );
  assert.equal(
    ruleState(
      {
        status: "active",
        health: "ready",
        activity: { last_checked_at: now - 61000 },
      },
      healthy,
      now,
    ).label,
    "判定未推进",
  );
  assert.equal(
    ruleState(
      {
        status: "active",
        execution: { state: "monitoring", last_checked_at: now - 61000 },
      },
      healthy,
      now,
    ).label,
    "判定未推进",
  );
  assert.equal(
    ruleState(
      {
        status: "active",
        execution: { state: "preparing", reason_code: "awaiting_worker" },
        effective_at: now - 61000,
      },
      healthy,
      now,
    ).label,
    "尚未接管",
  );
  assert.equal(ruleState({ status: "paused" }, absent, now).label, "已暂停");
  assert.equal(
    ruleState(
      { status: "active" },
      monitorState(
        {
          chart_alerts: { loop: { state: "idle", heartbeat_at: now - 61000 } },
        },
        true,
        now,
        true,
        now,
      ),
      now,
    ).label,
    "监控已中断",
  );
  assert.equal(
    ruleProgress({
      execution: { last_evaluated_at: now, last_outcome: "initial_baseline" },
    }).label,
    "基准已建立",
  );
  assert.equal(
    ruleProgress({
      execution: { last_evaluated_at: now, last_outcome: "evaluated" },
    }).label,
    "已完成判定",
  );
  const row = {
    status: "active",
    health: "ready",
    config: {},
    execution: { state: "preparing", label: "准备中" },
  };
  assert.equal(ruleState(row).label, "准备中");
  assert.equal(
    ruleState({ ...row, execution: { state: "closed" } }).attention,
    false,
  );
  assert.equal(
    ruleState({ ...row, execution: { state: "monitoring" } }).label,
    "监控中",
  );
  assert.equal(
    ruleState({
      ...row,
      execution: { state: "blocked", message: "实时已关闭" },
    }).attention,
    true,
  );
  assert.equal(
    ruleState({ ...row, execution: null }).label,
    "监控中",
    "complex rule uses actual health, not price preparation",
  );
  assert.equal(
    ruleState({ ...row, execution: null, health: "warming" }).label,
    "准备中",
  );
  assert.equal(ruleState(row, false).label, "状态待确认");
  assert.equal(ruleState({ ...row, status: "archived" }).label, "已归档");
  assert.equal(ruleState({ ...row, status: "paused" }).label, "已暂停");
  const delivery = ruleState({
    ...row,
    execution: {
      state: "monitoring",
      notification: { status: "delivery_error" },
    },
  });
  assert.equal(delivery.label, "监控中");
  assert.equal(delivery.attention, true);
  assert.equal(
    eventHandled({
      notification_id: "n",
      ack_at: 1,
      notice: { handled_at: null },
    }),
    false,
  );
  assert.equal(
    eventHandled({
      notification_id: "n",
      ack_at: null,
      notice: { handled_at: 1 },
    }),
    false,
  );
  assert.equal(
    eventHandled({
      notification_id: "n",
      ack_at: 1,
      notice: { handled_at: 1 },
    }),
    true,
  );
  assert.equal(
    eventHandled({ notification_id: "n", ack_at: 1, notice: null }),
    true,
  );
  assert.equal(
    eventHandled({
      notification_id: "",
      ack_at: null,
      notice: { handled_at: 1 },
    }),
    true,
  );
  console.log(
    "PASS rule intent/execution/health/delivery separation and partial ack/handled semantics",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
