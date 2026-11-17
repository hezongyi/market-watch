import { useEffect, useRef, useState } from "react";
import { ChevronDown, Send, Wifi } from "lucide-react";
import { api, ApiError, errorMessage } from "../api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { Field, FieldLabel, FieldDescription } from "./components/ui/field";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { MobileConfirm, useOverlayActive } from "./WatchOverlays";
import { logEvent, logFailure } from "./logs";

type Config = { url: string; topic: string; enabled: boolean; token_configured: boolean; revision: number; last_test_id?: string };
type Result = { status: string; ack_at?: number; outbox_status?: string; attempts: number };
const testLabel = (r: Result) => r.ack_at ? "手机已确认收到" : r.status === "server_accepted" ? "ntfy 已接受 · 等待手机确认" : r.status === "delivery_error" ? (r.outbox_status === "blocked" ? "发送被拒绝，请检查主题与令牌" : "发送失败，后台将自动重试") : "已排队 · 等待后台发送";

export default function NotificationSettings({ online, changed, state, records }: {
  online: boolean; changed(): void; state(dirty: boolean, busy: boolean): void; records(): void;
}) {
  const active = useOverlayActive();
  const [saved, setSaved] = useState<Config>();
  const [draft, setDraft] = useState<Config>();
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const [check, setCheck] = useState<{ ok: boolean; message: string }>();
  const [testId, setTestId] = useState("");
  const [result, setResult] = useState<Result>();
  const [reads, setReads] = useState(0);
  const [retry, setRetry] = useState(0);
  const flight = useRef(false);
  const loadedFor = useRef(-1);
  const dirty = Boolean(draft && saved && (draft.url !== saved.url || draft.topic !== saved.topic || draft.enabled !== saved.enabled || token || clearToken));
  useEffect(() => { state(dirty, Boolean(busy)); }, [dirty, busy]);
  useEffect(() => () => state(false, false), []);
  useEffect(() => {
    if (!online || !active || loadedFor.current === retry) return;
    const controller = new AbortController();
    setError("");
    void api<Config>("/settings/notification-transport", undefined, controller.signal).then(value => {
      setConflict(false);
      loadedFor.current = retry;
      setSaved(value); setDraft(value); setToken(""); setClearToken(false); setTestId(value.last_test_id || "");
    }).catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    return () => controller.abort();
  }, [active, online, retry]);
  useEffect(() => {
    if (!testId || !active || !online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>, count = 0;
    const read = async () => {
      try {
        const value = await api<Result>(`/notification-tests/${testId}`, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setResult(value);
        if (!value.ack_at && value.outbox_status !== "blocked" && ++count < 60) timer = setTimeout(read, 2000);
      } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)); }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [testId, active, online, reads]);
  async function run(action: string, task: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true; setBusy(action); setError(""); setMessage("");
    try { await task(); }
    catch (e) { setError(errorMessage(e)); if (e instanceof ApiError && e.status === 409 && action === "保存配置") setConflict(true); logFailure("通知", action, e); }
    finally { flight.current = false; setBusy(""); }
  }
  if (!draft) return <div className="more-panel">
    <p className="more-description">{online ? "正在读取通知配置…" : "连接服务器后可配置后台通知。"}</p>
    {error && <p role="alert" className="mobile-inline-error">{error}</p>}
    <Button variant="outline" disabled={!online} onClick={() => setRetry(x => x + 1)}>重新读取</Button>
  </div>;
  const locked = Boolean(busy) || !online;
  return <div className="more-panel ntfy-settings">
    <div className="ntfy-enable">
      <div><label htmlFor="ntfy-enabled">后台通知</label><p className="more-description">服务器持续监控，退出 App 后由 ntfy 提醒。</p></div>
      <Switch id="ntfy-enabled" checked={draft.enabled} disabled={locked} onCheckedChange={enabled => { setDraft({ ...draft, enabled }); setMessage(""); }} />
    </div>
    <Field><FieldLabel htmlFor="ntfy-url">服务地址</FieldLabel>
      <Input id="ntfy-url" type="url" inputMode="url" autoCapitalize="none" autoComplete="off" spellCheck={false} value={draft.url} disabled={locked} onChange={e => { setDraft({ ...draft, url: e.target.value }); setCheck(undefined); setMessage(""); }} />
    </Field>
    <Field><FieldLabel htmlFor="ntfy-topic">订阅主题</FieldLabel>
      <Input id="ntfy-topic" autoCapitalize="none" autoComplete="off" spellCheck={false} maxLength={64} value={draft.topic} disabled={locked} onChange={e => { setDraft({ ...draft, topic: e.target.value }); setCheck(undefined); setMessage(""); }} />
      <FieldDescription>与手机 ntfy 中订阅的主题一致。开启后只发送新通知。</FieldDescription>
    </Field>
    <Collapsible className="more-environment">
      <CollapsibleTrigger render={<Button variant="ghost" className="more-environment-trigger" />}>访问令牌 · {saved?.token_configured ? "已设置" : "可选"}<ChevronDown aria-hidden="true" /></CollapsibleTrigger>
      <CollapsibleContent><Field><FieldLabel htmlFor="ntfy-token">访问令牌</FieldLabel>
        <Input id="ntfy-token" type="password" autoComplete="new-password" value={token} disabled={locked || clearToken} placeholder={saved?.token_configured ? "已保存，留空保持原令牌" : "公开主题可留空"} onChange={e => setToken(e.target.value)} />
        {saved?.token_configured && <Button variant="ghost" disabled={locked} onClick={() => { setClearToken(x => !x); setToken(""); }}>{clearToken ? "保留已保存令牌" : "移除已保存令牌"}</Button>}
      </Field></CollapsibleContent>
    </Collapsible>
    <div className="mobile-sheet-actions more-panel-actions">
      <Button disabled={locked || !dirty || !draft.url.trim() || (draft.enabled && !draft.topic)} onClick={() => void run("保存配置", async () => {
        const value = await api<Config>("/settings/notification-transport", { url: draft.url, topic: draft.topic, enabled: draft.enabled, revision: draft.revision, token: token || null, clear_token: clearToken });
        setSaved(value); setDraft(value); setToken(""); setClearToken(false); setCheck(undefined); setTestId(""); setResult(undefined); setMessage("已保存，后台已生效"); changed();
        logEvent({ module: "通知", action: "保存配置", message: "后台通知配置已保存", result: "success" });
      })}>{busy === "保存配置" ? "正在保存…" : "保存配置"}</Button>
      {message && <p className="more-description" role="status">{message}</p>}
      {dirty && <p className="more-description">保存后可检查连接或发送测试。</p>}
      <div className="ntfy-test-actions">
        <Button variant="outline" disabled={locked || dirty} onClick={() => void run("检查连接", async () => {
          const value = await api<{ ok: boolean; message: string }>("/settings/notification-transport/check", {}); setCheck(value);
          logEvent({ module: "通知", action: "检查连接", message: value.message, level: value.ok ? "info" : "error" });
        })}><Wifi aria-hidden="true" />{busy === "检查连接" ? "检查中…" : "检查连接"}</Button>
        <Button variant="outline" disabled={locked || dirty || !saved?.topic} onClick={() => void run("发送测试", async () => {
          const value = await api<{ test_id: string }>("/notification-tests", {}); setResult(undefined); setTestId(value.test_id); setReads(x => x + 1); changed();
          logEvent({ module: "通知", action: "发送测试", message: "测试通知已排队，等待手机确认", result: "info" });
        })}><Send aria-hidden="true" />{busy === "发送测试" ? "发送中…" : "发送测试"}</Button>
      </div>
      {check && <p className="more-description" role={check.ok ? "status" : "alert"}>{check.message}</p>}
      {testId && <div className="ntfy-test-result" aria-live="polite"><strong>最近测试</strong><p>{result ? testLabel(result) : "正在查询发送结果…"}</p>
        <div className="ntfy-test-actions"><Button variant="ghost" disabled={locked} onClick={() => setReads(x => x + 1)}>刷新结果</Button>
        {result && !result.ack_at && ["server_accepted", "delivery_error"].includes(result.status) && <Button variant="ghost" disabled={locked} onClick={() => void run("确认收到", async () => {
          await api(`/notification-tests/${testId}/received`, {}); setReads(x => x + 1); changed();
        })}>我已收到</Button>}</div></div>}
      {error && <p className="mobile-inline-error" role="alert">{error}</p>}
      {conflict && <Button variant="outline" disabled={locked} onClick={() => setReloadConfirm(true)}>重新读取配置</Button>}
    </div>
    <p className="more-description">手机需安装 ntfy 并订阅同一主题，允许通知与后台运行。测试可能响铃，收到后点击通知中的“确认测试”。</p>
    <Button variant="ghost" disabled={dirty || locked} onClick={records}>通知与事件记录</Button>
    {reloadConfirm && <MobileConfirm title="读取服务器最新配置？" description="将替换本次未保存的修改。" actionLabel="重新读取" onClose={() => setReloadConfirm(false)} onAccept={() => { setReloadConfirm(false); setRetry(x => x + 1); }} />}
  </div>;
}
