import {resolveSignal} from "../runtime/notifications";
import {dataCenterRuntime} from "../runtime/dataCenter";
import {workspaceRuntime} from "../runtime/workspace";
import {sessionRuntime} from "../runtime/session";
import {alertRuntime} from "../runtime/alerts";
import {marketRuntime} from "../runtime/market";
import {mountChart,type ChartAdapter,type ChartApplication,type ChartUpdate} from "../runtime/chart";
import {preferenceDrafts,recoverablePreferenceDrafts,workspaceDraftKey,workspaceDraft,putWorkspaceDraft,workspaceDraftEntries,dropWorkspaceDraft,type PreferenceDraft} from "./localDrafts";
import {PreferenceDraftDialog} from "./PreferenceDraftDialog";
import {useNotices,useNoticeState} from "../notifications/context";
import {setChartTime} from "../time/ChartTimeContext";
import {operationFault} from "../notifications/operations";
import {
  subscribeHistoryLoadCapacity,
  type HistoryCapabilities,
} from "./nativeHistoryLoads";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, NavLink } from "react-router-dom";
import { useApp } from "../app/context";
import { pageName } from "../app/navigation";
import { centerLocation } from "../market-data/location";
import { api as requestAPI } from "../api";
import "./advanced.css";
import { HistoryPlansDialog, type DatasetViews } from "./HistoryPlansDialog";
import { MaintenanceDialog } from "./MaintenanceDialog";
import { ExportDialog, type ExportSelection } from "./ExportDialog";
import { providerSubscriptions } from "./providerSubscriptions";
import { validAlertContext } from "./chartAlerts";
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

