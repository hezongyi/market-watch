import { NativeInput, NativeSelect } from "./NativeControls";
import { time, type FrameRule } from "./types";

export function FrameSchedules({frames, value, change}: {
  frames: string[]; value: Record<string, FrameRule>; change: (value: Record<string, FrameRule>) => void;
}) {
  return <fieldset><legend>各周期维护</legend>
    <p>每日按所选维护时间更新；间隔更新至少 15 分钟。每次复查当前可得窗口，不因重叠根数缩短窗口；归档保留已取得的历史，实际覆盖取决于来源返回。</p>
    {frames.map(frame => {
      const rule = value[frame] || {schedule: "daily", interval_minutes: 60, overlap_bars: 2};
      const update = (patch: Partial<FrameRule>) => change({...value, [frame]: {...rule, ...patch}});
      return <div className="dc-frame-schedule" key={frame}>
        <strong>{frame}</strong>
        <label>更新方式<NativeSelect aria-label={`${frame} 更新方式`} value={rule.schedule} onChange={e => update({schedule: e.target.value})}><option value="daily">每日</option><option value="interval">间隔更新</option></NativeSelect></label>
        {rule.schedule === "interval" && <label>间隔（分钟）<NativeInput aria-label={`${frame} 间隔分钟`} type="number" min={15} max={10080} value={rule.interval_minutes} onChange={e => update({interval_minutes: Number(e.target.value)})}/></label>}
        <label>重叠复查（根）<NativeInput aria-label={`${frame} 复查根数`} type="number" min={0} max={10000} value={rule.overlap_bars} onChange={e => update({overlap_bars: Number(e.target.value)})}/></label>
        <label>独立起点（可选）<NativeInput aria-label={`${frame} 起始日期`} type="date" value={rule.target_start == null ? "" : new Date(rule.target_start).toISOString().slice(0,10)} onChange={e => update({target_start: e.target.value ? Date.parse(`${e.target.value}T00:00:00Z`) : undefined})}/></label>
        {rule.next_due != null && <small>下次：{time(rule.next_due)} · 上次成功：{time(rule.last_success)}</small>}
      </div>;
    })}
  </fieldset>;
}

export function editableFramePlan(value: Record<string, FrameRule>, frames: string[]) {
  return Object.fromEntries(frames.map(frame => {
    const rule = value[frame] || {schedule: "daily", interval_minutes: 60, overlap_bars: 2};
    return [frame, {schedule: rule.schedule, interval_minutes: rule.interval_minutes,
      overlap_bars: rule.overlap_bars, ...(rule.target_start == null ? {} : {target_start: rule.target_start})}];
  }));
}
