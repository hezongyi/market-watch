import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Button } from "./components/ui/button";
import { Switch } from "./components/ui/switch";
import { Field, FieldContent, FieldLabel, FieldDescription } from "./components/ui/field";
import { useOverlayActive } from "./WatchOverlays";

type Policy = {system_quiet_enabled: boolean; quiet_start: string; quiet_end: string; timezone: string} & Record<string, unknown>;

export default function RuntimeNotificationPolicy({ online, saving, disabled = false }: {online: boolean; saving(value: boolean): void; disabled?: boolean}) {
  const active = useOverlayActive();
  const [policy, setPolicy] = useState<Policy>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => { saving(busy); }, [busy, saving]);
  useEffect(() => () => saving(false), [saving]);
  useEffect(() => {
    if (!active || !online) return;
    const controller = new AbortController();
    setError("");
    void api<Policy>("/settings/notifications", undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setPolicy(value); })
      .catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    return () => controller.abort();
  }, [active, online, retry]);
  return <section className="ntfy-policy" aria-label="运行通知偏好">
    <Field orientation="horizontal" data-disabled={!online || !policy || busy || disabled || undefined}>
      <FieldContent>
        <FieldLabel htmlFor="runtime-quiet">运行通知夜间静默</FieldLabel>
        <FieldDescription>{policy ? policy.system_quiet_enabled ? `${policy.quiet_start}–${policy.quiet_end} · ${policy.timezone === 'Asia/Shanghai' ? '北京时间' : policy.timezone}` : "已关闭 · 夜间也会提醒" : error ? "设置暂时无法读取" : "正在读取设置…"}</FieldDescription>
      </FieldContent>
      <Switch size="lg" id="runtime-quiet" disabled={!online || !policy || busy || disabled} checked={policy?.system_quiet_enabled ?? true}
        onCheckedChange={value => {
          if (!policy || busy || disabled) return;
          setBusy(true); setError("");
          const { capabilities: _, ...saved } = policy;
          void api<Policy>("/settings/notifications", {...saved, system_quiet_enabled: value})
            .then(setPolicy).catch(e => setError(errorMessage(e))).finally(() => setBusy(false));
        }} />
    </Field>
    <p className="more-description ntfy-policy-note">更改即生效 · 不影响价格告警</p>
    {error && <div className="ntfy-policy-error"><p className="mobile-inline-error" role="alert">{error}</p>{!policy && <Button variant="ghost" disabled={!online || disabled} onClick={() => setRetry(x => x + 1)}>重新读取提醒设置</Button>}</div>}
  </section>;
}
