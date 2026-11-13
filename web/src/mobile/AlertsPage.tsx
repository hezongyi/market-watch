import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "../api";
import { History, Plus, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useAlertData } from "../advanced/useAlertData";
import { alertCode, alertState } from "../advanced/alertPresentation";
import type { AlertConfig, AlertRow } from "../advanced/chartAlerts";
import type { NoticeRuntime } from "../notifications/runtime";
import { editablePrice, newPriceConfig, uncertainError } from "./alerts";
import { seriesIdentity } from "./market";
import { readSnapshot, writeSnapshot, type Profile } from "./cache";
import MobileSheet from "./MobileSheet";
import PriceRuleSheet from "./PriceRuleSheet";
import RecordsSheet, { stamp } from "./RecordsSheet";

export default function AlertsPage({
  profile,
  online,
  visible,
  symbol,
  createToken,
  runtime,
  records,
  closeRecords,
  showRecords,
  report,
}: {
  profile: Profile;
  online: boolean;
  visible: boolean;
  symbol: string;
  createToken: number;
  runtime: NoticeRuntime;
  records: boolean;
  closeRecords(): void;
  showRecords(): void;
  report(message: string): void;
}) {
  const [cachedEvents, setCachedEvents] = useState<
    import("../advanced/chartAlerts").AlertEvent[]
  >([]);
  const [cached, setCached] = useState<AlertRow[]>([]),
    [readAt, setReadAt] = useState<number>(),
    [loaded, setLoaded] = useState(false);
  const [health, setHealth] = useState<any>(),
    [healthAt, setHealthAt] = useState(0),
    [filter, setFilter] = useState("all"),
    [query, setQuery] = useState("");
  const [selection, setSelected] = useState<AlertRow>(),
    [judgments, setJudgments] = useState<any[]>([]);
  const [editor, setEditor] = useState<{
    config: AlertConfig;
    row?: AlertRow;
    frames: string[];
    label: string;
  }>();
  const [busy, setBusy] = useState(false),
    [unknownAction, setUnknownAction] = useState<{
      row: AlertRow;
      action: string;
      requestId: string;
    }>();
  const [actionError, setActionError] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const live = useRef(online),
    current = useRef(true);
  live.current = online;
  useEffect(
    () => () => {
      current.current = false;
    },
    [],
  );
  const request = useCallback(
    (async (path: string, body?: unknown, signal?: AbortSignal) => {
      if (!live.current) throw Error("连接核验后可读取告警");
      const value = await api(path, body, signal);
      if (path === "/chart-alerts" && body === undefined && current.current) {
        setLoaded(true);
        setReadAt(undefined);
      }
      if (path === "/chart-alerts/events" && current.current) {
        setCachedEvents(value);
        void writeSnapshot(profile, "alert-events", value).catch(() => {});
      }
      return value;
    }) as typeof api,
    [profile.origin, profile.subject],
  );
  const onRows = useCallback(
    (rows: AlertRow[]) => {
      setCached(rows);
      void writeSnapshot(profile, "alert-rules", rows).catch(() =>
        report("告警快照未写入本机"),
      );
    },
    [profile.origin, profile.subject, report],
  );
  const data = useAlertData(request, onRows);
  useEffect(() => {
    let active = true;
    void readSnapshot<AlertRow[]>(profile, "alert-rules")
      .then((value) => {
        if (active && value) {
          setCached(value.value);
          setReadAt(value.readAt);
        }
      })
      .catch(() => report("上次告警读取失败"));
    void readSnapshot<import("../advanced/chartAlerts").AlertEvent[]>(
      profile,
      "alert-events",
    )
      .then((value) => {
        if (active && value) setCachedEvents(value.value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [profile.origin, profile.subject, report]);
  const refresh = useCallback(async () => {
    if (!live.current || document.hidden) return;
    void data.refresh();
    try {
      const value = await api("/health");
      if (current.current && live.current) {
        setHealth(value);
        setHealthAt(Date.now());
      }
    } catch (error) {
      if (current.current) {
        setHealthAt(0);
        report(errorMessage(error));
      }
    }
  }, [data.refresh, report]);
  useEffect(() => {
    if ((!visible && !records) || !online) return;
    let timer: ReturnType<typeof setInterval>;
    const visibility = () => {
      clearInterval(timer);
      if (!document.hidden) {
        void refresh();
        timer = setInterval(() => void refresh(), 15000);
      }
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [visible, records, online, refresh]);
  const rows = loaded ? data.rows : cached;
  const selected =
    selection && (rows.find((row) => row.id === selection.id) || selection);
  const selectionMissing = Boolean(
    selection && loaded && !rows.some((row) => row.id === selection.id),
  );
  useEffect(() => {
    if (!selected || !online) return;
    const controller = new AbortController();
    setJudgments([]);
    void api<any>(
      `/chart-alerts/${selected.id}/judgments`,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setJudgments(value.items || value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) report(errorMessage(error));
      });
    return () => controller.abort();
  }, [selected?.id, online, report]);
  const loop = health?.chart_alerts?.loop;
  const verified = online && Boolean(healthAt) && Date.now() - healthAt < 45000;
  const workerKnown =
    verified &&
    ["running", "ready", "idle", "waiting_input"].includes(loop?.state);
  const ntfy = Boolean(
    verified && health?.ntfy_configured && health?.delivery_enabled,
  );
  const bucket = (row: AlertRow) => {
    if (row.execution?.state === "blocked") return "attention";
    if (row.execution?.state === "settling") return "settling";
    if (row.status !== "active") return row.status;
    return row.execution?.state || row.status;
  };
  async function edit(row?: AlertRow) {
    if (!online || busy) return;
    const ticker = row ? "MWC:" + row.config.instrument : symbol;
    const identity = seriesIdentity(ticker);
    if (identity.series_kind !== "composite") {
      report("请选择已开启实时接续的自建行情；原生行情和固定历史不支持新建实时告警");
      return;
    }
    setBusy(true);
    try {
      const detail = await api<any>(
        `/market-data/composites/${encodeURIComponent(identity.instrument)}`,
      );
      const meta = await api<any>("/market-data/resolve", {
        ...identity,
        timeframe: row?.config.timeframe || "M1",
      });
      if (!current.current || !live.current) return;
      setEditor({
        config: row
          ? structuredClone(row.config)
          : newPriceConfig(identity.instrument, detail.active_revision_id),
        row,
        frames: meta.frames || [],
        label: row
          ? alertCode(row, row.name)
          : detail.display_symbol || detail.logical_symbol || ticker,
      });
    } catch (error) {
      report(errorMessage(error));
    } finally {
      if (current.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (createToken && online) void edit();
  }, [createToken]);
  async function lifecycle(
    row: AlertRow,
    action: string,
    requestId: string = crypto.randomUUID(),
  ) {
    if (!online || busy) return;
    setBusy(true);
    setActionError("");
    try {
      const saved = await api<AlertRow>(
        `/chart-alerts/${row.id}/lifecycle`,
        {
          version: row.version,
          control_revision: row.control_revision,
          action,
          request_id: requestId,
        },
        AbortSignal.timeout(20000),
      );
      if (!current.current || !live.current) return;
      data.commit(saved);
      setSelected(saved.status === "archived" ? undefined : saved);
      setUnknownAction(undefined);
      void refresh();
    } catch (error) {
      if (!current.current) return;
      setActionError(errorMessage(error));
      if (uncertainError(error)) setUnknownAction({ row, action, requestId });
      else {
        setUnknownAction(undefined);
        if (error instanceof ApiError && error.status === 409)
          report("规则已改变；当前操作未自动覆盖，请查看最新");
      }
    } finally {
      if (current.current) setBusy(false);
    }
  }
  return (
    <>
      <section hidden={!visible} className="mobile-content mobile-alerts">
        <header className="mobile-title">
          <div>
            <h1>告警</h1>
            <small>
              {readAt
                ? `上次读取 ${stamp(readAt)}`
                : workerKnown
                  ? "执行服务状态已核验"
                  : "执行服务待确认"}
            </small>
          </div>
          <button
            className="mobile-icon-button"
            aria-label="创建告警"
            disabled={!online || busy || !symbol.startsWith("MWC:")}
            onClick={() => void edit()}
          >
            <Plus aria-hidden="true" />
          </button>
        </header>
        <div className="mobile-health-card">
          <div className="mobile-health-title">
            <ShieldCheck aria-hidden="true" />
            {readAt || !online ? "上次读取的监控概况" : "由服务器检测价格"}
          </div>
          <div className="mobile-health-stats">
            <div>
              <strong>
                {loaded || readAt
                  ? rows.filter((row) => bucket(row) === "monitoring").length
                  : "—"}
              </strong>
              <span>{readAt || !workerKnown ? "上次监控" : "监控中"}</span>
            </div>
            <div>
              <strong>
                {loaded || readAt
                  ? rows.filter((row) => bucket(row) === "attention").length
                  : "—"}
              </strong>
              <span>需要处理</span>
            </div>
            <div>
              <strong>
                {loaded || readAt
                  ? rows.filter((row) => bucket(row) === "paused").length
                  : "—"}
              </strong>
              <span>已暂停</span>
            </div>
          </div>
        </div>
        {!online && <p>上次内容，只读；服务器继续检测。</p>}
        {data.error && <p role="status">{data.error}</p>}
        <div className="mobile-compact-filter">
          <div className="mobile-tabs" role="group" aria-label="告警状态">
            {[
              ["all", "全部"],
              ["monitoring", "监控中"],
              ["attention", "需处理"],
              ["paused", "已暂停"],
            ].map(([value, label]) => (
              <button
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className="mobile-icon-button"
            aria-label="更多告警筛选"
            onClick={() => setFiltersOpen(true)}
          >
            <SlidersHorizontal aria-hidden="true" />
          </button>
        </div>
        {!["all", "monitoring", "attention", "paused"].includes(filter) && (
          <p className="mobile-muted">当前筛选：{filter}</p>
        )}
        {filtersOpen && (
          <MobileSheet title="告警筛选" close={() => setFiltersOpen(false)}>
            <label>
              搜索告警
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label>
              规则状态
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">全部</option>
                <option value="monitoring">监控中</option>
                <option value="attention">需处理</option>
                <option value="preparing">准备中</option>
                <option value="recovering">恢复中</option>
                <option value="closed">休市</option>
                <option value="settling">到期结算</option>
                <option value="paused">暂停</option>
                <option value="completed">完成</option>
                <option value="expired">到期</option>
                <option value="archived">归档</option>
              </select>
            </label>
            {!symbol.startsWith("MWC:") && (
              <p>从自选或数据选择已开启实时接续的自建行情，创建价格告警。</p>
            )}
            <button
              aria-label="刷新"
              disabled={!online || busy}
              onClick={() => void refresh()}
            >
              刷新告警
            </button>
            <button className="primary" onClick={() => setFiltersOpen(false)}>
              应用筛选
            </button>
          </MobileSheet>
        )}
        {!loaded && !readAt ? (
          <p>
            {data.error
              ? "读取失败，暂无缓存"
              : online
                ? "正在读取告警…"
                : "暂无告警缓存"}
          </p>
        ) : (
          !rows.length && <p>尚无规则。</p>
        )}
        {rows
          .filter(
            (row) =>
              (filter === "all" || bucket(row) === filter) &&
              [row.name, row.display_label, row.condition_summary]
                .join(" ")
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
          )
          .map((row) => (
            <article key={row.id} className="mobile-rule-card">
              <button
                className="mobile-rule-open"
                onClick={() => {
                  setActionError("");
                  setSelected(row);
                }}
              >
                <span>
                  <strong>{alertCode(row, row.config.instrument)}</strong>
                  <span
                    className={`mobile-rule-state ${bucket(row) === "attention" ? "warning" : ""}`}
                  >
                    {row.execution
                      ? alertState(row)
                      : row.status === "active"
                        ? "执行状态待确认"
                        : alertState(row)}
                    {(readAt || !workerKnown) && " · 待确认"}
                  </span>
                </span>
                <small>
                  {row.name} ·{" "}
                  {row.config.series_kind === "composite" ? "自建 · 实时接续" : row.config.series_kind === "provider" ? "原生" : "自建"} ·{" "}
                  {row.display_identity?.source || row.config.source}
                </small>
                <strong className="mobile-rule-condition">
                  {row.condition_summary}
                </strong>
                <small>
                  {row.config.mode === "close"
                    ? `${row.config.timeframe} 收盘确认`
                    : "触价检测"}{" "}
                  · {row.count}/{row.max_triggers} 次<br />
                  {row.config.notify_ntfy
                    ? "ntfy 通知 + 站内记录"
                    : "站内记录"}{" "}
                  ·{" "}
                  {row.config.expires_at
                    ? stamp(row.config.expires_at) + " 到期"
                    : "不限到期时间"}
                </small>
              </button>
              <div className="mobile-rule-footer">
                <small>
                  最近检测{" "}
                  {row.execution?.last_evaluated_at
                    ? new Date(
                        row.execution.last_evaluated_at,
                      ).toLocaleTimeString()
                    : "尚无记录"}
                </small>
                <div>
                  <button
                    className="mobile-link-button"
                    onClick={() => {
                      setActionError("");
                      setSelected(row);
                    }}
                  >
                    详情
                  </button>
                  {(row.status === "active" ||
                    (row.status === "paused" &&
                      row.config.series_kind === "composite")) && (
                    <button
                      className="mobile-link-button"
                      aria-label={`${row.status === "active" ? "暂停" : "恢复"}${row.name}`}
                      disabled={!online || busy || Boolean(unknownAction)}
                      onClick={() => {
                        setSelected(row);
                        void lifecycle(
                          row,
                          row.status === "active" ? "pause" : "resume",
                        );
                      }}
                    >
                      {row.status === "active" ? "暂停" : "恢复"}
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        <button
          className="mobile-records-button"
          aria-label="事件记录"
          onClick={showRecords}
        >
          <History aria-hidden="true" />
          触发与异常记录
        </button>
        {selected && (
          <MobileSheet
            title={selected.name}
            close={() => {
              setSelected(undefined);
              setUnknownAction(undefined);
            }}
            dirty={Boolean(unknownAction)}
          >
            <p>{alertCode(selected, selected.config.instrument)}</p>
            <p className="mobile-identity">
              {selected.config.series_kind} · {selected.config.source} ·{" "}
              {selected.config.instrument}
            </p>
            <p>
              {selected.condition_summary} ·{" "}
              {selected.config.mode === "close" ? "完成柱收盘" : "当前抽样触价"}{" "}
              · {selected.config.timeframe}
            </p>
            <p>
              {selected.execution ? selected.execution.label : "执行状态待确认"}
              {(!workerKnown || readAt || selectionMissing) && " · 状态待确认"}
            </p>
            <p>{selected.execution?.message || selected.health_reason}</p>
            <dl className="mobile-facts">
              {Object.entries({
                已触发: `${selected.count}/${selected.max_triggers} 次`,
                到期: stamp(selected.config.expires_at),
                接管: stamp((selected.execution as any)?.taken_over_at),
                最近检查: stamp((selected.execution as any)?.last_checked_at),
                最近判定: stamp(selected.execution?.last_evaluated_at),
                最近输入: stamp(selected.execution?.last_input_at),
                预期输入: stamp((selected.execution as any)?.expected_input_at),
                位置: String((selected.execution as any)?.position ?? "待确认"),
                ntfy:
                  selected.execution?.notification?.message ||
                  selected.execution?.notification?.status ||
                  "未确认",
                手机配置:
                  selected.execution?.phone_configuration?.message ||
                  "未核验手机实收",
              }).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {selected.execution?.last_gap && (
              <p>
                判定缺口 {stamp(selected.execution.last_gap.start)} —{" "}
                {stamp(selected.execution.last_gap.end)} ·{" "}
                {selected.execution.last_gap.bounds}
                {selected.execution.last_gap.unrecoverable ? " · 无法补判" : ""}
              </p>
            )}
            {(selected.execution as any)?.incident?.message && (
              <p>{(selected.execution as any).incident.message}</p>
            )}
            {actionError && <p role="alert">{actionError}</p>}
            {unknownAction ? (
              <>
                <p>操作结果未知；核查沿用同一请求，不能继续其他状态操作。</p>
                <button
                  disabled={busy || !online}
                  onClick={() =>
                    void lifecycle(
                      unknownAction.row,
                      unknownAction.action,
                      unknownAction.requestId,
                    )
                  }
                >
                  核查同一次操作
                </button>
              </>
            ) : (
              <>
                <button
                  disabled={!online || busy || !editablePrice(selected)}
                  onClick={() => void edit(selected)}
                >
                  编辑价格告警
                </button>
                {selected.status === "active" && (
                  <button
                    disabled={!online || busy}
                    onClick={() => void lifecycle(selected, "pause")}
                  >
                    暂停
                  </button>
                )}
                {selected.status === "paused" &&
                  selected.config.series_kind === "composite" && (
                    <button
                      disabled={!online || busy}
                      onClick={() => void lifecycle(selected, "resume")}
                    >
                      恢复
                    </button>
                  )}
                <button
                  disabled={!online || busy || selected.status === "archived"}
                  onClick={() => {
                    if (confirm("归档此规则？服务器将停止此规则执行。"))
                      void lifecycle(selected, "archive");
                  }}
                >
                  归档
                </button>
                <button
                  disabled={!online || busy}
                  onClick={async () => {
                    try {
                      const row = await api<AlertRow>(
                        `/chart-alerts/${selected.id}`,
                      );
                      data.commit(row);
                      setSelected(row);
                    } catch (error) {
                      report(errorMessage(error));
                    }
                  }}
                >
                  查看最新
                </button>
              </>
            )}
            {!editablePrice(selected) && (
              <p>
                此规则的来源、状态或条件不支持手机编辑。旧来源仅可查看、暂停或归档；复杂条件请在桌面查看。
              </p>
            )}
            <h3>判定结果</h3>
            {!judgments.length && <p>暂无已读取的判定记录。</p>}
            {judgments.map((row, index) => (
              <article className="mobile-status-card" key={row.id || index}>
                <p>
                  {row.summary ||
                    row.reason ||
                    row.result ||
                    row.outcome ||
                    row.state ||
                    row.status}
                </p>
                <p>
                  {stamp(
                    row.evaluated_at ||
                      row.event_time ||
                      row.created_at ||
                      row.occurred_at ||
                      row.at,
                  )}
                </p>
              </article>
            ))}
          </MobileSheet>
        )}
        {editor && (
          <PriceRuleSheet
            key={editor.row?.id || "new"}
            initial={editor.config}
            editing={editor.row}
            frames={editor.frames}
            label={editor.label}
            online={online}
            ntfy={ntfy}
            close={() => setEditor(undefined)}
            report={report}
            saved={(row) => {
              data.commit(row);
              setEditor(undefined);
              setSelected(undefined);
              void refresh();
            }}
          />
        )}
      </section>
      <RecordsSheet
        open={records}
        profile={profile}
        online={online}
        events={data.events.length ? data.events : cachedEvents}
        runtime={runtime}
        close={closeRecords}
        report={report}
      />
    </>
  );
}
