import {
  loadNativeHistory,
  type HistoryCapabilities,
} from "./nativeHistoryLoads";
import { useEffect, useRef, useState } from "react";
import { api, apiErrorDetails } from "../api";
import "./advanced.css";
import { HistoryPlansDialog, type DatasetViews } from "./HistoryPlansDialog";
import { MaintenanceDialog } from "./MaintenanceDialog";
import { ExportDialog, type ExportSelection } from "./ExportDialog";
import { providerSubscriptions } from "./providerSubscriptions";
import { ChartAlertsPanel } from "./ChartAlertsPanel";
import { validAlertContext, type AlertContext } from "./chartAlerts";
import { HistoryCapacityDialog } from "./HistoryCapacityDialog";
import {
  HistoryLoadingNotice,
  HISTORY_NOTICE_DELAY_MS,
  type NativeLoad,
  type CapacityNotice,
} from "./HistoryLoadingNotice";

type Workspace = {
  id: string;
  name: string;
  revision: number;
  document: Record<string, unknown>;
  initial_symbol?: { ticker: string; metadata: Record<string, unknown> };
};
const channel = "mw-chart-v1";
const frames = new Set([
  "M1",
  "M5",
  "M15",
  "M30",
  "H1",
  "H4",
  "D1",
  "W1",
  "MN",
]);

