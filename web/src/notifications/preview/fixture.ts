import type {
  Notice,
  NoticeState,
  NoticeTransport,
  HistoryPage,
} from "../types";
const now = Date.now();
const seed: [string, string, string, string, number, number, boolean][] = [
  [
    "connection",
    "warning",
    "行情连接暂时中断",
    "已启动自动重连。恢复后会更新这条消息。",
    now - 3 * 60000,
    3,
    false,
  ],
  [
    "history",
    "error",
    "历史数据加载失败",
    "EURUSD · 1 小时：本次加载未完成，可查看相关图表后重试。",
    now - 12 * 60000,
    2,
    false,
  ],
  [
    "indicator",
    "warning",
    "指标暂未计算完成",
    "指标依赖的数据正在补齐，完成后会继续计算。",
    now - 24 * 60000,
    1,
    false,
  ],
  [
    "market",
    "info",
    "行情连接已恢复",
    "连接恢复，行情已继续更新。",
    now - 52 * 60000,
    4,
    true,
  ],
  [
    "preferences",
    "info",
    "工作区设置已保存",
    "本次设置修改已保存到当前工作区。",
    now - 72 * 60000,
    1,
    true,
  ],
  [
    "data_center",
    "warning",
    "数据源暂时不可用",
    "后台正在重试，请稍后在数据中心查看状态。",
    now - 90 * 60000,
    2,
    false,
  ],
  [
    "workspace",
    "info",
    "工作区已恢复",
    "已恢复上次保存的图表布局和品种。",
    now - 25 * 3600000,
    1,
    true,
  ],
  [
    "history",
    "warning",
    "历史数据仍在补齐",
    "此条用于预览更早的消息、滚动加载和详情。",
    now - 26 * 3600000,
    1,
    true,
  ],
  [
    "market",
    "info",
    "行情订阅已更新",
    "当前工作区订阅已同步。",
    now - 27 * 3600000,
    1,
    true,
  ],
];
for (let i = 0; i < 12; i++)
  seed.push([
    i % 2 ? "workspace" : "market",
    "info",
    i % 2 ? "工作区状态已同步" : "行情订阅已刷新",
    "此条为更早的系统消息，用于试用连续滚动加载。",
    now - (30 + i * 2) * 3600000,
    1,
    true,
  ]);
export function createMessageFixture(changed: (state: NoticeState) => void) {
  const historyCalls: (string | null)[] = [];
  let failOlder = false;
  const rows: Notice[] = seed.map(
    ([source, severity, title, message, occurred, count, read], i) => ({
      id: `preview-system-${i + 1}`,
      version: 1,
      first_seq: 100 - i,
      source_domain: "browser",
      source_kind: source,
      source_id: `fixture-${i + 1}`,
      incident_id: `preview-incident-${i + 1}`,
      kind: "fault",
      severity,
      title,
      message,
      occurred_at: occurred,
      recorded_at: occurred + 100,
      viewed_at: read ? occurred + 1000 : null,
      handled_at: null,
      attention: true,
      backfill: false,
      workspace: "预览工作区",
      instrument: ["history", "indicator"].includes(source) ? "EURUSD" : "",
      context: { instrument: "EURUSD", timeframe: "H1", chart_index: 0 },
      evidence: { preview: true, code: "SAMPLE_MESSAGE" },
      incident: {
        id: `preview-incident-${i + 1}`,
        count,
        closed_at: title.includes("已恢复") ? occurred + 1000 : null,
        first_at: occurred - count * 60000,
        last_at: occurred,
      },
    }),
  );
  let state: NoticeState = {
    epoch: "preview-only",
    revision: 0,
    events: rows,
    pending: [],
    unread: 0,
    status: "已同步",
    gap: "",
    enabled: false,
    unlocked: false,
    soundLimited: false,
    soundStatus: "",
    systemPopups: true,
    bubble: null,
    overflow: 0,
    serverTime: now,
  };
  const refresh = () => {
    state = {
      ...state,
      revision: state.revision + 1,
      unread: rows.filter((row) => !row.viewed_at).length,
    };
    changed(state);
  };
  const request: NoticeTransport = async (action) => {
    if (action.action === "history") {
      historyCalls.push(action.before || null);
      // Preview-only latency makes the shared loading state visible.
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (action.before && failOlder) {
        failOlder = false;
        throw Error("示例：暂时无法加载更早消息");
      }
      const f = action.filters || {};
      const matches = rows.filter(
        (row) =>
          (!f.incident || row.incident_id === f.incident) &&
          (!f.q || `${row.title} ${row.message}`.includes(f.q)) &&
          (!f.state || f.state !== "unread" || !row.viewed_at) &&
          (!f.severity || row.severity === f.severity) &&
          (!f.source || row.source_kind === f.source) &&
          (!f.instrument || row.instrument.includes(f.instrument)) &&
          (!f.workspace || row.workspace.includes(f.workspace)) &&
          (!f.since || row.occurred_at >= Number(f.since)) &&
          (!f.until || row.occurred_at <= Number(f.until)),
      );
      const start = Number(action.before || 0),
        size = f.incident ? 20 : 6;
      return {
        events: matches.slice(start, start + size),
        before: start + size < matches.length ? String(start + size) : null,
        highwater: 100,
        after: "preview",
        epoch: state.epoch,
        unread: state.unread,
        system_unread: state.unread,
        server_time: now,
      } satisfies HistoryPage;
    }
    if (action.action === "detail") {
      const row = rows.find((row) => row.id === action.event_id);
      if (!row) throw Error("未找到示例消息");
      return structuredClone(row);
    }
    if (action.action === "timeline")
      return {
        observations: [
          {
            id: "preview-received",
            kind: "received",
            received_at: now,
            reported_at: now,
            profile: "预览浏览器",
            details: { preview: true },
          },
        ],
        before: null,
        event_id: action.event_id,
      };
    if (action.action === "read-system") {
      for (const row of rows)
        if (
          row.first_seq <= Number(action.through) &&
          (!action.incident_id || row.incident_id === action.incident_id)
        )
          row.viewed_at = Date.now();
      refresh();
      return { ok: true };
    }
    if (action.action === "system-popups") {
      state = { ...state, systemPopups: !!action.enabled };
      refresh();
      return { ok: true };
    }
    if (action.action === "observe") {
      const row = rows.find((row) => row.id === action.event_id);
      if (row && action.kind === "handled") row.handled_at = Date.now();
      refresh();
      return { ok: true };
    }
    throw Error("预览没有接入此操作");
  };
  state.unread = rows.filter((row) => !row.viewed_at).length;
  return {
    request,
    state: () => state,
    refresh,
    historyCalls,
    failNextOlder: () => {
      failOlder = true;
    },
  };
}
