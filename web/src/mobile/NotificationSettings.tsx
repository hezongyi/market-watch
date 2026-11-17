import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Clock3, History, Send, Wifi } from "lucide-react";
import { api, ApiError, errorMessage } from "../api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { Skeleton } from "./components/ui/skeleton";
import { Field, FieldContent, FieldLabel, FieldDescription, FieldGroup } from "./components/ui/field";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { MobileConfirm, useOverlayActive } from "./WatchOverlays";
import { logEvent, logFailure } from "./logs";
import RuntimeNotificationPolicy from "./RuntimeNotificationPolicy";

type Config = { url: string; topic: string; enabled: boolean; token_configured: boolean; revision: number; last_test_id?: string };
type Result = { status: string; ack_at?: number; outbox_status?: string; attempts: number };
const testLabel = (r: Result) => r.ack_at ? "手机已确认收到" : r.status === "server_accepted" ? "ntfy 已接受 · 等待手机确认" : r.status === "delivery_error" ? (r.outbox_status === "blocked" ? "发送被拒绝，请检查主题与令牌" : "发送失败，后台将自动重试") : "已排队 · 等待后台发送";
function serverLabel(url: string) {
  try { return new URL(url).host; } catch { return "填写服务地址与订阅主题"; }
}

export default function NotificationSettings({ online, changed, state, records }: {
  online: boolean; changed(): void; state(dirty: boolean, busy: boolean): void; records(): void;
}) {
  const active = useOverlayActive();
  const [saved, setSaved] = useState<Config>();
  const [draft, setDraft] = useState<Config>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [busy, setBusy] = useState("");
  const [policyBusy, setPolicyBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorAction, setErrorAction] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const [check, setCheck] = useState<{ ok: boolean; message: string }>();
  const [testId, setTestId] = useState("");
  const [result, setResult] = useState<Result>();
  const [testError, setTestError] = useState("");
  const [reads, setReads] = useState(0);
  const [retry, setRetry] = useState(0);
  const flight = useRef(false);
  const loadedFor = useRef(-1);
  const dirty = Boolean(draft && saved && (draft.url !== saved.url || draft.topic !== saved.topic || draft.enabled !== saved.enabled || token || clearToken));
  useEffect(() => { state(dirty, Boolean(busy) || policyBusy); }, [dirty, busy, policyBusy]);
  useEffect(() => () => state(false, false), []);
  useEffect(() => {
    if (!online || !active || loadedFor.current === retry) return;
    const controller = new AbortController();
    setError("");
    void api<Config>("/settings/notification-transport", undefined, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setConflict(false); setCheck(undefined); setResult(undefined); setTestError("");
      loadedFor.current = retry;
      setSaved(value); setDraft(value); setToken(""); setClearToken(false); setTestId(value.last_test_id || "");
      setSettingsOpen(!value.url || !value.topic);
    }).catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    return () => controller.abort();
  }, [active, online, retry]);
  useEffect(() => {
    if (!testId || !active || !online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>, count = 0;
    setTestError("");
    const read = async () => {
      try {
        const value = await api<Result>(`/notification-tests/${testId}`, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setResult(value);
        if (!value.ack_at && value.outbox_status !== "blocked" && ++count < 60) timer = setTimeout(read, 2000);
      } catch (e) { if (!controller.signal.aborted) setTestError(errorMessage(e)); }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [testId, active, online, reads]);
  async function run(action: string, task: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true; setBusy(action); setError(""); setMessage("");
    try { await task(); }
    catch (e) { setError(errorMessage(e)); setErrorAction(action); if (e instanceof ApiError && e.status === 409 && action === "保存配置") setConflict(true); logFailure("通知", action, e); }
    finally { flight.current = false; setBusy(""); }
  }
  if (!draft) return <div className="more-panel ntfy-settings" aria-busy={online && !error}>
    {online && !error ? <div className="ntfy-loading" role="status" aria-label="正在读取通知配置">
      <Skeleton className="ntfy-loading-row" /><Skeleton className="ntfy-loading-row" /><Skeleton className="ntfy-loading-row" />
    </div> : <>
      <p className="more-description">{online ? "通知配置暂时无法读取。" : "连接服务器后可配置后台通知。"}</p>
      {error && <p role="alert" className="mobile-inline-error">{error}</p>}
      <Button variant="outline" disabled={!online} onClick={() => setRetry(x => x + 1)}>重新读取</Button>
    </>}
  </div>;
  const locked = Boolean(busy) || policyBusy || !online;
  const testState = result?.ack_at ? "confirmed" : result?.status === "delivery_error" ? "failed" : result?.status === "server_accepted" ? "accepted" : "pending";
  const TestIcon = testState === "confirmed" ? CheckCircle2 : testState === "failed" ? CircleAlert : testState === "accepted" ? Send : Clock3;
  return <div className="more-panel ntfy-settings">
    <Field orientation="horizontal" className="ntfy-enable" data-disabled={locked || undefined}>
      <FieldContent>
        <FieldLabel htmlFor="ntfy-enabled">手机推送</FieldLabel>
        <FieldDescription>由服务器发送，无需 App 常驻。</FieldDescription>
      </FieldContent>
      <Switch size="lg" id="ntfy-enabled" aria-label="后台通知" checked={draft.enabled} disabled={locked} onCheckedChange={enabled => { setDraft({ ...draft, enabled }); setMessage(""); }} />
    </Field>

    <RuntimeNotificationPolicy online={online} saving={setPolicyBusy} disabled={Boolean(busy)} />

    <Collapsible className="more-environment ntfy-connection" open={settingsOpen} onOpenChange={setSettingsOpen}>
      <CollapsibleTrigger render={<Button variant="ghost" className="more-environment-trigger ntfy-disclosure" />}>
        <span><strong>接收设置</strong><small>{draft.topic ? `${serverLabel(draft.url)} · ${draft.topic}` : "填写服务地址与订阅主题"}</small></span>
        <ChevronDown data-icon="inline-end" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <FieldGroup className="ntfy-connection-fields">
          <Field data-disabled={locked || undefined}><FieldLabel htmlFor="ntfy-url">服务地址</FieldLabel>
            <Input id="ntfy-url" type="url" inputMode="url" autoCapitalize="none" autoComplete="off" spellCheck={false} value={draft.url} disabled={locked} placeholder="https://ntfy.sh" onChange={e => { setDraft({ ...draft, url: e.target.value }); setCheck(undefined); setMessage(""); }} />
          </Field>
          <Field data-disabled={locked || undefined}><FieldLabel htmlFor="ntfy-topic">订阅主题</FieldLabel>
            <Input id="ntfy-topic" autoCapitalize="none" autoComplete="off" spellCheck={false} maxLength={64} value={draft.topic} disabled={locked} placeholder="与手机 ntfy 的主题一致" onChange={e => { setDraft({ ...draft, topic: e.target.value }); setCheck(undefined); setMessage(""); }} />
            <FieldDescription>在手机 ntfy 中订阅同一地址和主题。</FieldDescription>
          </Field>
          <Collapsible className="more-environment ntfy-token">
            <CollapsibleTrigger render={<Button variant="ghost" className="more-environment-trigger" />}>访问令牌<span className="ntfy-token-state">{clearToken ? "保存后移除" : saved?.token_configured ? "已设置" : "可选"}</span><ChevronDown data-icon="inline-end" aria-hidden="true" /></CollapsibleTrigger>
            <CollapsibleContent><Field data-disabled={locked || clearToken || undefined}><FieldLabel htmlFor="ntfy-token">访问令牌</FieldLabel>
              <Input id="ntfy-token" type="password" autoComplete="new-password" value={token} disabled={locked || clearToken} placeholder={saved?.token_configured ? "留空保留已存令牌" : "公开主题可留空"} onChange={e => setToken(e.target.value)} />
              {saved?.token_configured && <Button variant="ghost" disabled={locked} onClick={() => { setClearToken(x => !x); setToken(""); }}>{clearToken ? "保留已保存令牌" : "移除已保存令牌"}</Button>}
            </Field></CollapsibleContent>
          </Collapsible>
        </FieldGroup>
      </CollapsibleContent>
    </Collapsible>

    <section className="ntfy-test" aria-labelledby="ntfy-test-title">
      <div className="ntfy-section-heading"><h3 id="ntfy-test-title">测试通知</h3><span>{dirty ? "请先保存修改" : "可能响铃"}</span></div>
      <div className="ntfy-test-actions">
        <Button variant="outline" disabled={locked || dirty} onClick={() => void run("检查连接", async () => {
          const value = await api<{ ok: boolean; message: string }>("/settings/notification-transport/check", {}); setCheck(value);
          logEvent({ module: "通知", action: "检查连接", message: value.message, level: value.ok ? "info" : "error" });
        })}><Wifi data-icon="inline-start" aria-hidden="true" />{busy === "检查连接" ? "检查中…" : "检查连接"}</Button>
        <Button disabled={locked || dirty || !saved?.topic} onClick={() => void run("发送测试", async () => {
          setCheck(undefined);
          const value = await api<{ test_id: string }>("/notification-tests", {}); setResult(undefined); setTestError(""); setTestId(value.test_id); setReads(x => x + 1); changed();
          logEvent({ module: "通知", action: "发送测试", message: "测试通知已排队，等待手机确认", result: "info" });
        })}><Send data-icon="inline-start" aria-hidden="true" />{busy === "发送测试" ? "发送中…" : "发送测试"}</Button>
      </div>
      {error && errorAction !== "保存配置" && <p className="mobile-inline-error" role="alert">{error}</p>}
      {check && <p className={check.ok ? "more-description ntfy-check" : "mobile-inline-error ntfy-check"} role={check.ok ? "status" : "alert"}>{check.message}</p>}
      {testId && <div className="ntfy-test-result" data-result={testState}>
        <div className="ntfy-result-heading"><TestIcon aria-hidden="true" /><div><small>最近测试</small><p role="status">{result ? testLabel(result) : "正在查询发送结果…"}</p></div></div>
        {result && !result.ack_at && result.status === "server_accepted" && <p className="more-description">收到后，点击通知中的“确认测试”。</p>}
        {testError && <p className="mobile-inline-error" role="alert">结果查询失败：{testError}</p>}
        <div className="ntfy-result-actions"><Button variant="ghost" disabled={locked} onClick={() => setReads(x => x + 1)}>刷新结果</Button>
          {result && !result.ack_at && ["server_accepted", "delivery_error"].includes(result.status) && <Button variant="ghost" disabled={locked} onClick={() => void run("确认收到", async () => {
            await api(`/notification-tests/${testId}/received`, {}); setReads(x => x + 1); changed();
          })}>我已收到</Button>}
        </div>
      </div>}
    </section>

    <Button variant="ghost" className="ntfy-records" disabled={dirty || locked} onClick={records}><History data-icon="inline-start" aria-hidden="true" />通知与事件记录<ChevronRight data-icon="inline-end" aria-hidden="true" /></Button>
    <Collapsible className="more-environment ntfy-help">
      <CollapsibleTrigger render={<Button variant="ghost" className="more-environment-trigger" />}>接收帮助<ChevronDown data-icon="inline-end" aria-hidden="true" /></CollapsibleTrigger>
      <CollapsibleContent><div className="ntfy-help-content">
        <p className="more-description">手机需安装 ntfy，允许通知与后台运行。检查连接仅核验服务可达；发送测试才能确认手机接收。</p>
        <p className="more-description">运行通知短暂波动仅记录，连续异常满 3 分钟提醒一次。夜间静默不影响价格告警。</p>
        <p className="more-description">通知正文打开 App；“确认”表示收到本次通知，不会暂停告警。开启后台通知后，只发送新通知。</p>
      </div></CollapsibleContent>
    </Collapsible>
    {!online && <p className="more-description" role="status">连接已中断，恢复后可继续操作。</p>}
    <span className="sr-only" role="status">{message}</span>
    {dirty && <div className="ntfy-save-bar">
      {error && errorAction === "保存配置" && <div className="ntfy-save-error"><p className="mobile-inline-error" role="alert">{error}</p>
        {conflict && <Button variant="outline" disabled={locked} onClick={() => setReloadConfirm(true)}>重新读取配置</Button>}
      </div>}
      <div className="ntfy-save-actions"><span>修改尚未保存</span><Button disabled={locked || !draft.url.trim() || (draft.enabled && !draft.topic)} onClick={() => void run("保存配置", async () => {
      const value = await api<Config>("/settings/notification-transport", { url: draft.url, topic: draft.topic, enabled: draft.enabled, revision: draft.revision, token: token || null, clear_token: clearToken });
      setSaved(value); setDraft(value); setConflict(false); setToken(""); setClearToken(false); setCheck(undefined); setTestId(""); setResult(undefined); setMessage("已保存，后台已生效"); changed();
      logEvent({ module: "通知", action: "保存配置", message: "后台通知配置已保存", result: "success" });
    })}>{busy === "保存配置" ? "正在保存…" : "保存配置"}</Button></div></div>}
    {reloadConfirm && <MobileConfirm title="读取服务器最新配置？" description="将替换本次未保存的修改。" actionLabel="重新读取" onClose={() => setReloadConfirm(false)} onAccept={() => { setReloadConfirm(false); setRetry(x => x + 1); }} />}
  </div>;
}
