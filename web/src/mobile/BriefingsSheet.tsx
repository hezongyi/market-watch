import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, errorMessage, ApiError } from "../api";
import { type Profile, readSnapshot, writeSnapshot } from "./cache";
import { type BriefingPlan, type BriefingReport } from "./briefings";
import { Button } from "./components/ui/button";
import { Switch } from "./components/ui/switch";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldContent,
} from "./components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { Skeleton } from "./components/ui/skeleton";
import { useOverlayActive } from "./WatchOverlays";
import { logFailure } from "./logs";

const stamp = (value?: number | null) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "—";
export const displayPercent = (value: string) => {
  const rounded = Number(value).toFixed(2);
  return Number(rounded) === 0
    ? "0.00%"
    : `${Number(rounded) > 0 ? "+" : ""}${rounded}%`;
};
const finished = (status: string) =>
  ["ready", "partial", "failed", "skipped"].includes(status);
const names: Record<string, string> = {
  ready: "已生成",
  partial: "部分完成",
  failed: "未完成",
  skipped: "已跳过",
  pending: "正在生成",
  running: "正在生成",
  ok: "正常",
  not_updated: "尚未更新",
  insufficient_history: "历史不足",
  source_error: "读取失败",
  unsupported: "不支持",
};
export default function BriefingsSheet({
  profile,
  online,
  target,
  state,
  openChart,
  backRef,
}: {
  profile: Profile;
  online: boolean;
  target?: string;
  state(dirty: boolean, busy: boolean): void;
  openChart(ticker: string): void;
  backRef: MutableRefObject<(() => boolean) | undefined>;
}) {
  const active = useOverlayActive();
  const [plan, setPlan] = useState<BriefingPlan>();
  const [draft, setDraft] = useState<BriefingPlan>();
  const [reports, setReports] = useState<BriefingReport[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<BriefingReport>();
  const [reportId, setReportId] = useState(target);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState("desc");
  const [cached, setCached] = useState(false);
  const [conflict, setConflict] = useState(false);
  const flight = useRef(false);
  const previewId = useRef<string | undefined>(undefined);
  const dirty = Boolean(
    plan &&
    draft &&
    (plan.enabled !== draft.enabled ||
      JSON.stringify(plan.group_ids) !== JSON.stringify(draft.group_ids)),
  );
  const reloadDraft = useRef(false);
  const draftDirty = useRef(dirty);
  draftDirty.current = dirty;
  backRef.current = () => {
    if (!reportId) return false;
    setReportId(undefined);
    setSelected(undefined);
    setError("");
    setRetry((x) => x + 1);
    return true;
  };
  useEffect(
    () => () => {
      backRef.current = undefined;
    },
    [],
  );
  useEffect(() => {
    state(dirty, busy);
  }, [dirty, busy]);
  useEffect(() => () => state(false, false), []);
  useEffect(() => {
    if (target) setReportId(target);
  }, [target]);
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    const load = async () => {
      try {
        if (online) {
          const [p, history] = await Promise.all([
            api<BriefingPlan>(
              "/briefings/plan",
              undefined,
              AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
            ),
            api<{ items: BriefingReport[]; next_cursor: string | null }>(
              "/briefings/reports",
              undefined,
              AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
            ),
          ]);
          if (abort.signal.aborted) return;
          setPlan(p);
          if (reloadDraft.current || !draftDirty.current) {
            setDraft(p);
            reloadDraft.current = false;
            setConflict(false);
          } else setConflict(p.revision !== draft?.revision);
          setReports(history.items);
          setCursor(history.next_cursor);
          setCached(false);
          setError("");
          if (!draftDirty.current) setConflict(false);
          void writeSnapshot(profile, "briefing-home-v1", {
            plan: p,
            reports: history.items,
          }).catch((e) => logFailure("简报", "缓存历史", e));
        } else {
          const snapshot = await readSnapshot<{
            plan: BriefingPlan;
            reports: BriefingReport[];
          }>(profile, "briefing-home-v1");
          if (abort.signal.aborted) return;
          if (snapshot) {
            setPlan(snapshot.value.plan);
            if (!draftDirty.current) setDraft(snapshot.value.plan);
            setReports(snapshot.value.reports);
            setCached(true);
          }
        }
      } catch (e) {
        if (!abort.signal.aborted) setError(errorMessage(e));
      }
    };
    void load();
    return () => abort.abort();
  }, [active, online, retry, profile]);
  useEffect(() => {
    if (!active || !reportId) return;
    setSelected((old) => (old?.id === reportId ? old : undefined));
    setError("");
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let reads = 0;
    const read = async () => {
      try {
        if (document.hidden) return;
        if (!online) {
          const snapshot = await readSnapshot<BriefingReport>(
            profile,
            "briefing-report:" + reportId,
          );
          if (!abort.signal.aborted) {
            setSelected(snapshot?.value);
            if (!snapshot) setError("这期正文尚未缓存，联网后可查看");
          }
          return;
        }
        const row = await api<BriefingReport>(
          `/briefings/reports/${reportId}`,
          undefined,
          AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
        );
        if (abort.signal.aborted) return;
        setSelected(row);
        setError("");
        if (finished(row.status))
          void writeSnapshot(profile, "briefing-report:" + row.id, row).catch(
            (e) => logFailure("简报", "缓存正文", e),
          );
        else if (++reads < 100) timer = setTimeout(() => void read(), 2000);
      } catch (e) {
        if (!abort.signal.aborted) setError(errorMessage(e));
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) abort.abort();
      else setRetry((x) => x + 1);
    };
    document.addEventListener("visibilitychange", visibility);
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [active, online, reportId, retry, profile]);
  async function run(task: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      logFailure("简报", "操作", e);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  if (reportId)
    return (
      <div className="briefings-panel more-panel">
        <Button
          variant="ghost"
          onClick={() => {
            setReportId(undefined);
            setSelected(undefined);
            setError("");
            setRetry((x) => x + 1);
          }}
        >
          <ChevronLeft data-icon="inline-start" />
          简报历史
        </Button>
        {selected?.id === reportId ? (
          <>
            <header className="briefing-report-title">
              <small>
                {selected.mode === "preview" ? "预览 · 不推送" : "每日晨报"}
              </small>
              <h3>
                {new Date(selected.cutoff_at).toLocaleDateString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })}
              </h3>
              <p>
                {names[selected.status] || selected.status} ·{" "}
                {selected.body.coverage
                  ? `${selected.body.coverage.ok}/${selected.body.coverage.total} 有效`
                  : ""}
              </p>
            </header>
            <p className="more-description">
              {selected.snapshot.groups.map((x) => x.title).join("、")}
              <br />
              数据截止 {stamp(selected.cutoff_at)}
              <br />
              生成于 {stamp(selected.finished_at)}
            </p>
            {selected.body.issues?.map((issue) => (
              <p key={issue} className="mobile-inline-error">
                {issue}
              </p>
            ))}
            {selected.error && (
              <p role="alert" className="mobile-inline-error">
                {selected.error}
              </p>
            )}
            {selected.delivery && (
              <p className="more-description">
                {selected.delivery.status === "server_accepted"
                  ? "ntfy 已接受，手机实收待确认"
                  : selected.delivery.reason ||
                    (selected.delivery.outbox_status === "pending"
                      ? "等待推送"
                      : "未推送")}
              </p>
            )}
            <ToggleGroup
              value={[order]}
              onValueChange={(values) => {
                if (values[0]) setOrder(String(values[0]));
              }}
              aria-label="涨跌排序"
            >
              <ToggleGroupItem value="desc">涨幅优先</ToggleGroupItem>
              <ToggleGroupItem value="asc">跌幅优先</ToggleGroupItem>
            </ToggleGroup>
            {selected.body.sections?.map((section) => (
              <section key={section.id} className="briefing-section">
                <h3>{section.title}</h3>
                {section.error && <p>{section.error}</p>}
                {[
                  ...new Set(section.items.map((x) => x.category || "其他")),
                ].map((category) => (
                  <div key={category}>
                    <h4>
                      {{
                        forex: "外汇",
                        stock: "股票",
                        equity: "股票",
                        crypto: "加密",
                        metal: "贵金属",
                        index: "股指",
                        futures: "期货",
                      }[category] || category}
                    </h4>
                    {section.items
                      .filter((x) => (x.category || "其他") === category)
                      .sort(
                        (a, b) =>
                          Number(b.status === "ok") -
                            Number(a.status === "ok") ||
                          (Number(b.change_pct || 0) -
                            Number(a.change_pct || 0)) *
                            (order === "desc" ? 1 : -1),
                      )
                      .map((item) => (
                        <Button
                          key={item.ticker}
                          variant="plain"
                          className="briefing-market-row"
                          onClick={() => openChart(item.ticker)}
                        >
                          <span>
                            <strong>{item.symbol || item.ticker}</strong>
                            <small>
                              {[item.name, item.source, item.basis]
                                .filter(Boolean)
                                .join(" · ")}
                            </small>
                            <small>
                              {item.trading_date
                                ? `${item.previous_trading_date} → ${item.trading_date}`
                                : names[item.status]}{" "}
                              · {item.freshness || item.reason}
                            </small>
                            <small>{item.price_description}</small>
                          </span>
                          <span>
                            {item.change_pct != null && item.status === "ok" ? (
                              <>
                                <strong
                                  data-direction={
                                    Number(item.change_pct) >= 0 ? "up" : "down"
                                  }
                                >
                                  {displayPercent(item.change_pct)}
                                </strong>
                                <small>{item.close}</small>
                              </>
                            ) : (
                              <small>
                                {names[item.status] || item.status}
                                {item.change != null && (
                                  <>
                                    <br />
                                    参考变动{" "}
                                    {Number(item.change).toLocaleString(
                                      "zh-CN",
                                      { maximumFractionDigits: 8 },
                                    )}
                                  </>
                                )}
                              </small>
                            )}
                            <ChevronRight aria-hidden="true" />
                          </span>
                        </Button>
                      ))}
                  </div>
                ))}
              </section>
            ))}
            {!finished(selected.status) && (
              <p role="status">正在生成本期简报，可稍后回来查看。</p>
            )}
          </>
        ) : (
          <p role="status">{online ? "正在读取正文…" : "正文未缓存"}</p>
        )}
        {error && (
          <p role="alert" className="mobile-inline-error">
            {error}
          </p>
        )}
        <Button
          variant="outline"
          disabled={!online || busy}
          onClick={() => setRetry((x) => x + 1)}
        >
          重新读取
        </Button>
      </div>
    );
  return (
    <div className="briefings-panel more-panel">
      <p className="more-description">
        每天 08:00 · 北京时间
        <br />
        跟随所选自选分组，汇总最近交易日涨跌。
      </p>
      {draft ? (
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="briefing-enabled">每日晨报</FieldLabel>
              <FieldDescription>
                {draft.enabled
                  ? "由服务器定时生成，App 可关闭"
                  : "开启后从下一个 08:00 开始"}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="briefing-enabled"
              size="lg"
              checked={draft.enabled}
              disabled={!online || busy}
              onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
            />
          </Field>
          <Field>
            <FieldLabel>观察分组</FieldLabel>
            {draft.groups.length ? (
              <ToggleGroup
                multiple
                value={draft.group_ids}
                aria-label="晨报分组"
                disabled={!online || busy}
                onValueChange={(values) =>
                  setDraft({ ...draft, group_ids: values.map(String) })
                }
              >
                {draft.groups.map((group) => (
                  <ToggleGroupItem key={group.id} value={group.id}>
                    {group.title}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : (
              <FieldDescription>先在自选页建立分组</FieldDescription>
            )}
          </Field>
          {plan?.next_run_at && (
            <p className="more-description">下次 {stamp(plan.next_run_at)}</p>
          )}
          {!plan?.phone_available && (
            <p className="more-description">
              手机推送尚不可用；简报仍可在此查看。
            </p>
          )}
          <div className="mobile-sheet-actions">
            {dirty && (
              <Button
                disabled={!online || busy}
                onClick={() =>
                  void run(async () => {
                    const p = await api<BriefingPlan>("/briefings/plan", {
                      enabled: draft.enabled,
                      group_ids: draft.group_ids,
                      revision: draft.revision,
                    });
                    setPlan(p);
                    setDraft(p);
                    setConflict(false);
                  })
                }
              >
                {busy ? "保存中…" : "保存计划"}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={!online || busy || dirty || !draft.group_ids.length}
              onClick={() =>
                void run(async () => {
                  previewId.current ||= crypto.randomUUID();
                  const row = await api<BriefingReport>("/briefings/preview", {
                    request_id: previewId.current,
                  });
                  previewId.current = undefined;
                  setSelected(row);
                  setReportId(row.id);
                })
              }
            >
              预览
            </Button>
          </div>
        </FieldGroup>
      ) : online && !error ? (
        <Skeleton className="briefing-skeleton" />
      ) : (
        <p className="more-description">联网后可配置晨报</p>
      )}
      {error && (
        <p role="alert" className="mobile-inline-error">
          {error}
        </p>
      )}
      {conflict && (
        <Button
          variant="outline"
          onClick={() => {
            reloadDraft.current = true;
            setRetry((x) => x + 1);
          }}
        >
          读取最新设置
        </Button>
      )}
      <section className="briefing-history">
        <h3>简报历史</h3>
        {cached && <p className="more-description">离线 · 已保存的简报</p>}
        {!reports.length && (
          <p className="more-description">第一期生成后会出现在这里。</p>
        )}
        {reports.map((row) => (
          <Button
            key={row.id}
            variant="plain"
            className="briefing-history-row"
            onClick={() => {
              setSelected(row);
              setReportId(row.id);
            }}
          >
            <span>
              <strong>
                {new Date(row.cutoff_at).toLocaleDateString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })}
              </strong>
              <small>{names[row.status] || row.status}</small>
            </span>
            <ChevronRight data-icon="inline-end" />
          </Button>
        ))}
        {cursor && (
          <Button
            variant="outline"
            disabled={!online || busy}
            onClick={() =>
              void run(async () => {
                const page = await api<{
                  items: BriefingReport[];
                  next_cursor: string | null;
                }>("/briefings/reports?before=" + encodeURIComponent(cursor));
                setReports((old) => [
                  ...old,
                  ...page.items.filter((x) => !old.some((y) => x.id === y.id)),
                ]);
                setCursor(page.next_cursor);
              })
            }
          >
            加载更早
          </Button>
        )}
      </section>
      {!plan && (
        <Button
          variant="outline"
          disabled={!online}
          onClick={() => setRetry((x) => x + 1)}
        >
          重新读取
        </Button>
      )}
    </div>
  );
}