export default function ChartApplicationPage() {
  const appLocation = useLocation(), navigate = useNavigate(), { workspaceId } = useParams();
  const notices=useNotices(), noticeState=useNoticeState();
  function api<T=any>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
    const fault=operationFault(path,body,current.current?.id||workspaceId);
    return fault?notices.operation(fault,()=>requestAPI<T>(path,body,signal)):requestAPI<T>(path,body,signal);
  }
  const noticeStateRef=useRef(noticeState);noticeStateRef.current=noticeState;
  const [notificationReady,setNotificationReady]=useState(false);
  const [notificationFailed,setNotificationFailed]=useState(false);
  const notificationReadyRef=useRef(notificationReady);notificationReadyRef.current=notificationReady;
  const noticeOpen=new URLSearchParams(appLocation.search).get('panel')==='notifications';
  const noticeEvent=new URLSearchParams(appLocation.search).get('event') || undefined;
  const closeNotices=()=>{const url=new URL(location.href);url.searchParams.delete('panel');url.searchParams.delete('event');navigate(url.pathname+url.search+url.hash,{replace:true});};
  const openNotices=(event?:string)=>{const url=new URL(location.href);url.searchParams.set('panel','notifications');if(event)url.searchParams.set('event',event);else url.searchParams.delete('event');navigate(url.pathname+url.search+url.hash,{replace:true});};
  const app = useApp(), appRef = useRef(app); appRef.current = app;
  const urlRef = useRef(appLocation); urlRef.current = appLocation;
  const [savedPreferenceDrafts,setSavedPreferenceDrafts]=useState<PreferenceDraft[]>(()=>{try{return recoverablePreferenceDrafts();}catch{return [];}});
  const [preferenceDraftsOpen,setPreferenceDraftsOpen]=useState(false);
  const [preferenceReopenRequired,setPreferenceReopenRequired]=useState(()=>savedPreferenceDrafts.length>0);
  const preferenceRecovery=useRef(new Map<string,{resolve:()=>void;reject:(error:Error)=>void}>());
  const refreshPreferenceDrafts=()=>{try{setSavedPreferenceDrafts(recoverablePreferenceDrafts());}catch{setError("无法读取本机设置草稿，请勿关闭页面");}};
  const capturing = useRef<{resolve: () => void; reject: (error: Error) => void} | null>(null);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null), titleText = useRef(""), titleQuote = useRef(""), titleLast = useRef(0), titleIdentity = useRef("");
  const titleHistorical = useRef(false);
  const updateTitle = (immediate = false) => {
    const layout = current.current?.name?.trim();
    titleText.current = [titleQuote.current || pageName(appLocation.pathname), layout && titleHistorical.current ? `[${layout}]` : layout]
      .filter(Boolean)
      .join(" ");
    const write = () => {
      titleTimer.current = null;
      if (document.title !== titleText.current) document.title = titleText.current;
      titleLast.current = performance.now();
    };
    if (immediate) {
      if (titleTimer.current) clearTimeout(titleTimer.current);
      write();
    } else if (!titleTimer.current) {
      titleTimer.current = setTimeout(
        write,
        Math.max(0, 1000 - (performance.now() - titleLast.current)),
      );
    }
  };
  const remember = (id: string, replace = false) => {
    localStorage.setItem("mw.last-workspace.v1", id);
    const query = new URLSearchParams(urlRef.current.search); query.delete("platform");
    const next = `/advanced-charts/${id}` + (query.size ? "?"+query : "") + urlRef.current.hash;
    sessionStorage.setItem("mw.chart-return.v1", next);
    if (urlRef.current.pathname !== `/advanced-charts/${id}`) navigate(next, { replace });
  };

  const [, setRows] = useState<Workspace[]>([]),
    [active, setActive] = useState<Workspace | null>(null);
  const [workspaceOpening,setWorkspaceOpening]=useState(true);
  const [historyPlansOpen, setHistoryPlansOpen] = useState(false);
  const [historyDetailsOpen, setHistoryDetailsOpen] = useState(false);
  const [maintenanceInstrument, setMaintenanceInstrument] = useState<
    string | null
  >(null);
  const [datasetViews, setDatasetViews] = useState<DatasetViews>({});
  const [frameKey, setFrameKey] = useState(0);
  useEffect(() => {
    setChartTime("UTC", "UTC（图表初始化前）");
    return () => setChartTime("UTC", "UTC（图表初始化前）");
  }, [frameKey]);
  const [exportSelection, setExportSelection] =
    useState<ExportSelection | null>(null);
  const [, setHistoryProgress] = useState<
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
  const [resolveStates,setResolveStates]=useState<{index:number;symbol:string;resolution:string;generation:number;state:string;message:string;retryAt:number;retryable:boolean;epoch:number}[]>([]);
  const [resolveNow, setResolveNow] = useState(Date.now());
  useEffect(() => {
    setResolveNow(Date.now());
    if (!resolveStates.some(item => item.retryAt > Date.now())) return;
    const timer = window.setInterval(() => setResolveNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [resolveStates]);
  const [chartFailures,setChartFailures]=useState<{index:number;symbol:string;resolution:string;label:string;error:string;epoch:number}[]>([]);
  const [capacityDialog, setCapacityDialog] = useState<{
    capabilities: HistoryCapabilities;
    usage: number;
  } | null>(null);
  const [status, setStatus] = useState("正在加载工作区"),
    [error, setError] = useState("");
  const chartContainer = useRef<HTMLDivElement>(null),
    chart = useRef<ChartAdapter|null>(null),
    application = useRef<ChartApplication|null>(null),
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
  const updateChart = (value: ChartUpdate) => { void chart.current?.update(value); };
  const flush = () =>
    new Promise<void>((resolve, reject) => {
      if (!current.current || mobile) {
        resolve();
        return;
      }
      const waiter = { resolve, reject };
      flushWaiters.current.push(waiter);
      updateChart({ type: "save" });
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
    setChartTime("UTC", "UTC（图表初始化前）");
    setNativeReady(false);setNotificationReady(false);setNotificationFailed(false);
    setPollErrors({});
    setHistoryProgress({});
    setNativeLoads({});
    setCapacityNotices({});
    nativeLoadEpoch.current = 0;
    setCapacityDialog(null);
    setHistoryDetailsOpen(false);
    setDatasetViews({});
    setSyncNotices({});
    unsaved.current = false;
    current.current = row;
    titleQuote.current = "";
    titleHistorical.current = false;
    titleIdentity.current = "";
    updateTitle(true);
    alertUiSession.current = "";
    blocked.current =
      !mobile && !!workspaceDraft(row.id);
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
  const notificationState = JSON.stringify(noticeMessages.filter(row=>row.recover));
  useEffect(() => {
    if (nativeReady)
      updateChart({
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
      updateChart({ type: "save" });
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
        if (current.current) {const draft=workspaceDraftEntries(current.current.id).find(row=>row.storageKey===workspaceDraftKey(current.current!.id));if(draft)dropWorkspaceDraft(draft);}
        unsaved.current = false; blocked.current = false; updateChart({ type: "discard-changes" });
      },
      preserve: () => {
        if (mobile || !unsaved.current) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          capturing.current = {resolve, reject}; updateChart({ type: "capture-draft" });
          setTimeout(() => { if (capturing.current?.resolve === resolve) { capturing.current = null; reject(Error("图表草稿尚未捕获")); } }, 10000);
        });
      },
    });
  }, [app.registerGuard, mobile]);
  useEffect(() => {
    if (current.current && current.current.id === workspaceId) return;
    setWorkspaceOpening(true);
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
    }).catch(e => { if (!cancelled) { setActive(null); current.current = null; setError(workspaceId ? "工作区不可用：" + String(e) : String(e)); } }).finally(()=>{if(!cancelled)setWorkspaceOpening(false);});
    return () => { cancelled = true; };
  }, [workspaceId, requestedPlatform, mobile]);
  useEffect(() => {
    if (active) sessionStorage.setItem("mw.chart-return.v1", appLocation.pathname + appLocation.search + appLocation.hash);
  }, [active?.id, appLocation]);
  useEffect(() => { updateTitle(true); }, [active?.id, active?.name]);
  useEffect(()=>{
    if(!active?.id)return;
    const context={workspace_id:active.id};
    const attempt=crypto.randomUUID();
    const timer=setTimeout(()=>{
      if(notificationReadyRef.current)return;
      setNotificationFailed(true);
      void notices.report({source_kind:'chart_shell',attempt_id:attempt,code:'CHART_SHELL_UNAVAILABLE',title:'图表通知接入尚未完成',message:'图表通知接入超时，请重新加载图表；恢复后可查看消息记录',context});
    },25000);
    return()=>clearTimeout(timer);
  },[active?.id,frameKey,notices]);
  useEffect(()=>{if(notificationReady&&active?.id)void notices.resolve({source_kind:'chart_shell',attempt_id:alertUiSession.current,code:'CHART_SHELL_UNAVAILABLE',title:'图表通知接入已恢复',message:'当前工作区原生通知已接入',context:{workspace_id:active.id}});},[notificationReady,active?.id,notices]);
  useEffect(()=>{notices.setPresentation(true);return()=>notices.setPresentation(false);},[notices]);
  useEffect(()=>{if(nativeReady)updateChart({type:'app-state',pending:noticeState.unread});
    if(notificationReady)updateChart({type:'notice-center-state',session:alertUiSession.current,workspace_id:current.current?.id,state:noticeState});
  },[nativeReady,notificationReady,noticeState]);
  useEffect(()=>{if(nativeReady && new URLSearchParams(appLocation.search).get('panel')==='alerts') { const signal=new URLSearchParams(appLocation.search).get('signal'); if(signal)updateChart({type:'chart-alert-event-open',signal_id:signal}); }},[nativeReady,appLocation.search]);
  useEffect(()=>{
    const signal=new URLSearchParams(appLocation.search).get('signal');
    if(!signal || new URLSearchParams(appLocation.search).get('panel')!=='notifications')return;
    let live=true;void resolveSignal(signal).then(result=>{if(live)navigate(result.destination || '/signals?signal='+encodeURIComponent(signal),{replace:true});}).catch(e=>{if(live)setError(String(e));});
    return()=>{live=false;};
  },[appLocation.search]);
  useEffect(()=>{if(notificationReady && noticeOpen)updateChart({type:'notice-center-open',event_id:noticeEvent});},[notificationReady,noticeOpen,noticeEvent]);
  useEffect(() => () => { if (titleTimer.current) clearTimeout(titleTimer.current); }, []);
  useEffect(() => {
    const marketRequests = new Map<ChartAdapter, Map<number, AbortController>>();
    let historyLoadAvailable = 0;
    const unsubscribeHistoryCapacity = subscribeHistoryLoadCapacity((available) => {
      historyLoadAvailable = available;
      updateChart({type:'history-load-capacity',available});
    });
    const subscriptionScopes = new WeakMap<object, {workspace: string; session: string; epoch: number}>();
    const observeSubscription = (args: any, kind: 'market' | 'connection' | 'subscription', error: unknown | null, attempt: string, lifecycle?: 'ended', transportEvidence?: Record<string, string | number | boolean | null>) => {
      const scope = subscriptionScopes.get(args);
      if (!scope || (!lifecycle && (scope.workspace !== current.current?.id || scope.session !== alertUiSession.current || scope.epoch !== nativeLoadEpoch.current))) return;
      const query = args.query || args;
      const shared = kind === 'connection', failed = error as {status?: number; code?: string; name?: string} | null;
      const fault = {source_kind: kind === 'subscription' ? 'market' as const : kind,
        attempt_id: (shared ? args.client : args.listener + ':' + String(args.generation ?? '')) + ':' + attempt,
        code: shared ? 'MARKET_CONNECTION_FAILED' : kind === 'subscription' ? 'MARKET_SUBSCRIPTION_FAILED' : 'MARKET_READ_FAILED',
        title: shared ? '图表行情连接中断' : kind === 'subscription' ? '行情订阅未成功注册' : '图表行情读取失败',
        message: lifecycle ? '订阅观察已结束，无法继续确认恢复' : error == null ? '对应操作已明确恢复' : String(error),
        ...(lifecycle ? {observation_ended: true} : {}),
        context: {workspace_id: scope.workspace, epoch: scope.epoch, source_id: shared ? args.client : args.listener,
          generation: shared ? 0 : args.generation ?? 0, instrument: shared ? '' : query.instrument || '',
          timeframe: shared ? '' : query.timeframe || '', consumer: shared ? 'stream' : args.kind || 'bars'},
        evidence: {operation: shared ? 'sse_transport' : kind === 'subscription' ? 'subscription_register' : 'market_read',
          error_type: failed?.name || '', code: failed?.code || '', http_status: failed?.status || null,
          ...(shared ? transportEvidence : {})}};
      if (error == null) void notices.resolve(fault); else void notices.report(fault);
    };
    const provider = providerSubscriptions(
      api,
      (client) =>
        new EventSource(
          "/api/charts/stream/events?client=" + encodeURIComponent(client),
        ),
      (event) => updateChart({ type: "market-event", event }),
      (error) => setError(String(error)),
      {subscribe: '/charts/stream/subscribe', unsubscribe: '/charts/stream/unsubscribe'},
      observeSubscription,
      async args => {
        const query = args.query as {series_kind?: string; instrument?: string};
        if (query?.series_kind !== 'composite') return true;
        const metadata = await api<any>('/market-data/resolve', {instrument: query.instrument, series_kind: 'composite', timeframe: 'M1'});
        return metadata.created === true;
      },
    );
    const establishedChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('mw-composite-established-v1');
    establishedChannel?.addEventListener('message', event => {
      if (typeof event.data === 'string' && /^[a-f0-9]{64}$/.test(event.data)) void provider.established(event.data);
    });
    const compositeEstablished = (instrument: string) => {
      void provider.established(instrument);
      establishedChannel?.postMessage(instrument);
    };
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
    const listener = async (m: ChartUpdate, source: ChartAdapter, response?: (value:ChartUpdate)=>void) => {
      if(source !== chart.current) return;
      const reply = (value:ChartUpdate) => {
        if(source !== chart.current) return;
        if(response && value.type === "result") response(value);
        else void source.update({...(typeof m.history_client==='string'?{history_client:m.history_client}:{}),...value});
      };
      if(m.type==='notice-source'){
        if(m.session!==alertUiSession.current||m.workspace_id!==current.current?.id||m.epoch!==nativeLoadEpoch.current||
          !m.fault||JSON.stringify(m.fault).length>16000||!['indicator','history','capacity','market','connection','chart_shell','data_center','preferences'].includes(m.fault.source_kind))return;
        const fault={...m.fault,context:{...m.fault.context,workspace_id:current.current?.id,epoch:m.epoch}};
        if(m.recovered===true)void notices.resolve(fault);else void notices.report(fault);
        return;
      }
      if(m.type==='chart-timezone' && m.session===alertUiSession.current && m.workspace_id===current.current?.id){
        if(typeof m.zone==='string' && typeof m.label==='string' && m.zone.length<100 && m.label.length<160)setChartTime(m.zone,m.label);
        return;
      }
      if(m.type==='notice-center-ready' && m.session===alertUiSession.current && m.workspace_id===current.current?.id){setNotificationReady(true);setNotificationFailed(false);return;}
      if(m.type==='notice-center-unavailable' && m.session===alertUiSession.current && m.workspace_id===current.current?.id){setNotificationReady(false);setNotificationFailed(true);void notices.report({source_kind:'chart_shell',attempt_id:m.session+':notice-shell',code:'CHART_SHELL_UNAVAILABLE',title:'原生系统消息暂不可用',message:String(m.error||'接入失败'),context:{workspace_id:current.current?.id}});return;}
      if(m.type==='notice-center-panel' && m.session===alertUiSession.current && m.workspace_id===current.current?.id){
        if(m.open)openNotices(typeof m.event==='string'?m.event:undefined);
        else if(new URLSearchParams(location.search).get('panel')==='notifications')closeNotices();return;
      }
      if(m.type==='notice-center-locate' && m.session===alertUiSession.current && typeof m.event_id==='string'){
        const row=await notices.action({action:'detail',event_id:m.event_id});
        const workspace=row.workspace;if(typeof workspace!=='string'||!workspace) return;
        if(workspace!==current.current?.id){
          const session=alertUiSession.current,from=current.current?.id;
          if(!await appRef.current.confirmLeave() || session!==alertUiSession.current || from!==current.current?.id)return;
          navigate('/advanced-charts/'+encodeURIComponent(workspace)+'?panel=notifications&event='+encodeURIComponent(row.id));return;
        }
        if(row.source_kind==='data_center' || row.context?.consumer==='quotes' || row.context?.timeframe==='quotes') {
          reply({type:'data-center-open',location:'/market-data'});return;
        }
        if(row.source_kind==='capacity') {reply({type:'history-capacity-open'});return;}
        if(row.source_kind==='chart_alert'){
          const rows=await api('/chart-alerts');const alert=rows.find((a:any)=>a.id===row.original_evidence?.alert_id);
          if(alert && source===chart.current)reply({type:'chart-alert-locate',row:alert,event:row.original_evidence});
        }return;
      }
      if (m.type === "draft-captured") {
        const waiter = capturing.current; capturing.current = null;
        if (!waiter) return;
        try {
          if (m.workspace_id !== current.current?.id || m.document?.engine !== "tv31" || m.document?.schemaVersion !== 1 || JSON.stringify(m.document).length > 4_000_000) throw Error("草稿响应无效");
          putWorkspaceDraft(m.workspace_id, JSON.stringify(m.document), current.current?.revision); waiter.resolve();
        } catch (e) { waiter.reject(new Error(String(e))); }
        return;
      }
      if (m.type === "confirm-leave") {
        const allowed = await appRef.current.confirmLeave();
        reply({ type:"result", id:m.id, result:allowed }); return;
      }
      if (m.type === "active-quote") {
        if (m.workspace_id !== current.current?.id || typeof m.ticker !== "string" || m.ticker.length > 150 || typeof m.label !== "string" || m.label.length > 150 || !Number.isSafeInteger(m.generation)) return;
        // Chart instance and workspace are checked before title data is used.
        const identity = `${m.workspace_id}:${m.generation}:${m.ticker}`;
        const price = Number.isFinite(m.price) && typeof m.formatted === "string" ? " " + m.formatted.slice(0, 60) : "";
        const percent = price && Number.isFinite(m.change) ? ` ${m.change > 0 ? "▲ +" : m.change < 0 ? "▼ −" : ""}${Math.abs(m.change).toFixed(2)}%` : "";
        titleHistorical.current = m.historical === true;
        titleQuote.current = titleHistorical.current ? m.label + "·历史" : m.label + price + percent + (m.delayed ? " · 迟延" : "");
        updateTitle(identity !== titleIdentity.current);
        titleIdentity.current = identity;
        return;
      }
      if (m.type === "alerts-panel-state" && m.workspace_id === current.current?.id && typeof m.open === "boolean") {
        const url = new URL(location.href);
        if (m.open) {
          url.searchParams.set("panel", "alerts");
          if(typeof m.signal_id==='string' && /^[a-f0-9-]{36}$/.test(m.signal_id)) {
            url.searchParams.set('signal',m.signal_id);url.searchParams.delete('event');
          }
        } else if(url.searchParams.get("panel")==="alerts") {url.searchParams.delete("panel");url.searchParams.delete("signal");}
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
      if (
        m.type === "market-subscribe" ||
        m.type === "market-unsubscribe" ||
        m.type === "market-accept"
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
          if (m.type === 'market-accept') {
            await provider.accept(args);
          } else if (m.type.endsWith('-subscribe')) {
            subscriptionScopes.set(args, {workspace:current.current?.id || '',session:alertUiSession.current,epoch:nativeLoadEpoch.current});
            await provider.subscribe(args);
          } else {
            await provider.unsubscribe(args);
          }
        } catch (error) {
          setError(String(error));
        }
        return;
      }
      if (m.type === 'preference-draft-result') {
        if(!m.error)setPreferenceReopenRequired(true);
        const waiter=preferenceRecovery.current.get(m.request);
        if(waiter){preferenceRecovery.current.delete(m.request);m.error?waiter.reject(Error(m.error)):waiter.resolve();refreshPreferenceDrafts();}
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
      if (m.type === "history-load-details-open") {
        setHistoryDetailsOpen(true);
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
            source !== chart.current ||
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
            source === chart.current &&
            epoch === nativeLoadEpoch.current
          )
            setFeedError(String(e));
        }
        return;
      }
      if (m.type === "native-load-reset" && Number.isSafeInteger(m.epoch)) {
        setChartFailures([]);setResolveStates([]);
        nativeLoadEpoch.current = m.epoch;
        setNativeLoads({});
        setCapacityNotices({});
        setHistoryDetailsOpen(false);
        setCapacityDialog(null);
        return;
      }
      if(m.type==='chart-resolve-states' && m.epoch===nativeLoadEpoch.current && Array.isArray(m.states)) {
        setResolveStates(m.states.filter((item:any)=>Number.isSafeInteger(item.index) && item.index>=0 && item.index<8 &&
          typeof item.symbol==='string' && typeof item.resolution==='string' && Number.isSafeInteger(item.generation) &&
          ['loading','error'].includes(item.state) && typeof item.message==='string' && Number.isFinite(item.retryAt))
          .map((item:any)=>({...item,epoch:m.epoch})));return;
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
            notice_state: noticeStateRef.current,
            alert_ui_draft: readAlertDraft(current.current?.id),
            history_capabilities: capabilities,
            history_load_available: historyLoadAvailable,
            document: current.current?.document || {},
            workspace: current.current,
            readonly: mobile,
            catalog,
            preference_draft_keys: preferenceDrafts().map(draft=>draft.key),
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
        const paths: Record<string,string> = {home: location.pathname, charts: location.pathname, signals:location.pathname+"?panel=notifications",  settings:"/settings", };
        if(m.action==='signals')openNotices();
        else if (paths[m.action]) navigate(paths[m.action]);
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
        reply({ type:"app-state", pending:noticeStateRef.current.unread });
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
      } else if (m.type === "status") {
        setStatus(String(m.text).slice(0, 200));
        if (m.text === "行情已加载") setFeedError("");
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
        let savedDraft: ReturnType<typeof putWorkspaceDraft> | undefined;
        try {
          savedDraft = putWorkspaceDraft(id, JSON.stringify(document), current.current?.revision);
        } catch (e) {
          setError("本地草稿空间不足，将继续尝试服务器保存");
          void notices.report({source_kind:'workspace',attempt_id:crypto.randomUUID(),code:'LOCAL_DRAFT_FAILED',title:'图表草稿未能保存到本机',message:String(e),context:{workspace_id:id},evidence:{server_save:'继续尝试；请勿关闭页面'}});
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
              if (savedDraft) dropWorkspaceDraft(savedDraft);
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
    const market = marketRuntime({api,marketRequests,inflight,historyCapabilities,setNativeLoads,current,nativeLoadEpoch,chart,compositeEstablished,updateChart});
    const workspace = workspaceRuntime({api,mobile,queue,blocked,current,setError,notices,select,setFeedError,setStatus,setActive,remember,alertUiSession,readAlertDraft,setRows,refresh,unsaved,updateChart});
    const dataCenter = dataCenterRuntime({api,mobile,session:()=>centerSession.current,requests:marketRequests});
    const session = sessionRuntime({mobile,api,rawAPI:requestAPI,draftsChanged:refreshPreferenceDrafts});
    const alerts = alertRuntime({api,mobile,scope:()=>({workspace_id:current.current?.id || '',session:alertUiSession.current})});
    const valid = (source:ChartAdapter,workspace:string|undefined,session:string)=>source===chart.current && workspace===current.current?.id && session===alertUiSession.current;
    application.current = {
      observe: (value,source)=>{void listener(value,source).catch(error=>setError(String(error)));},
      market:(kind,query,context,source)=>{
        if(kind==="data"||kind==="market")return market[kind](query,source,context);
        return api('/charts/indicator-demands/'+(kind==='indicator-demand-update'?'update':'release'),query);
      },
      workspace:async (_kind,query,_context,source)=>{const id=current.current?.id,token=alertUiSession.current;return workspace(query,()=>valid(source,id,token));},
      session:async (kind,query)=>kind==='confirm-leave'?appRef.current.confirmLeave():session(kind,query),
      alerts:async (kind,query,_context,source)=>{const id=current.current?.id,token=alertUiSession.current;return alerts(kind,query,()=>valid(source,id,token));},
      notifications:async (_kind,query,_context,source)=>{
        const id=current.current?.id,token=alertUiSession.current;
        if(!query || query.workspace_id!==id || query.session!==token)throw Error('通知上下文已失效');
        const result=await notices.action(query);if(!valid(source,id,token))throw Error('通知工作区已切换');return result;
      },
      dataCenter:async (_kind,query,context,source)=>dataCenter(query,context.id,source),
      cancel:(id,source)=>marketRequests.get(source)?.get(id)?.abort(),
    };

    return () => {
      unsubscribeHistoryCapacity();
      application.current = null;
      chart.current?.dispose();chart.current=null;
      establishedChannel?.close();
      void provider.dispose();
      for (const requests of marketRequests.values())
        for (const controller of requests.values()) controller.abort();
    };
  }, []);
  useEffect(() => {
    if(!active || !chartContainer.current || !application.current) return;
    let cancelled=false,instance:ChartAdapter|undefined;
    void mountChart(chartContainer.current,application.current).then(value=>{
      if(cancelled){value.dispose();return;}
      instance=value;chart.current=value;value.start();
    }).catch(error=>{if(!cancelled){setError(String(error));setNotificationFailed(true);}});
    return ()=>{cancelled=true;if(chart.current===instance)chart.current=null;instance?.dispose();};
  }, [Boolean(active),frameKey]);
  useEffect(()=>{const update=()=>refreshPreferenceDrafts();addEventListener('storage',update);return()=>removeEventListener('storage',update);},[]);
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
      const entries=workspaceDraftEntries(old.id);
      let selectedDraft=entries[0];
      if(entries.length>1) {
        const choice=prompt('发现多个独立工作区草稿，请选择要复制恢复的编号：\n'+entries.map((entry,index)=>`${index+1}. ${entry.at?new Date(entry.at).toLocaleString():'旧版本草稿'} · 基线版本 ${entry.baseRevision ?? '未知'}`).join('\n'),'1');
        if(choice===null)return;
        const index=Number(choice)-1;
        if(!Number.isInteger(index)||index<0||index>=entries.length)throw Error('请选择有效的草稿编号');
        selectedDraft=entries[index];
      }
      const draft = selectedDraft?.raw || null;
      const document = draft ? JSON.parse(draft) : old.document;
      const row = await api<Workspace>("/advanced-charts/workspaces", {
        name: old.name + " 副本",
      });
      const saved = await api<Workspace>(
        `/advanced-charts/workspaces/${row.id}/save`,
        { name: row.name, revision: row.revision, document },
      );
      if(selectedDraft)dropWorkspaceDraft(selectedDraft);
      setRows((p) => [saved, ...p]);
      select(saved);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <main className="advanced-workspace" data-theme={chartTheme}>
      {mobile && <p className="advanced-readonly-note" role="note">手机只读看盘。编辑图表、绘图和告警请使用桌面浏览器；桌面工作区布局仍保留。</p>}
      {resolveStates.length>0 && <aside className="advanced-history-failures" aria-label="图格行情解析状态">{resolveStates.map(item=><p key={item.index} role="status">图格 {item.index+1}：{item.message}{item.state==='error' && <button disabled={item.retryAt>resolveNow} onClick={()=>updateChart({type:'retry-chart-resolve',...item})}>{item.retryAt>resolveNow ? `冷却 ${Math.ceil((item.retryAt-resolveNow)/1000)} 秒后重试` : '重试行情解析'}</button>}</p>)}</aside>}
      {historyDetailsOpen && (
        <div className="advanced-load-details" role="dialog" aria-modal="false" aria-label="历史加载详情">
          <header>
            <strong>历史加载详情</strong>
            <button type="button" aria-label="关闭历史加载详情" onClick={() => setHistoryDetailsOpen(false)}>关闭</button>
          </header>
      {chartFailures.length>0 && <aside className="advanced-history-failures" aria-label="图格历史加载失败">{chartFailures.map(item=><p key={item.index} role="status">图格 {item.index+1} · {item.label} · {item.resolution}：{item.error}<button onClick={()=>updateChart({type:'retry-chart-history',...item})}>重试此图格</button></p>)}</aside>}
      {(Object.keys(nativeLoads).length > 0 ||
        Object.keys(capacityNotices).length > 0) && (
        <HistoryLoadingNotice
          immediate
          loads={nativeLoads}
          capacities={capacityNotices}
          onCancel={() => updateChart({ type: "cancel-history" })}
          onSettings={() => {
            setHistoryDetailsOpen(false);
            updateChart({ type: "history-capacity-open" });
          }}
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
      {!Object.keys(nativeLoads).length && !Object.keys(capacityNotices).length && !chartFailures.length && <p>当前没有进行中的加载任务。</p>}
        </div>
      )}
      {!mobile && (savedPreferenceDrafts.length>0 || preferenceReopenRequired) && <div className="preference-draft-banner" role="status">
        {savedPreferenceDrafts.length>0 && <><span>有 {savedPreferenceDrafts.length} 项设置草稿未保存</span><button onClick={()=>setPreferenceDraftsOpen(true)}>处理设置草稿</button></>}
        {preferenceReopenRequired && <><span>设置已暂停自动保存；草稿处理后请重新打开图表继续修改。</span><button onClick={()=>location.reload()}>重新打开图表</button></>}
      </div>}
      {preferenceDraftsOpen && <PreferenceDraftDialog drafts={savedPreferenceDrafts} onClose={()=>setPreferenceDraftsOpen(false)} onResolve={(draft,action,revision)=>new Promise<void>((resolve,reject)=>{
        const request=crypto.randomUUID();
        const timer=setTimeout(()=>{preferenceRecovery.current.delete(request);reject(Error('处理尚未确认，草稿仍保留；请重新核对服务器设置'));},30000);
        preferenceRecovery.current.set(request,{resolve:()=>{clearTimeout(timer);resolve();},reject:error=>{clearTimeout(timer);reject(error);}});
        updateChart({type:'preference-draft-resolve',request,draft,action,revision});
      })}/>}
      {capacityDialog && (
        <HistoryCapacityDialog
          request={api}
          {...capacityDialog}
          theme={chartTheme}
          onClose={() => setCapacityDialog(null)}
          onSaved={(capabilities) => {
            historyCapabilities.current = capabilities;
            updateChart({ type: "history-capabilities", capabilities });
          }}
        />
      )}
      {historyPlansOpen && (
        <HistoryPlansDialog
          request={api}
          onClose={() => setHistoryPlansOpen(false)}
          readonly={mobile}
          onRefresh={() => updateChart({ type: "refresh-managed" })}
          views={datasetViews}
        />
      )}
      {maintenanceInstrument && (
        <MaintenanceDialog
          request={api}
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
          workspace={active?.id}
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
      {notificationFailed && !notificationReady && (
        <div className="advanced-shell-recovery" role="status">
          <span>图表界面接入未完成，请重新加载。</span>
          <button type="button" onClick={()=>void appRef.current.confirmLeave().then(ok=>{
            if(!ok)return;
            setNativeReady(false);setNotificationReady(false);setNotificationFailed(false);
            setFrameKey(key=>key+1);
          })}>重新加载图表</button>
        </div>
      )}
      {active ? (
        <div key={frameKey} ref={chartContainer} className="advanced-chart" role="region" aria-label="专业图表工作区" data-workspace-id={active.id} />
      ) : workspaceOpening ? null : (
        <section>
          <h1>{error && workspaceId ? "工作区不可用" : "图表工作区"}</h1>
          <p>{mobile ? "手机只读看盘，请在桌面浏览器创建工作区。" : "选择已有工作区，或新建工作区开始使用。"}</p>
          <NavLink to="/advanced-charts">选择默认工作区</NavLink> · <NavLink to="/settings">设置</NavLink>
          <button disabled={mobile} onClick={create}>
            新建工作区
          </button>
        </section>
      )}
    </main>
  );
}