export default function AdvancedWorkspace() {
  const [, setRows] = useState<Workspace[]>([]),
    [active, setActive] = useState<Workspace | null>(null);
  const [historyPlansOpen, setHistoryPlansOpen] = useState(false);
  const [maintenanceInstrument, setMaintenanceInstrument] = useState<
    string | null
  >(null);
  const [datasetViews, setDatasetViews] = useState<DatasetViews>({});
  const [frameKey, setFrameKey] = useState(0);
  const [exportSelection, setExportSelection] =
    useState<ExportSelection | null>(null);
  const [historyProgress, setHistoryProgress] = useState<
    Record<string, string>
  >({});
  const [feedError, setFeedError] = useState("");
  const [syncNotices, setSyncNotices] = useState<Record<string, string>>({});
  const [pollErrors, setPollErrors] = useState<Record<string, string>>({});
  const [chartTheme, setChartTheme] = useState("dark");
  const [nativeReady, setNativeReady] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertContext, setAlertContext] = useState<AlertContext | null>(null);
  const [alertAssociations, setAlertAssociations] = useState<Record<string, string>>({});
  const historyCapabilities = useRef<HistoryCapabilities | null>(null);
  const nativeLoadEpoch = useRef(0);
  const [capacityNotices, setCapacityNotices] = useState<
    Record<string, CapacityNotice>
  >({});
  const [nativeLoads, setNativeLoads] = useState<Record<string, NativeLoad>>(
    {},
  );
  const [capacityDialog, setCapacityDialog] = useState<{
    capabilities: HistoryCapabilities;
    usage: number;
  } | null>(null);
  const [status, setStatus] = useState("正在加载工作区"),
    [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null),
    current = useRef<Workspace | null>(null);
  const unsaved = useRef(false);
  const flushWaiters = useRef<
    { resolve: () => void; reject: (e: Error) => void }[]
  >([]);
  const mobile = matchMedia("(max-width:700px), (pointer:coarse)").matches;
  const queue = useRef<Promise<void>>(Promise.resolve()),
    blocked = useRef(false),
    inflight = useRef(0);
  const host =
    (import.meta as any).env.VITE_ADVANCED_CHART_ORIGIN ||
    `${location.protocol}//${location.hostname}:5187`;
  const origin = new URL(host).origin;
  if (origin === location.origin) throw new Error("图表库必须使用独立来源");
  const post = (value: object) =>
    frame.current?.contentWindow?.postMessage({ channel, ...value }, origin);
  const flush = () =>
    new Promise<void>((resolve, reject) => {
      if (!current.current || mobile) {
        resolve();
        return;
      }
      const waiter = { resolve, reject };
      flushWaiters.current.push(waiter);
      post({ type: "save" });
      setTimeout(() => {
        if (flushWaiters.current.includes(waiter)) {
          flushWaiters.current = flushWaiters.current.filter(
            (w) => w !== waiter,
          );
          reject(Error("保存未完成，请等待图表加载后再试"));
        }
      }, 15000);
    });
  const select = (row: Workspace) => {
    setNativeReady(false);
    setPollErrors({});
    setHistoryProgress({});
    setNativeLoads({});
    setCapacityNotices({});
    nativeLoadEpoch.current = 0;
    setCapacityDialog(null);
    setDatasetViews({});
    setSyncNotices({});
    unsaved.current = false;
    current.current = row;
    blocked.current =
      !mobile && !!localStorage.getItem("mw-tv-draft:" + row.id);
    setActive(row);
    setFrameKey((key) => key + 1);
    setError(
      blocked.current
        ? "存在未保存草稿，请点击复制恢复为独立工作区；原工作区自动保存已暂停"
        : "",
    );
    setStatus("正在加载图表");
  };
  const noticeMessages = [
    ...(blocked.current
      ? [
          {
            id: "draft",
            text: "草稿尚未保存，自动保存已暂停。是否复制恢复为独立工作区？",
            recover: true,
          },
        ]
      : []),
    ...(!blocked.current && error ? [{ id: "workspace", text: error }] : []),
    ...(feedError &&
    !(blocked.current && /未保存草稿|保存已暂停/.test(feedError))
      ? [{ id: "feed", text: feedError }]
      : []),
    ...Object.entries(pollErrors).map(([id, text]) => ({
      id: "poll:" + id,
      text,
    })),
    ...Object.entries(syncNotices).map(([id, text]) => ({
      id: "viewport:" + id,
      text,
    })),
  ];
  const notificationState = JSON.stringify(noticeMessages);
  useEffect(() => {
    if (nativeReady)
      post({
        type: "notifications",
        notices: JSON.parse(notificationState),
        draftBlocked: blocked.current,
      });
  }, [nativeReady, notificationState]);
  async function refresh(limit?: number) {
    const list = await api<Workspace[]>(
      "/advanced-charts/workspaces" + (limit ? "?limit=" + limit : ""),
    );
    setRows(list);
    return list;
  }
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (mobile || !unsaved.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    addEventListener("beforeunload", protect);
    return () => removeEventListener("beforeunload", protect);
  }, [mobile]);
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (
        mobile ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "s"
      )
        return;
      event.preventDefault();
      post({ type: "save" });
    };
    addEventListener("keydown", save);
    return () => removeEventListener("keydown", save);
  }, [mobile]);
  useEffect(() => {
    let cancelled = false;
    const platform = new URLSearchParams(location.search).get("platform");
    const opening = platform
      ? api<Workspace>("/advanced-charts/workspaces", {
          name: "平台行情",
          symbol: platform,
        }).then((row) => {
          history.replaceState(null, "", location.pathname);
          return [row];
        })
      : refresh(1);
    opening
      .then((list) => {
        if (!cancelled) {
          if (list[0]) select(list[0]);
          else setStatus("新建工作区开始使用");
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const marketRequests = new Map<Window, Map<number, AbortController>>();
    const provider = providerSubscriptions(
      api,
      (client) =>
        new EventSource(
          "/api/charts/provider/events?client=" + encodeURIComponent(client),
        ),
      (event) =>
        frame.current?.contentWindow?.postMessage(
          { channel, type: "provider-event", event },
          origin,
        ),
      (error) => setError(String(error)),
    );
    const listener = async (e: MessageEvent) => {
      if (
        e.source !== frame.current?.contentWindow ||
        e.origin !== origin ||
        e.data?.channel !== channel
      )
        return;
      const m = e.data,
        source = e.source as Window;
      const reply = (value: object) =>
        source.postMessage({ channel, ...value }, origin);
      if (m.type === "chart-alert-context") {
        if (mobile || !validAlertContext(m.context, current.current?.id)) return;
        setAlertContext(m.context); setAlertsOpen(true);
        return;
      }
      if (m.type === "chart-alert-open") {setAlertsOpen(true); return;}
      if (m.type === "chart-alert-association") {
        if (m.workspace_id === current.current?.id && typeof m.alert_id === "string" && /^[a-f0-9-]{36}$/.test(m.alert_id) && typeof m.text === "string" && m.text.length <= 1000)
          setAlertAssociations(previous => ({...previous, [m.alert_id]: m.text}));
        return;
      }
      if (m.type === "chart-alert-rpc") {
        const q = m.query;
        const requestWorkspace = current.current?.id;
        if (mobile || !Number.isSafeInteger(m.id) || m.id <= 0 || !q ||
            JSON.stringify(q).length > 20_000 || !["geometry", "edit", "read", "lifecycle"].includes(q.op)) return;
        try {
          let result;
          if (q.op === "geometry") result = await api("/chart-alerts/geometry", q.args);
          else if (typeof q.alert_id === "string" && /^[a-f0-9-]{36}$/.test(q.alert_id)) {
            if (q.op === "read") result = await api(`/chart-alerts/${q.alert_id}`);
            else {
              // A drawing message may only affect the persisted object from this
              // workspace; it cannot replace an arbitrary alert configuration.
              const row = await api(`/chart-alerts/${q.alert_id}`), a = row.config.association;
              if (!a || requestWorkspace !== current.current?.id || q.workspace_id !== requestWorkspace || a.workspace_id !== requestWorkspace || a.object_id !== q.object_id || a.chart_id !== q.chart_id) throw Error("告警图表关联已改变");
              if (q.op === "lifecycle" && q.action === "drawing_deleted") result = await api(`/chart-alerts/${q.alert_id}/lifecycle`, {version: q.version, control_revision: q.control_revision, request_id: q.request_id, action: "drawing_deleted"});
              else if (q.op === "edit" && q.line && a.object_kind === "drawing") result = await api(`/chart-alerts/${q.alert_id}/edit`, {version: q.version, config: {...row.config, condition: {...row.config.condition, right: {kind: "line", line: q.line}}, association: {...a, generation: q.generation}}});
              else throw Error("不允许的画线告警操作");
            }
          } else throw Error("无效告警请求");
          reply({type: "result", id: m.id, result});
        } catch (e) {reply({type: "result", id: m.id, error: String(e), errorDetails: apiErrorDetails(e)});}
        return;
      }
      if (
        m.type === "provider-subscribe" ||
        m.type === "provider-unsubscribe"
      ) {
        const args = m.args;
        if (
          !args ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(args.client) ||
          typeof args.listener !== "string" ||
          args.listener.length > 100
        )
          return;
        try {
          if (m.type === "provider-subscribe") {
            await provider.subscribe(args);
          } else {
            await provider.unsubscribe(args);
          }
        } catch (error) {
          setError(String(error));
        }
        return;
      }
      if (m.type === "history-progress") {
        const key = String(m.key).slice(0, 100),
          text = String(m.text).slice(0, 200);
        setHistoryProgress((previous) => {
          const next = { ...previous };
          if (text) next[key] = text;
          else delete next[key];
          return next;
        });
        return;
      }
      if (m.type === "history-views" && Array.isArray(m.keys)) {
        const keys = new Set(m.keys.slice(0, 8));
        setHistoryProgress((previous) =>
          Object.fromEntries(
            Object.entries(previous).filter(([key]) => keys.has(key)),
          ),
        );
        return;
      }
      if (m.type === "history-plans-open") {
        setHistoryPlansOpen(true);
        return;
      }
      if (m.type === "history-capacity-open") {
        const epoch = nativeLoadEpoch.current;
        try {
          const capabilities = await api<HistoryCapabilities>(
            "/charts/history-capabilities",
          );
          if (
            source !== frame.current?.contentWindow ||
            epoch !== nativeLoadEpoch.current
          )
            return;
          historyCapabilities.current = capabilities;
          reply({ type: "history-capabilities", capabilities });
          setCapacityDialog({
            capabilities,
            usage: Number.isSafeInteger(m.usage) ? Math.max(0, m.usage) : 0,
          });
        } catch (e) {
          if (
            source === frame.current?.contentWindow &&
            epoch === nativeLoadEpoch.current
          )
            setFeedError(String(e));
        }
        return;
      }
      if (m.type === "native-load-reset" && Number.isSafeInteger(m.epoch)) {
        nativeLoadEpoch.current = m.epoch;
        setNativeLoads({});
        setCapacityNotices({});
        setCapacityDialog(null);
        return;
      }
      if (
        m.type === "capacity-notice" &&
        m.epoch === nativeLoadEpoch.current &&
        typeof m.key === "string" &&
        m.key.length <= 160
      ) {
        const periods: Record<string, string> = {
          "1": "M1",
          "5": "M5",
          "15": "M15",
          "30": "M30",
          "60": "H1",
          "240": "H4",
          "1D": "D1",
          "1W": "W1",
          "1M": "MN",
        };
        setCapacityNotices((previous) => {
          const next = { ...previous };
          if (m.phase === "clear") {
            if (!next[m.key] || m.id === undefined || next[m.key].id === m.id)
              delete next[m.key];
          } else if (
            ["filling", "limited", "failed"].includes(m.phase) &&
            typeof m.message === "string"
          ) {
            next[m.key] = {
              id: m.id,
              instrument:
                typeof m.symbol === "string"
                  ? m.symbol.replace(/^MWP:/, "").slice(0, 80)
                  : "历史容量",
              timeframe: periods[m.resolution] || "",
              phase: m.phase,
              message: m.message.slice(0, 1000),
              ...(Number.isFinite(m.requested)
                ? { requested: m.requested }
                : {}),
              ...(Number.isFinite(m.actual) ? { actual: m.actual } : {}),
              ...(Number.isFinite(m.limit) ? { limit: m.limit } : {}),
              ...(Number.isFinite(m.resident) ? { resident: m.resident } : {}),
              scope: m.scope,
              started:Number.isFinite(m.started) ? m.started : previous[m.key]?.started,
              finished:Number.isFinite(m.finished) ? m.finished : undefined,
              totalBars:Number.isSafeInteger(m.totalBars) ? m.totalBars : undefined,
              loadedBars:Number.isSafeInteger(m.loadedBars) ? m.loadedBars : undefined,
              pages:Number.isSafeInteger(m.pages) ? m.pages : undefined,
              estimatedPages:Number.isSafeInteger(m.estimatedPages) ? m.estimatedPages : undefined,
              batch:Number.isSafeInteger(m.batch) ? m.batch : undefined,
              completedBatch:Number.isSafeInteger(m.completedBatch) ? m.completedBatch : undefined,
            };
          }
          return next;
        });
        return;
      }
      if (
        typeof m.id === "string" &&
        m.id.length <= 100 &&
        typeof m.type === "string" &&
        m.type.startsWith("native-load-")
      ) {
        if (m.epoch !== nativeLoadEpoch.current) return;
        if (m.type === "native-load-end") {
          setNativeLoads((previous) => {
            const load = previous[m.id];
            if (!load) return previous;
            const duration = Date.now() - load.started;
            if (duration < HISTORY_NOTICE_DELAY_MS || duration >= HISTORY_NOTICE_DELAY_MS + 500) {
              const next = { ...previous };
              delete next[m.id];
              return next;
            }
            return { ...previous, [m.id]: { ...load, ended: true } };
          });
          setTimeout(
            () =>
              setNativeLoads((previous) => {
                if (!previous[m.id]?.ended) return previous;
                const next = { ...previous };
                delete next[m.id];
                return next;
              }),
            750,
          );
          return;
        }
        setNativeLoads((previous) => {
          const next = { ...previous };
          if (
            m.type === "native-load-start" &&
            typeof m.instrument === "string" &&
            m.instrument.length <= 80 &&
            frames.has(m.timeframe) &&
            Number.isSafeInteger(m.count) &&
            m.count > 0 &&
            Number.isFinite(m.from) &&
            Number.isFinite(m.to)
          ) {
            next[m.id] = {
              instrument: m.instrument,
              timeframe: m.timeframe,
              count: m.count,
              from: m.from,
              epoch: m.epoch,
              to: m.to,
              started: Date.now(),
              phase: "queued",
              ...(Number.isSafeInteger(m.boundaryId) ? {boundaryId:m.boundaryId,batch:m.batch} : {}),
              ...(Number.isSafeInteger(m.estimatedPages) && m.estimatedPages > 0
                ? { estimatedPages:m.estimatedPages } : {}),
            };
          } else if (m.type === "native-load-applying" && next[m.id]) {
            next[m.id] = {
              ...next[m.id],
              phase: "applying",
              received: m.count,
            };
          }
          return next;
        });
        return;
      }
      if (
        m.type === "managed-dataset" &&
        typeof m.dataset?.instrument === "string" &&
        frames.has(m.dataset?.timeframe)
      ) {
        const dataset = m.dataset;
        setDatasetViews((previous) => ({
          ...previous,
          [dataset.instrument + "|" + dataset.timeframe]: dataset,
        }));
        return;
      }
      if (
        m.type === "maintenance-required" &&
        !mobile &&
        typeof m.instrument === "string" &&
        m.instrument.length <= 40
      ) {
        setMaintenanceInstrument(m.instrument);
        return;
      }
      if (m.type === "cancel-request") {
        marketRequests.get(source)?.get(m.id)?.abort();
        return;
      }
      if (m.type === "loaded") {
        await provider.clear();
        try {
          if (!mobile) await api("/advanced-charts/preferences/migrate", {});
          const [catalog, preferences, capabilities] = await Promise.all([
            api("/advanced-charts/catalog"),
            api("/advanced-charts/preferences"),
            api("/charts/history-capabilities"),
          ]);
          historyCapabilities.current = capabilities;
          reply({
            type: "init",
            history_capabilities: capabilities,
            document: current.current?.document || {},
            workspace: current.current,
            readonly: mobile,
            catalog,
            preferences,
            initial_symbol: current.current?.initial_symbol,
          });
        } catch (e) {
          setError(String(e));
        }
      } else if (m.type === "export-selection") {
        const value = m.selection;
        if (
          value &&
          typeof value.instrument === "string" &&
          value.instrument.length <= 80 &&
          frames.has(value.timeframe) &&
          Array.isArray(value.indicators) &&
          value.indicators.length <= 12 &&
          JSON.stringify(value).length < 20000
        )
          setExportSelection(value);
      } else if (m.type === "workspace-action") {
        if (m.action === "home") location.assign("/");
        else if (m.action === "market-data") location.assign("/market-data");
        else if (m.action === "logout") {
          try {
            if (!mobile && unsaved.current) await flush();
            await api("/logout", {});
            location.assign("/");
          } catch (e) {
            setError(String(e));
          }
        } else if (!mobile && m.action === "create") await create();
        else if (!mobile && m.action === "recover") await copy();
      } else if (m.type === "theme-changed") {
        if (typeof m.theme === "string" && /^(dark|light)$/i.test(m.theme))
          setChartTheme(m.theme.toLowerCase());
      } else if (m.type === "ready") {
        setNativeReady(true);
        setStatus("已加载 · 行情每15秒检查");
      } else if (m.type === "viewport-notice") {
        if (typeof m.key !== "string" || m.key.length > 200) return;
        setSyncNotices((previous) => {
          if (m.key === "*") return {};
          const next = { ...previous };
          if (m.text) next[m.key] = String(m.text).slice(0, 500);
          else delete next[m.key];
          return next;
        });
      } else if (m.type === "feed-poll-state") {
        if (typeof m.key !== "string" || m.key.length > 2000) return;
        setPollErrors((previous) => {
          const next = { ...previous };
          if (m.error) next[m.key] = String(m.error).slice(0, 500);
          else delete next[m.key];
          return next;
        });
      } else if (m.type === "error")
        setFeedError(String(m.error).slice(0, 500));
      else if (m.type === "workspace-dirty") {
        if (!mobile) unsaved.current = true;
        setStatus("布局有未保存更改");
      } else if (m.type === "native-saving") {
        if (!mobile) unsaved.current = true;
        setStatus("正在保存");
      } else if (m.type === "native-saved") {
        unsaved.current = false;
        setStatus("已保存");
        flushWaiters.current.splice(0).forEach((w) => w.resolve());
      } else if (m.type === "workspace") {
        const q = m.query;
        if (
          !q ||
          !["list", "load", "save", "delete"].includes(q.op) ||
          JSON.stringify(q).length > 4_100_000 ||
          (mobile && ["save", "delete"].includes(q.op))
        ) {
          reply({ type: "result", id: m.id, error: "工作区操作不允许" });
          return;
        }
        if (
          ["load", "delete"].includes(q.op) &&
          !/^[a-zA-Z0-9-]{1,40}$/.test(q.args?.id || "")
        ) {
          reply({ type: "result", id: m.id, error: "无效工作区标识" });
          return;
        }
        try {
          await queue.current;
          if (
            blocked.current &&
            (q.op === "load" || (q.op === "save" && q.args?.id))
          )
            throw Error("存在未保存草稿，请先复制恢复为独立工作区");
          const draftId = q.op === "save" ? q.args?.id : null;
          const draft = draftId
            ? JSON.stringify({
                ...(current.current?.id === draftId
                  ? current.current?.document
                  : {}),
                engine: "tv31",
                schemaVersion: 1,
                state: JSON.parse(q.args.content),
                symbol: q.args.symbol,
                interval: q.args.resolution,
              })
            : null;
          if (draftId && draft) {
            try {
              localStorage.setItem("mw-tv-draft:" + draftId, draft);
            } catch {
              setError("本地草稿空间不足，请勿关闭页面，等待服务器保存完成");
            }
          }
          let result;
          if (q.op === "list")
            result = await api("/advanced-charts/native-charts");
          else if (q.op === "load")
            result = await api("/advanced-charts/native-charts/" + q.args.id);
          else if (q.op === "save")
            result = await api("/advanced-charts/native-charts/save", q.args);
          else
            result = await api(
              "/advanced-charts/workspaces/" + q.args.id + "/delete",
              { revision: q.args.revision },
            );
          if (
            q.op === "load" &&
            (!result.document?.state ||
              Object.keys(result.document.state).length === 0)
          ) {
            // A never-saved workspace has no vendor layout envelope. Initialize
            // a fresh widget instead of loading {} or copying the current chart.
            select({
              id: result.id,
              name: result.name,
              revision: result.revision,
              document: result.document,
            });
            setFeedError("");
            return;
          }
          if (q.op === "save" || q.op === "load") {
            // A successful native Save As binds a new independent workspace.
            // Keep any older failed draft available under its original ID.
            if (q.op === "save" && !q.args?.id) {
              blocked.current = false;
              setError("");
              setFeedError("");
              setStatus("已另存为独立工作区");
            }
            if (
              draftId &&
              localStorage.getItem("mw-tv-draft:" + draftId) === draft
            )
              localStorage.removeItem("mw-tv-draft:" + draftId);
            current.current = {
              id: result.id,
              name: result.name,
              revision: result.revision,
              document: result.document,
            };
            // Native loads happen inside the existing widget. Reflect their
            // identity without recreating the iframe or discarding chart state.
            setActive(current.current);
            setRows((p) =>
              p.some((x) => x.id === result.id)
                ? p.map((x) => (x.id === result.id ? current.current! : x))
                : [current.current!, ...p],
            );
          }
          if (q.op === "delete")
            setRows((previous) =>
              previous.filter((row) => row.id !== q.args.id),
            );
          reply({ type: "result", id: m.id, result });
          if (q.op === "delete" && current.current?.id === q.args.id) {
            // Do not leave a widget bound to a record which no longer exists.
            // Deletion is already committed; a refresh failure must not revive it.
            current.current = null;
            unsaved.current = false;
            blocked.current = false;
            setActive(null);
            setError("");
            setStatus("工作区已删除");
            try {
              const remaining = await refresh();
              if (remaining[0]) select(remaining[0]);
            } catch (e) {
              setError("工作区已删除，列表加载失败：" + String(e));
            }
          }
        } catch (e) {
          if (
            q.op === "save" &&
            q.args?.id &&
            localStorage.getItem("mw-tv-draft:" + q.args.id)
          ) {
            blocked.current = true;
            setStatus("保存已暂停 · 草稿已保留，请复制恢复");
          }
          setError(String(e));
          reply({
            type: "result",
            id: m.id,
            error: String(e),
            errorDetails: apiErrorDetails(e),
          });
        }
      } else if (m.type === "account-password") {
        const body = m.query;
        if (
          !body ||
          typeof body.current_password !== "string" ||
          typeof body.new_password !== "string" ||
          [...body.current_password].length > 512 ||
          [...body.new_password].length > 512
        ) {
          reply({ type: "result", id: m.id, error: "无效密码请求" });
          return;
        }
        try {
          reply({
            type: "result",
            id: m.id,
            result: await api("/account/password", body),
          });
        } catch (error) {
          reply({ type: "result", id: m.id, error: String(error) });
        }
      } else if (m.type === "style-template-name") {
        const name = mobile
          ? null
          : prompt("图表样式模板名称（同名将覆盖）", "我的样式");
        const value = name?.trim() || "";
        reply(
          value.length > 128
            ? { type: "result", id: m.id, error: "模板名称不能超过128字" }
            : { type: "result", id: m.id, result: value },
        );
      } else if (m.type === "preferences") {
        const q = m.query;
        if (
          mobile ||
          !q ||
          !["save", "delete"].includes(q.op) ||
          JSON.stringify(q).length > 1_100_000
        ) {
          reply({ type: "result", id: m.id, error: "设置请求不允许" });
          return;
        }
        if (q.op === "delete" && !/^[a-f0-9]{64}$/.test(q.args?.id || "")) {
          reply({ type: "result", id: m.id, error: "无效设置标识" });
          return;
        }
        try {
          reply({
            type: "result",
            id: m.id,
            result: await api(
              q.op === "save"
                ? "/advanced-charts/preferences/save"
                : "/advanced-charts/preferences/" + q.args.id + "/delete",
              q.args,
            ),
          });
        } catch (e) {
          reply({
            type: "result",
            id: m.id,
            error: String(e),
            errorDetails: apiErrorDetails(e),
          });
        }
      } else if (m.type === "market") {
        const q = m.query;
        const endpoints: Record<string, string> = {
          search: "/market-data/series/search",
          searchPage: "/market-data/series/page",
          resolve: "/market-data/resolve",
          viewport: "/market-data/viewport-session",
          history: "/market-data/history",
          historyCache: "/market-data/history/cache",
          historyDemand: "/market-data/history/demand",
          dataset: "/market-data/dataset",
          activity: "/market-data/activity",
          retry: "/market-data/retry",
          quotes: "/market-data/quotes",
          serverTime: "/readyz",
        };
        if (
          !q ||
          !Object.hasOwn(endpoints, q.op) ||
          JSON.stringify(q).length > 4000 ||
          (q.op === "retry" &&
            !/^[a-zA-Z0-9-]{1,40}$/.test(String(q.args?.id || ""))) ||
          inflight.current >= 8 ||
          (q.native_history !== undefined &&
            (q.series_kind !== "provider" ||
              !q.native_history ||
              typeof q.native_history !== "object" ||
              Array.isArray(q.native_history) ||
              !Number.isInteger(q.native_history.chart_count) ||
              q.native_history.chart_count < 1 ||
              q.native_history.chart_count > 8 ||
              (q.native_history.focused !== null &&
                typeof q.native_history.focused !== "boolean") ||
              typeof q.native_history.historical_navigation !== "boolean")) ||
          (q.history_observation !== undefined &&
            (!q.native_history ||
              !q.history_observation ||
              typeof q.history_observation !== "object" ||
              Array.isArray(q.history_observation) ||
              !["revision", "observed_at", "first", "last"].every(
                (field) =>
                  Number.isSafeInteger(q.history_observation[field]) &&
                  q.history_observation[field] >= 0,
              ) ||
              q.history_observation.first > q.history_observation.last))
        ) {
          reply({ type: "result", id: m.id, error: "无效行情请求" });
          return;
        }
        const controller = new AbortController();
        if (!marketRequests.has(source)) marketRequests.set(source, new Map());
        const sourceRequests = marketRequests.get(source)!;
        sourceRequests.set(m.id, controller);
        inflight.current++;
        try {
          let result;
          if (q.op === "serverTime") {
            const response = await fetch("/readyz", {
              signal: controller.signal,
              credentials: "omit",
              cache: "no-store",
            });
            const health = await response.json();
            if (
              !response.ok ||
              !Number.isSafeInteger(health.time) ||
              health.time <= 0
            )
              throw Error("服务器时间暂不可用");
            result = Math.floor(health.time / 1000);
          } else
            result = await api(
              endpoints[q.op] +
                (q.op === "searchPage"
                  ? "?" + new URLSearchParams({query:String(q.args?.query || ""),
                    kind:["provider","history","composite"].includes(q.args?.kind) ? q.args.kind : "provider",
                    source:String(q.args?.source || ""),calendar:String(q.args?.calendar || ""),
                    page_size:"25",offset:String(Number.isSafeInteger(q.args?.offset) ? q.args.offset : 0)})
                  : q.op === "search"
                  ? "?query=" + encodeURIComponent(String(q.args?.query || "")) +
                    "&kind=" + encodeURIComponent(["provider", "history", "composite", "all"].includes(q.args?.kind) ? q.args.kind : "all") +
                    (q.args?.source ? "&source=" + encodeURIComponent(String(q.args.source)) : "")
                  : q.op === "retry"
                    ? "/" + encodeURIComponent(q.args.id)
                    : ""),
              ["search","searchPage"].includes(q.op) ? undefined : q.args,
              controller.signal,
            );
          reply({
            type: "result",
            id: m.id,
            result,
          });
        } catch (e) {
          reply({
            type: "result",
            id: m.id,
            error: String(e),
            errorDetails: apiErrorDetails(e),
          });
        } finally {
          sourceRequests.delete(m.id);
          if (!sourceRequests.size) marketRequests.delete(source);
          inflight.current--;
        }
      } else if (m.type === "status") {
        setStatus(String(m.text).slice(0, 200));
        if (m.text === "行情已加载") setFeedError("");
      } else if (m.type === "data") {
        const q = m.query;
        if (
          !q ||
          (q.indicators !== undefined &&
            (!Array.isArray(q.indicators) ||
              q.indicators.length > 1 ||
              JSON.stringify(q.indicators).length > 2000)) ||
          typeof q.instrument !== "string" ||
          q.instrument.length > 80 ||
          (q.series_kind !== undefined &&
            !["provider", "managed", "history", "composite"].includes(q.series_kind)) ||
          !frames.has(q.timeframe) ||
          !Number.isInteger(q.limit) ||
          q.limit < 1 ||
          q.limit >
            (q.series_kind === "provider"
              ? historyCapabilities.current?.max_bars || 20000
              : 2000) ||
          (q.before !== undefined &&
            (!Number.isSafeInteger(q.before) || q.before <= 0)) ||
          (q.revision_before !== undefined &&
            (!Number.isSafeInteger(q.revision_before) ||
              q.revision_before <= 0)) ||
          (q.revision_after !== undefined &&
            (!Number.isSafeInteger(q.revision_after) ||
              q.revision_after < 0)) ||
          (q.native_reserve !== undefined &&
            (q.series_kind !== "provider" ||
              !q.native_history ||
              !q.native_reserve ||
              typeof q.native_reserve !== "object" ||
              Array.isArray(q.native_reserve) ||
              !Number.isInteger(q.native_reserve.screen_bars) ||
              q.native_reserve.screen_bars < 1 ||
              q.native_reserve.screen_bars > 2000 ||
              ![1, 2].includes(q.native_reserve.batch_screens) ||
              !Number.isInteger(q.native_reserve.warmup_bars) ||
              q.native_reserve.warmup_bars < 0 ||
              q.native_reserve.warmup_bars > 2000 ||
              Object.keys(q.native_reserve).some(
                (k) =>
                  !["screen_bars", "batch_screens", "warmup_bars"].includes(k),
              ) ||
              q.indicators?.length ||
              q.history_observation !== undefined))
        ) {
          reply({
            type: "result",
            id: m.id,
            error: "请求不在允许范围内",
            errorDetails: {
              code:
                q?.series_kind === "provider" && q?.limit > 20000
                  ? "NATIVE_HISTORY_CAPACITY_EXCEEDED"
                  : "INVALID_HISTORY_REQUEST",
            },
          });
          return;
        }
        if (inflight.current >= 8) {
          reply({
            type: "result",
            id: m.id,
            error: "行情服务繁忙，请稍后重试",
            errorDetails: { code: "HISTORY_BUSY", status: 503 },
          });
          return;
        }
        const controller = new AbortController();
        if (!marketRequests.has(source)) marketRequests.set(source, new Map());
        const sourceRequests = marketRequests.get(source)!;
        sourceRequests.set(m.id, controller);
        inflight.current++;
        try {
          reply({
            type: "result",
            id: m.id,
            result: await (
              q.series_kind === "provider" &&
                q.native_history &&
                !q.native_reserve
                ? (body: unknown, signal: AbortSignal) =>
                    loadNativeHistory(
                      body,
                      signal,
                      historyCapabilities.current!,
                      (progress) =>
                        setNativeLoads((previous) => {
                          const key = q.history_progress_id;
                          if (
                            source !== frame.current?.contentWindow ||
                            q.history_progress_epoch !==
                              nativeLoadEpoch.current ||
                            !previous[key]
                          )
                            return previous;
                          return {
                            ...previous,
                            [key]: { ...previous[key], ...progress },
                          };
                        }),
                    )
                : (body: unknown, signal: AbortSignal) =>
                    api(
                      q.native_reserve ? "/charts/reserve" : "/charts/data",
                      body,
                      signal,
                    )
            )(
              {
                instrument: q.instrument,
                series_kind: q.series_kind || "managed",
                published: q.series_kind !== "provider",
                ...(q.series_kind === "composite" ? {client:q.client,
                  composite_revision_id:q.composite_revision_id,input_revision:q.input_revision} : {}),
                ...(typeof q.dataset_start === "number"
                  ? { dataset_start: q.dataset_start }
                  : {}),
                timeframe: q.timeframe,
                limit: q.limit,
                ...(q.series_kind === "provider"
                  ? {
                      countBack: q.countBack,
                      from: q.from,
                      firstDataRequest: q.firstDataRequest === true,
                      client: q.client,
                      ...(q.native_history !== undefined
                        ? { native_history: q.native_history,
                            history_page_bars:q.history_page_bars === 1000 ? 1000 : 4000 }
                        : {}),
                      ...(q.native_reserve !== undefined
                        ? { native_reserve: q.native_reserve }
                        : {}),
                      ...(q.history_observation !== undefined
                        ? { history_observation: q.history_observation }
                        : {}),
                    }
                  : {}),
                indicators: q.indicators || [],
                ...(q.before ? { before: q.before } : {}),
                track_history: q.track_history === true,
                ...(q.revision_after !== undefined
                  ? { revision_after: q.revision_after }
                  : {}),
                ...(q.revision_before
                  ? { revision_before: q.revision_before }
                  : {}),
              },
              controller.signal,
            ),
          });
        } catch (e) {
          reply({
            type: "result",
            id: m.id,
            error: String(e),
            errorDetails: apiErrorDetails(e),
          });
        } finally {
          sourceRequests.delete(m.id);
          if (!sourceRequests.size) marketRequests.delete(source);
          inflight.current--;
        }
      } else if (m.type === "snapshot") {
        const id = current.current?.id,
          document = m.document;
        if (
          mobile ||
          !id ||
          document?.engine !== "tv31" ||
          document?.schemaVersion !== 1 ||
          JSON.stringify(document).length > 4_000_000
        )
          return;
        const waiters = flushWaiters.current.splice(0);
        if (blocked.current) {
          waiters.forEach((w) => w.reject(Error("存在未保存草稿，请复制恢复")));
          return;
        }
        if (
          JSON.stringify(document) === JSON.stringify(current.current?.document)
        ) {
          waiters.forEach((w) => w.resolve());
          setStatus("已保存");
          return;
        }
        try {
          localStorage.setItem("mw-tv-draft:" + id, JSON.stringify(document));
        } catch (e) {
          setError("本地草稿空间不足，将继续尝试服务器保存");
        }
        setStatus("正在保存");
        queue.current = queue.current.then(async () => {
          if (blocked.current || current.current?.id !== id) {
            waiters.forEach((w) =>
              w.reject(Error("保存已暂停，请保留此页面并处理冲突")),
            );
            return;
          }
          try {
            const row = await api<Workspace>(
              `/advanced-charts/workspaces/${id}/save`,
              {
                name: current.current.name,
                revision: current.current.revision,
                document,
              },
            );
            if (current.current?.id === id) {
              current.current = row;
              setRows((prev) => prev.map((x) => (x.id === id ? row : x)));
              setStatus("已自动保存");
              setError("");
              if (
                localStorage.getItem("mw-tv-draft:" + id) ===
                JSON.stringify(document)
              )
                localStorage.removeItem("mw-tv-draft:" + id);
            }
            waiters.forEach((w) => w.resolve());
          } catch (e) {
            waiters.forEach((w) => w.reject(new Error(String(e))));
            blocked.current = true;
            setStatus("保存已暂停");
            setError(String(e));
          }
        });
      }
    };
    addEventListener("message", listener);
    return () => {
      removeEventListener("message", listener);
      void provider.dispose();
      for (const requests of marketRequests.values())
        for (const controller of requests.values()) controller.abort();
    };
  }, [origin]);
  async function create() {
    const name = prompt("工作区名称", "我的图表");
    if (!name?.trim()) return;
    try {
      await flush();
      const row = await api<Workspace>("/advanced-charts/workspaces", {
        name: name.trim(),
      });
      setRows((p) => [row, ...p]);
      select(row);
    } catch (e) {
      setError(String(e));
    }
  }
  async function copy() {
    try {
      if (!blocked.current) await flush();
      const old = current.current;
      if (!old) return;
      const draft = localStorage.getItem("mw-tv-draft:" + old.id);
      const document = draft ? JSON.parse(draft) : old.document;
      const row = await api<Workspace>("/advanced-charts/workspaces", {
        name: old.name + " 副本",
      });
      const saved = await api<Workspace>(
        `/advanced-charts/workspaces/${row.id}/save`,
        { name: row.name, revision: row.revision, document },
      );
      localStorage.removeItem("mw-tv-draft:" + old.id);
      setRows((p) => [saved, ...p]);
      select(saved);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <main className="advanced-workspace" data-theme={chartTheme}>
      {(Object.keys(nativeLoads).length > 0 ||
        Object.keys(capacityNotices).length > 0) && (
        <HistoryLoadingNotice
          loads={nativeLoads}
          capacities={capacityNotices}
          onCancel={() => post({ type: "cancel-history" })}
          onSettings={() => post({ type: "history-capacity-open" })}
          onDismiss={() =>
            setCapacityNotices((previous) =>
              Object.fromEntries(
                Object.entries(previous).filter(
                  ([, notice]) => notice.phase === "filling",
                ),
              ),
            )
          }
        />
      )}
      {capacityDialog && (
        <HistoryCapacityDialog
          {...capacityDialog}
          theme={chartTheme}
          onClose={() => setCapacityDialog(null)}
          onSaved={(capabilities) => {
            historyCapabilities.current = capabilities;
            post({ type: "history-capabilities", capabilities });
          }}
        />
      )}
      {historyPlansOpen && (
        <HistoryPlansDialog
          onClose={() => setHistoryPlansOpen(false)}
          readonly={mobile}
          onRefresh={() => post({ type: "refresh-managed" })}
          views={datasetViews}
        />
      )}
      {maintenanceInstrument && (
        <MaintenanceDialog
          instrument={maintenanceInstrument}
          onClose={() => setMaintenanceInstrument(null)}
          onSubmitted={() => {
            setMaintenanceInstrument(null);
            setHistoryPlansOpen(true);
          }}
        />
      )}
      {exportSelection && (
        <ExportDialog
          selection={exportSelection}
          onClose={() => setExportSelection(null)}
        />
      )}
      <div
        className="advanced-status"
        role="status"
        aria-live="polite"
        data-idle={/^(行情已加载|已加载|已保存|已另存)/.test(status)}
      >
        {status}
      </div>
      {!nativeReady && noticeMessages.length > 0 && (
        <div className="advanced-loading-notice" role="alert">
          {noticeMessages
            .map((notice) => notice.text.replace(/^(?:Error:\s*)+/, ""))
            .join("；")}
          {blocked.current && !mobile && (
            <button onClick={copy}>复制恢复草稿</button>
          )}
        </div>
      )}
      {active ? (
        <iframe
          key={frameKey}
          ref={frame}
          title="专业图表工作区"
          data-workspace-id={active.id}
          src={`${origin}/?parent=${encodeURIComponent(location.origin)}`}
          sandbox="allow-scripts allow-same-origin allow-downloads"
          allowFullScreen
          referrerPolicy="no-referrer"
        />
      ) : (
        <section>
          <a href="/">返回守望</a>
          <h1>专业图表夹</h1>
          <p>独立工作区，沿用守望行情。</p>
          <button disabled={mobile} onClick={create}>
            新建工作区
          </button>
        </section>
      )}
      {active && <ChartAlertsPanel key={active.id} workspaceId={active.id} context={alertContext?.association.workspace_id === active.id ? alertContext : null}
        open={alertsOpen} theme={chartTheme} readonly={mobile} associationNotices={alertAssociations} onClose={() => setAlertsOpen(false)}
        onRequest={() => post({type: "chart-alert-create"})}
        onLocate={(row, event) => post({type: "chart-alert-locate", row, event})}
        onDrawingAction={(row, action) => post({type: "chart-alert-drawing-action", alert_id:row.id,action})}
        onRows={rows => post({type: "chart-alert-rows", rows})} />}
    </main>
  );
}
