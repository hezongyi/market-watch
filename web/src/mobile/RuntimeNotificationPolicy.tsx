import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Switch } from "./components/ui/switch";
import { Field, FieldContent, FieldLabel, FieldDescription } from "./components/ui/field";
import { useOverlayActive } from "./WatchOverlays";

type Policy = {system_quiet_enabled: boolean; quiet_start: string; quiet_end: string; timezone: string} & Record<string, unknown>;

export default function RuntimeNotificationPolicy({ online, saving }: {online: boolean; saving(value: boolean): void}) {
  const active = useOverlayActive();
  const [policy, setPolicy] = useState<Policy>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { saving(busy); }, [busy, saving]);
  useEffect(() => () => saving(false), [saving]);
  useEffect(() => {
    if (!active || !online) return;
    const controller = new AbortController();
    void api<Policy>("/settings/notifications", undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setPolicy(value); })
      .catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    return () => controller.abort();
  }, [active, online]);
  return <Field orientation="horizontal">
    <FieldContent>
      <FieldLabel htmlFor="runtime-quiet">运行通知夜间静默</FieldLabel>
      <FieldDescription>后台服务短暂波动仅留记录，连续异常满 3 分钟提醒一次。运行通知使用普通优先级；
        {policy?.system_quiet_enabled === false ? "夜间也可提醒。" :
          `${policy ? `${policy.quiet_start}–${policy.quiet_end}（${policy.timezone}）` : "23:00–07:00（Asia/Shanghai）"}静默。`}
        价格告警沿用原提醒策略。</FieldDescription>
      {error && <p role="alert">{error}</p>}
    </FieldContent>
    <Switch size="lg" id="runtime-quiet" disabled={!online || !policy || busy} checked={policy?.system_quiet_enabled ?? true}
      onCheckedChange={value => {
        if (!policy || busy) return;
        setBusy(true); setError("");
        const { capabilities: _, ...saved } = policy;
        void api<Policy>("/settings/notifications", {...saved, system_quiet_enabled: value})
          .then(setPolicy).catch(e => setError(errorMessage(e))).finally(() => setBusy(false));
      }} />
  </Field>;
}
