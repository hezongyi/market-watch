import { validIndicatorRead } from "./indicatorRequests";
import {
  loadNativeHistory,
  type HistoryCapabilities,
} from "./nativeHistoryLoads";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, NavLink } from "react-router-dom";
import { useApp } from "../app/context";
import { defaultChart } from "../app/navigation";
import { centerLocation } from "../market-data/location";
import { api, apiErrorDetails } from "../api";
import "./advanced.css";
import { HistoryPlansDialog, type DatasetViews } from "./HistoryPlansDialog";
import { MaintenanceDialog } from "./MaintenanceDialog";
import { ExportDialog, type ExportSelection } from "./ExportDialog";
import { providerSubscriptions } from "./providerSubscriptions";
import { validAlertContext } from "./chartAlerts";
import { chartAlertUiRequest } from "./chartAlertUiApi";
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
  const appLocation = useLocation(), navigate = useNavigate(), { workspaceId } = useParams();
  const app = useApp(), appRef = useRef(app); appRef.current = app;
  const urlRef = useRef(appLocation); urlRef.current = appLocation;
  const capturing = useRef<{resolve: () => void; reject: (error: Error) => void} | null>(null);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null), titleText = useRef(""), titleLast = useRef(0), titleIdentity = useRef("");
  const remember = (id: string, replace = false) => {
    localStorage.setItem("mw.last-workspace.v1", id);
    const query = new URLSearchParams(urlRef.current.search); query.delete("platform");
    const next = `/advanced-charts/${id}` + (query.size ? "?"+query : "") + urlRef.current.hash;
    sessionStorage.setItem("mw.chart-return.v1", next);
    if (urlRef.current.pathname !== `/advanced-charts/${id}`) navigate(next, { replace });
  };

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
  const alertUiSession = useRef("");
  const historyCapabilities = useRef<HistoryCapabilities | null>(null);
  const nativeLoadEpoch = useRef(0);
  const [capacityNotices, setCapacityNotices] = useState<
    Record<string, CapacityNotice>
  >({});
  const [nativeLoads, setNativeLoads] = useState<Record<string, NativeLoad>>(
    {},
  );
  const [indicatorStates,setIndicatorStates]=useState<Record<string,{index:number;name:string;state:string;error:string;epoch:number;previousParams:string}>>({});
  const [chartFailures,setChartFailures]=useState<{index:number;symbol:string;resolution:string;label:string;error:string;epoch:number}[]>([]);
  const [capacityDialog, setCapacityDialog] = useState<{
    capabilities: HistoryCapabilities;
    usage: number;
  } | null>(null);
  const [status, setStatus] = useState("正在加载工作区"),
    [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null),
    current = useRef<Workspace | null>(null);
  const unsaved = useRef(false);
  const centerSession = useRef<string | null>(null);
  const deepCenter = useRef(new URLSearchParams(location.search).get("data_center"));
  const requestedPlatform = new URLSearchParams(appLocation.search).get("platform");
  // StrictMode replays opening effects. Reuse each creation until navigation
  // resolves it, so one compatibility entry cannot create two workspaces.
  const entryCreations = useRef(new Map<string, Promise<Workspace>>());
  const createEntry = (key: string, body: { name: string; symbol?: string }) => {
    let pending = entryCreations.current.get(key);
    if (!pending) {
      pending = api<Workspace>("/advanced-charts/workspaces", body);
      entryCreations.current.set(key, pending);
      pending.catch(() => entryCreations.current.delete(key));
    }
    return pending;
  };
  const flushWaiters = useRef<
    { resolve: () => void; reject: (e: Error) => void }[]
  >([]);
  // Browser zoom narrows CSS pixels on a desktop. It must not remove editing
  // and management; coarse-pointer devices retain the existing read-only view.
  const mobile = matchMedia("(pointer:coarse)").matches;
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
    alertUiSession.current = "";
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
    remember(row.id, !workspaceId);
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
    return app.registerGuard({
      dirty: () => !mobile && unsaved.current,
      shouldBlock: pathname => pathname !== `/advanced-charts/${current.current?.id}`,
      save: flush,
      discard: () => {
        if (current.current) localStorage.removeItem("mw-tv-draft:" + current.current.id);
        unsaved.current = false; blocked.current = false; post({ type: "discard-changes" });
      },
      preserve: () => {
        if (mobile || !unsaved.current) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          capturing.current = {resolve, reject}; post({ type: "capture-draft" });
          setTimeout(() => { if (capturing.current?.resolve === resolve) { capturing.current = null; reject(Error("图表草稿尚未捕获")); } }, 10000);
        });
      },
    });
  }, [app.registerGuard, origin, mobile]);
  useEffect(() => {
    if (current.current && current.current.id === workspaceId) return;
    let cancelled = false;
    const opening = workspaceId
      ? api<Workspace>("/advanced-charts/workspaces/" + encodeURIComponent(workspaceId)).then(row => [row])
      : requestedPlatform
        ? mobile
          ? refresh().then(list => list.filter(row => row.document.symbol === requestedPlatform))
          : createEntry("platform:" + requestedPlatform, {name:"平台行情",symbol:requestedPlatform}).then(row => [row])
      : refresh().then(async list => {
          const last = localStorage.getItem("mw.last-workspace.v1");
          if (last) { const found = list.find(row => row.id === last); if (found) return [found]; }
          if (!list.length && deepCenter.current && !mobile) return [await createEntry("data-center", {name:"图表工作区"})];
          return list;
        });
    opening.then(list => {
      if (cancelled) return;
      if (list[0]) { setError(""); select(list[0]); }
      else { current.current = null; setActive(null); setStatus(mobile ? "请在桌面浏览器创建工作区" : "新建工作区开始使用"); }
    }).catch(e => { if (!cancelled) { setActive(null); current.current = null; setError(workspaceId ? "工作区不可用：" + String(e) : String(e)); } });
    return () => { cancelled = true; };
  }, [workspaceId, requestedPlatform, mobile]);
  useEffect(() => {
    if (active) sessionStorage.setItem("mw.chart-return.v1", appLocation.pathname + appLocation.search + appLocation.hash);
  }, [active?.id, appLocation]);
  useEffect(() => { if (nativeReady) post({ type: "app-state", pending: app.pending }); }, [nativeReady, app.pending]);
  useEffect(() => () => { if (titleTimer.current) clearTimeout(titleTimer.current); }, []);
  useEffect(() => {
    const marketRequests = new Map<Window, Map<number, AbortController>>();
    const provider = providerSubscriptions(
      api,
      (client) =>
        new EventSource(
          "/api/charts/stream/events?client=" + encodeURIComponent(client),
        ),
      (event) =>
        frame.current?.contentWindow?.postMessage(
          { channel, type: "market-event", event },
          origin,
        ),
      (error) => setError(String(error)),
      {subscribe: '/charts/stream/subscribe', unsubscribe: '/charts/stream/unsubscribe'},
    );
    const legacyProvider = providerSubscriptions(api,
      client => new EventSource('/api/charts/provider/events?client=' + encodeURIComponent(client)),
      event => frame.current?.contentWindow?.postMessage({channel, type:'provider-event', event}, origin),
      error => setError(String(error)));
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
      if (m.type === "draft-captured") {
        const waiter = capturing.current; capturing.current = null;
        if (!waiter) return;
        try {
          if (m.workspace_id !== current.current?.id || m.document?.engine !== "tv31" || m.document?.schemaVersion !== 1 || JSON.stringify(m.document).length > 4_000_000) throw Error("草稿响应无效");
          localStorage.setItem("mw-tv-draft:" + m.workspace_id, JSON.stringify(m.document)); waiter.resolve();
        } catch (e) { waiter.reject(new Error(String(e))); }
        return;
      }
      if (m.type === "confirm-leave") {
        const allowed = await appRef.current.confirmLeave();
        reply({ type:"result", id:m.id, result:allowed }); return;
      }
      if (m.type === "active-quote") {
        if (m.workspace_id !== current.current?.id || typeof m.ticker !== "string" || m.ticker.length > 150 || typeof m.label !== "string" || m.label.length > 150 || !Number.isSafeInteger(m.generation)) return;
        // Source, channel and workspace are checked before title data is used.
        const identity = `${m.workspace_id}:${m.generation}:${m.ticker}`;
        const price = Number.isFinite(m.price) && typeof m.formatted === "string" ? " " + m.formatted.slice(0, 60) : "";
        const percent = price && Number.isFinite(m.change) ? ` ${m.change > 0 ? "▲ +" : m.change < 0 ? "▼ −" : ""}${Math.abs(m.change).toFixed(2)}%` : "";
        titleText.current = m.label + price + percent + (m.historical ? " · 历史" : m.delayed ? " · 迟延" : "");
        const write = () => { titleTimer.current = null; if (document.title !== titleText.current) document.title = titleText.current; titleLast.current = performance.now(); };
        if (identity !== titleIdentity.current) { if (titleTimer.current) clearTimeout(titleTimer.current); titleIdentity.current = identity; write(); }
        else if (!titleTimer.current) titleTimer.current = setTimeout(write, Math.max(0, 1000 - (performance.now() - titleLast.current)));
        return;
      }
      if (m.type === "alerts-panel-state" && m.workspace_id === current.current?.id && typeof m.open === "boolean") {
        const url = new URL(location.href);
        if (m.open) url.searchParams.set("panel", "alerts"); else url.searchParams.delete("panel");
        navigate(url.pathname + url.search + url.hash, {replace:true}); return;
      }
      if (m.type === "data-center-state" && typeof m.session === "string" && /^[a-f0-9-]{36}$/.test(m.session)) {
        centerSession.current = m.open === true ? m.session : null;
        const url = new URL(location.href);
        if (m.open) url.searchParams.set("data_center", centerLocation(typeof m.location === "string" ? m.location : "/market-data"));
        else url.searchParams.delete("data_center");
        navigate(url.pathname + url.search + url.hash, {replace:true});
        if (m.open) { setCapacityDialog(null); setExportSelection(null); }
        return;
      }
      if (m.type === "data-center-replay" && m.session === centerSession.current && /^\/replay(?:\?dataset_version=[a-f0-9-]{36})?$/.test(m.path)) {
        navigate(m.path); return;
      }
      if (m.type === "data-center-api") {
        const q = m.query;
        if (mobile || !Number.isSafeInteger(m.id) || m.id <= 0 || !q || q.session !== centerSession.current || typeof q.path !== "string" || q.path.length > 4000 ||
          JSON.stringify(q).length > 100000 || !/^\/market-data\/(?:center|datasets|history-catalog|date-boundary|composites|tasks|versions|series|resolve|capabilities|sources|live)(?:\/[A-Za-z0-9_-]+)*(?:\?[^#]*)?$/.test(q.path) && q.path !== "/charts/provider/configure") {
          reply({type:"result",id:m.id,error:"数据中心请求不允许",errorDetails:{status:403,code:"FORBIDDEN"}});return;
        }
        const controller = new AbortController();
        if (!marketRequests.has(source)) marketRequests.set(source, new Map());
        marketRequests.get(source)!.set(m.id, controller);
        try {
          const result = await api(q.path, q.body, controller.signal);
          reply({type:"result",id:m.id,result});
        } catch (error: any) {
          reply({type:"result",id:m.id,error:error.message || String(error),errorDetails:{...apiErrorDetails(error),status:error.status}});
        } finally {
          marketRequests.get(source)?.delete(m.id);
        }
        return;
      }
      const readAlertDraft = (workspace: string | undefined) => {
        try {
          const value = JSON.parse(
            localStorage.getItem("mw-chart-alert-draft:" + workspace) || "null",
          );
          return value?.config?.instrument &&
            typeof value.requestId === "string"
            ? value
            : null;
        } catch {
          return null;
        }
      };
      if (m.type === "chart-alert-ui-draft") {
        if (
          m.session !== alertUiSession.current ||
          !m.session ||
          m.workspace_id !== current.current?.id ||
          m.draft === undefined ||
          JSON.stringify(m.draft).length > 20_000
        )
          return;
        if (
          m.draft &&
          (!m.draft.config?.instrument || typeof m.draft.requestId !== "string")
        )
          return;
        try {
          const key = "mw-chart-alert-draft:" + m.workspace_id;
          if (m.draft) localStorage.setItem(key, JSON.stringify(m.draft));
          else localStorage.removeItem(key);
        } catch {
          setError("本地告警草稿保存失败，请保留表单后重试");
        }
        return;
      }
      if (m.type === "chart-alert-context") {
        if (mobile || !validAlertContext(m.context, current.current?.id))
          return;
        reply({ type: "chart-alert-ui-context", context: m.context });
        return;
      }
      if (m.type === "chart-alert-ui-rpc") {
        const workspace = current.current?.id,
          session = alertUiSession.current;
        if (!workspace || !session || !Number.isSafeInteger(m.id) || m.id <= 0)
          return;
        try {
          const result = await chartAlertUiRequest(
            m.query,
            { workspace_id: workspace, session },
            () =>
              current.current?.id === workspace &&
              alertUiSession.current === session &&
              frame.current?.contentWindow === source,
            (path, body) => {
              if (
                mobile &&
                body !== undefined &&
                path !== "/chart-alerts/capabilities" &&
                !path.endsWith("/ack")
              )
                throw Error("当前图表只读");
              return api(path, body);
            },
          );
          reply({ type: "result", id: m.id, result });
        } catch (e) {
          reply({
            type: "result",
            id: m.id,
            error: String(e),
            errorDetails: { ...apiErrorDetails(e), status: (e as any)?.status },
          });
        }
        return;
      }
      if (m.type === "chart-alert-rpc") {
        const q = m.query;
        const requestWorkspace = current.current?.id;
        if (
          mobile ||
          !Number.isSafeInteger(m.id) ||
          m.id <= 0 ||
          !q ||
          JSON.stringify(q).length > 20_000 ||
          !["geometry", "edit", "read", "lifecycle"].includes(q.op)
        )
          return;
        try {
          let result;
          if (q.op === "geometry")
            result = await api("/chart-alerts/geometry", q.args);
          else if (
            typeof q.alert_id === "string" &&
            /^[a-f0-9-]{36}$/.test(q.alert_id)
          ) {
            if (q.op === "read")
              result = await api(`/chart-alerts/${q.alert_id}`);
            else {
              // A drawing message may only affect the persisted object from this
              // workspace; it cannot replace an arbitrary alert configuration.
              const row = await api(`/chart-alerts/${q.alert_id}`),
                a = row.config.association;
              if (
                !a ||
                requestWorkspace !== current.current?.id ||
                q.workspace_id !== requestWorkspace ||
                a.workspace_id !== requestWorkspace ||
                a.object_id !== q.object_id ||
                a.chart_id !== q.chart_id
              )
                throw Error("告警图表关联已改变");
              if (q.op === "lifecycle" && q.action === "drawing_deleted")
                result = await api(`/chart-alerts/${q.alert_id}/lifecycle`, {
                  version: q.version,
                  control_revision: q.control_revision,
                  request_id: q.request_id,
                  action: "drawing_deleted",
                });
              else if (q.op === "edit" && q.line && a.object_kind === "drawing")
                result = await api(`/chart-alerts/${q.alert_id}/edit`, {
                  version: q.version,
                  config: {
                    ...row.config,
                    condition: {
                      ...row.config.condition,
                      right: { kind: "line", line: q.line },
                    },
                    association: { ...a, generation: q.generation },
                  },
                });
              else throw Error("不允许的画线告警操作");
            }
          } else throw Error("无效告警请求");
          reply({ type: "result", id: m.id, result });
        } catch (e) {
          reply({
            type: "result",
            id: m.id,
            error: String(e),
            errorDetails: apiErrorDetails(e),
          });
        }
        return;
      }
      if (
        m.type === "market-subscribe" ||
        m.type === "market-unsubscribe" ||
        m.type === "market-accept" ||
        m.type === "provider-subscribe" || m.type === "provider-unsubscribe"
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
          const transport = m.type.startsWith('provider-') ? legacyProvider : provider;
          if (m.type === 'market-accept') {
            await provider.accept(args);
          } else if (m.type.endsWith('-subscribe')) {
            await transport.subscribe(args);
          } else {
            await transport.unsubscribe(args);
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
        setChartFailures([]);setIndicatorStates({});
        nativeLoadEpoch.current = m.epoch;
        setNativeLoads({});
        setCapacityNotices({});
        setCapacityDialog(null);
        return;
      }
      if(m.type==='chart-indicator-state' && m.epoch===nativeLoadEpoch.current &&
        Number.isSafeInteger(m.index) && m.index>=0 && m.index<8 && typeof m.id==='string' &&
        typeof m.name==='string' && typeof m.error==='string' && ['preparing','ready','error','removed'].includes(m.state)) {
        setIndicatorStates(old=>{const next={...old},key=m.index+'|'+m.id;
          if(m.state==='ready' || m.state==='removed')delete next[key];
          else next[key]={index:m.index,name:m.name,state:m.state,error:m.error,epoch:m.epoch,
            previousParams:m.previousParams && typeof m.previousParams==='object' && !Array.isArray(m.previousParams)
              ? Object.entries(m.previousParams).filter(([key,value])=>key.length<80 && ['string','number','boolean'].includes(typeof value))
                .map(([key,value])=>key+'='+String(value).slice(0,100)).join(', ') : ''};
          return next;});return;
      }
      if (m.type === 'chart-history-failures' && m.epoch===nativeLoadEpoch.current && Array.isArray(m.failures)) {
        setChartFailures(m.failures.filter((item:any)=>Number.isSafeInteger(item.index) &&
          item.index>=0 && item.index<8 && typeof item.symbol==='string' && typeof item.resolution==='string' &&
          typeof item.label==='string' && typeof item.error==='string').map((item:any)=>({...item,epoch:m.epoch})));
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
              started: Number.isFinite(m.started)
                ? m.started
                : previous[m.key]?.started,
              finished: Number.isFinite(m.finished) ? m.finished : undefined,
              totalBars: Number.isSafeInteger(m.totalBars)
                ? m.totalBars
                : undefined,
              loadedBars: Number.isSafeInteger(m.loadedBars)
                ? m.loadedBars
                : undefined,
              pages: Number.isSafeInteger(m.pages) ? m.pages : undefined,
              estimatedPages: Number.isSafeInteger(m.estimatedPages)
                ? m.estimatedPages
                : undefined,
              batch: Number.isSafeInteger(m.batch) ? m.batch : undefined,
              completedBatch: Number.isSafeInteger(m.completedBatch)
                ? m.completedBatch
                : undefined,
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
            if (
              duration < HISTORY_NOTICE_DELAY_MS ||
              duration >= HISTORY_NOTICE_DELAY_MS + 500
            ) {
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
              ...(Number.isSafeInteger(m.boundaryId)
                ? { boundaryId: m.boundaryId, batch: m.batch }
                : {}),
              ...(Number.isSafeInteger(m.estimatedPages) && m.estimatedPages > 0
                ? { estimatedPages: m.estimatedPages }
                : {}),
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
        alertUiSession.current = crypto.randomUUID();
        await provider.clear();
        await legacyProvider.clear();
        try {
          if (!mobile) await api("/advanced-charts/preferences/migrate", {});
          const [catalog, preferences, capabilities] = await Promise.all([
            api("/advanced-charts/catalog"),
            api("/advanced-charts/preferences"),
            api("/charts/history-capabilities"),
          ]);
          const stored = (preferences as any[]).find(
            (preference) => preference?.kind === "setting" && preference?.name === "mw.watchlists.v1",
          )?.content?.value;
          const active = Array.isArray(stored?.lists)
            ? stored.lists.find((list: any) => list?.id === stored.active) || stored.lists[0]
            : undefined;
          const tickers: string[] = [...new Set<string>(
            (Array.isArray(active?.symbols) ? active.symbols as unknown[] : [])
              .filter((ticker: unknown): ticker is string => typeof ticker === "string")
              .filter((ticker) => !ticker.startsWith("###"))
              .slice(0, 32),
          )];
          const decodeWatchlistTicker = (ticker: string) => {
            if (ticker.startsWith("MWH:")) return { instrument: ticker.slice(4), series_kind: "history" };
            if (ticker.startsWith("MWC:")) return { instrument: ticker.slice(4), series_kind: "composite" };
            if (ticker.startsWith("MWP:")) return { instrument: ticker.slice(4), series_kind: "provider" };
            return { instrument: ticker, series_kind: "managed" };
          };
          const entries: [string, Record<string, unknown>][] = [];
          let cursor = 0;
          // One budget for the whole optional prewarm, rather than four
          // seconds for each successive batch of four stale identities.
          const controller = new AbortController();
          let timeout: number | undefined;
          const deadline = new Promise<void>((resolve) => {
            timeout = window.setTimeout(() => { controller.abort(); resolve(); }, 4000);
          });
          const worker = async () => {
            while (cursor < tickers.length && !controller.signal.aborted) {
              const ticker = tickers[cursor++];
              try {
                const metadata = await api<Record<string, unknown>>(
                  "/market-data/resolve",
                  { ...decodeWatchlistTicker(ticker), timeframe: "M1" },
                  controller.signal,
                );
                if (!controller.signal.aborted) entries.push([ticker, metadata]);
              } catch (_) {
                // A stale list entry must keep its native fallback behavior.
              }
            }
          };
          try {
            await Promise.race([
              Promise.all(Array.from({ length: Math.min(4, tickers.length) }, worker)),
              deadline,
            ]);
          } finally { window.clearTimeout(timeout); }
          historyCapabilities.current = capabilities;
          reply({
            type: "init",
            alert_ui_session: alertUiSession.current,
            alert_ui_draft: readAlertDraft(current.current?.id),
            history_capabilities: capabilities,
            document: current.current?.document || {},
            workspace: current.current,
            readonly: mobile,
            catalog,
            preferences: localStorage.getItem("mw.app-theme") ? [
              ...preferences.filter((p:any)=>!(p.kind === "setting" && p.name === "mw.theme")),
              {...preferences.find((p:any)=>p.kind === "setting" && p.name === "mw.theme"),kind:"setting",name:"mw.theme",tool:"",content:{value:appRef.current.theme}},
            ] : preferences,
            watchlist_metadata: Object.fromEntries(entries),
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
        const paths: Record<string,string> = {home: location.pathname, charts: location.pathname, signals:"/signals", replay:"/replay", settings:"/settings", legacy:"/legacy/monitoring"};
        if (paths[m.action]) navigate(paths[m.action]);
        else if (m.action === "logout") {
          try { await appRef.current.logout(); } catch(e) { setError(String(e)); }
        } else if (!mobile && m.action === "create") await create();
        else if (!mobile && m.action === "recover") await copy();
      } else if (m.type === "theme-changed") {
        if (typeof m.theme === "string" && /^(dark|light)$/i.test(m.theme))
          { setChartTheme(m.theme.toLowerCase()); appRef.current.setTheme(m.theme.toLowerCase() as "dark" | "light"); }
      } else if (m.type === "ready") {
        setNativeReady(true);
        if (deepCenter.current) {
          reply({type: "data-center-open", location: centerLocation(deepCenter.current)});
          deepCenter.current = null;

        }
        if (new URLSearchParams(location.search).get("panel") === "alerts") reply({type:"open-alerts"});
        reply({ type:"app-state", pending:appRef.current.pending });
        setStatus("已加载 · 行情按需更新");
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
      } else if (m.type === "error") {
        setFeedError(String(m.error).slice(0, 500));
        flushWaiters.current.splice(0).forEach(w => w.reject(Error(String(m.error))));
      }
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
            const previousWorkspace = current.current?.id;
            current.current = {
              id: result.id,
              name: result.name,
              revision: result.revision,
              document: result.document,
            };
            // Native loads happen inside the existing widget. Reflect their
            // identity without recreating the iframe or discarding chart state.
            setActive(current.current);
            remember(result.id);
            if (previousWorkspace !== result.id || q.op === "load") {
              alertUiSession.current = crypto.randomUUID();
              reply({
                type: "chart-alert-ui-scope",
                workspace_id: result.id,
                session: alertUiSession.current,
                draft: readAlertDraft(result.id),
              });
            }
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
      } else if (m.type === "symbol-flags") {
        const q = m.query;
        try {
          if (!q || !["read","save"].includes(q.op) || JSON.stringify(q).length > 1_100_000) throw Error("收藏请求不允许");
          let result;
          if (q.op === "read") {
            const rows = await api<any[]>("/advanced-charts/preferences");
            result = rows.find(row=>row.kind==="setting" && row.name==="mw.symbol-flags.v1" && !row.tool) || null;
          } else {
            if (mobile || q.args?.kind !== "setting" || q.args?.name !== "mw.symbol-flags.v1" || q.args?.tool) throw Error("收藏保存请求不允许");
            result = await api("/advanced-charts/preferences/save", q.args);
          }
          reply({type:"result",id:m.id,result});
        } catch(e) { reply({type:"result",id:m.id,error:String(e),errorDetails:apiErrorDetails(e)}); }
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
                    kind:["provider","history","composite","all"].includes(q.args?.kind) ? q.args.kind : "provider",
                    source:String(q.args?.source || ""),calendar:String(q.args?.calendar || ""),
                    symbol_type:String(q.args?.symbol_type || ""),cursor:String(q.args?.cursor || ""),
                    page_size:String(Number.isSafeInteger(q.args?.page_size) ? Math.max(1,Math.min(100,q.args.page_size)) : 25),
                    offset:String(Number.isSafeInteger(q.args?.offset) ? q.args.offset : 0)})
                  : q.op === "search"
                    ? "?query=" +
                      encodeURIComponent(String(q.args?.query || "")) +
                      "&kind=" +
                      encodeURIComponent(
                        ["provider", "history", "composite", "all"].includes(
                          q.args?.kind,
                        )
                          ? q.args.kind
                          : "all",
                      ) +
                      (q.args?.source
                        ? "&source=" + encodeURIComponent(String(q.args.source))
                        : "")
                    : q.op === "retry"
                      ? "/" + encodeURIComponent(q.args.id)
                      : ""),
              ["search", "searchPage"].includes(q.op) ? undefined : q.args,
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
      } else if (m.type === 'indicator-demand-update' || m.type === 'indicator-demand-release') {
        const q=m.query;
        if(!q || typeof q.client!=='string' || q.client.length>64 ||
          (m.type==='indicator-demand-update' ? !Array.isArray(q.leases) || q.leases.length>64 :
            !Array.isArray(q.consumers) || q.consumers.length>64)) {
          reply({type:'result',id:m.id,error:'指标需求格式无效'});return;
        }
        try {
          const result=await api('/charts/indicator-demands/'+(m.type==='indicator-demand-update'?'update':'release'),q);
          reply({type:'result',id:m.id,result});
        }catch(error){reply({type:'result',id:m.id,error:String(error)});}
      } else if (m.type === "data") {
        const q = m.query;
        if (
          !q ||
          !validIndicatorRead(q.indicators) ||
          (q.client !== undefined && (typeof q.client !== "string" || q.client.length < 1 || q.client.length > 64)) ||
          (q.indicator_consumers !== undefined && (
            !Array.isArray(q.indicator_consumers) || q.indicator_consumers.length > 64 ||
            q.indicator_consumers.some((consumer: any) => !consumer ||
              typeof consumer.id !== "string" || consumer.id.length < 1 || consumer.id.length > 100 ||
              !Number.isSafeInteger(consumer.generation) || consumer.generation < 0 ||
              !validIndicatorRead([consumer.spec]) ||
              (consumer.purpose !== undefined && !["foreground", "warmup"].includes(consumer.purpose)))
          )) ||
          typeof q.instrument !== "string" ||
          q.instrument.length > 80 ||
          (q.series_kind !== undefined &&
            !["provider", "managed", "history", "composite"].includes(
              q.series_kind,
            )) ||
          (q.display_snapshot_id !== undefined &&
            (q.series_kind !== "composite" ||
              typeof q.display_snapshot_id !== "string" ||
              !/^[a-f0-9]{64}$/.test(q.display_snapshot_id))) ||
          (q.display_retry !== undefined && (q.series_kind !== "composite" ||
            !q.display_retry || typeof q.display_retry !== "object" || Array.isArray(q.display_retry) ||
            Object.keys(q.display_retry).length > 12 || Object.entries(q.display_retry).some(([id,token])=>
              !/^[a-f0-9]{64}$/.test(id) || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)))) ||
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
                ...(q.client !== undefined ? { client: q.client } : {}),
                ...(q.indicator_consumers !== undefined ? { indicator_consumers: q.indicator_consumers } : {}),
                ...(q.series_kind === "composite"
                  ? {
                      composite_revision_id: q.composite_revision_id,
                      input_revision: q.input_revision,
                      display_snapshot_id: q.display_snapshot_id,
                      display_retry: q.display_retry,
                    }
                  : {}),
                ...(typeof q.dataset_start === "number"
                  ? { dataset_start: q.dataset_start }
                  : {}),
                ...(typeof q.calculation_origin === "number"
                  ? { calculation_origin: q.calculation_origin }
                  : {}),
                ...(typeof q.dependency_before === "number"
                  ? { dependency_before: q.dependency_before }
                  : {}),
                timeframe: q.timeframe,
                limit: q.limit,
                ...(q.series_kind === "provider"
                  ? {
                      provider_snapshot_id: q.provider_snapshot_id,
                      countBack: q.countBack,
                      from: q.from,
                      firstDataRequest: q.firstDataRequest === true,
                      ...(q.native_history !== undefined
                        ? {
                            native_history: q.native_history,
                            history_page_bars:
                              q.history_page_bars === 1000 ? 1000 : 4000,
                          }
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
      void legacyProvider.dispose();
      for (const requests of marketRequests.values())
        for (const controller of requests.values()) controller.abort();
    };
  }, [origin]);
  async function create() {
    const name = prompt("工作区名称", "我的图表");
    if (!name?.trim()) return;
    try {
      if (!await appRef.current.confirmLeave()) return;
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
      {mobile && <p className="advanced-readonly-note" role="note">手机只读看盘。编辑图表、绘图和告警请使用桌面浏览器；桌面工作区布局仍保留。</p>}
      {Object.keys(indicatorStates).length>0 && <aside className="advanced-history-failures" aria-label="图格指标状态">{Object.entries(indicatorStates).map(([key,item])=><p key={key} role="status">图格 {item.index+1} · {item.name}：{item.state==='error' ? item.error : '正在计算'}{item.previousParams && <>（暂显旧参数：{item.previousParams}）</>}{item.state==='error' && <button onClick={()=>post({type:'retry-chart-indicators',index:item.index,epoch:item.epoch})}>重试指标</button>}</p>)}</aside>}
      {chartFailures.length>0 && <aside className="advanced-history-failures" aria-label="图格历史加载失败">{chartFailures.map(item=><p key={item.index} role="status">图格 {item.index+1} · {item.label} · {item.resolution}：{item.error}<button onClick={()=>post({type:'retry-chart-history',...item})}>重试此图格</button></p>)}</aside>}
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
          src={`${origin}/?parent=${encodeURIComponent(location.origin)}${new URLSearchParams(location.search).get('marketPolling') === '1' ? '&marketPolling=1' : ''}`}
          sandbox="allow-scripts allow-same-origin allow-downloads allow-forms"
          allowFullScreen
          referrerPolicy="no-referrer"
        />
      ) : (
        <section>
          <h1>{error && workspaceId ? "工作区不可用" : "图表工作区"}</h1>
          <p>{mobile ? "手机只读看盘，请在桌面浏览器创建工作区。" : "选择已有工作区，或新建工作区开始使用。"}</p>
          <NavLink to="/advanced-charts">选择默认工作区</NavLink> · <NavLink to="/signals">通知</NavLink> · <NavLink to="/settings">设置</NavLink>
          <button disabled={mobile} onClick={create}>
            新建工作区
          </button>
        </section>
      )}
    </main>
  );
}
