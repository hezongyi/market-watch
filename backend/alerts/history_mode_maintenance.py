"""Editable per-input schedules, separate from runtime due/success timestamps."""

from sqlalchemy import select

from .storage import DatasetFrameSource, now_ms


def configure_frames(db, dataset, outputs, requested, previous, *, target_start,
                     timezone, daily_minute):
    from .history_maintenance import next_daily

    bindings = set(db.scalars(select(DatasetFrameSource.timeframe).where(
        DatasetFrameSource.dataset_id == dataset.id)))
    daily = dataset.identity["mode"] == "base_d1"
    if not outputs or not set(outputs) <= ({"D1", "W1", "MN"} if daily else bindings):
        raise ValueError("请选择此模式与已验证来源共同支持的周期")
    inputs = {"D1"} if daily else set(outputs)
    if not inputs <= bindings or not set(requested) <= inputs:
        raise ValueError("周期维护配置缺少对应来源或包含未选择周期")
    result = {}
    for frame in inputs:
        old = (previous.frame_plan or {}).get(frame, {}) if previous else {}
        raw = requested.get(frame, {})
        if not set(raw) <= {"schedule", "interval_minutes", "target_start", "overlap_bars"}:
            raise ValueError("周期配置只能修改频率、范围与复查根数")
        rules = {"schedule": raw.get("schedule", old.get("schedule", "daily")),
            "interval_minutes": raw.get("interval_minutes", old.get("interval_minutes", 60)),
            "target_start": raw.get("target_start", target_start),
            "overlap_bars": raw.get("overlap_bars", old.get("overlap_bars", 2))}
        if (rules["schedule"] not in ("daily", "interval")
                or type(rules["interval_minutes"]) is not int or not 15 <= rules["interval_minutes"] <= 10080
                or type(rules["overlap_bars"]) is not int or not 0 <= rules["overlap_bars"] <= 10000
                or type(rules["target_start"]) is not int
                or not 0 <= rules["target_start"] < now_ms() or rules["target_start"] % 60000):
            raise ValueError("不支持的周期维护频率或历史范围；间隔至少15分钟")
        same = all(old.get(key) == value for key, value in rules.items())
        due = old.get("next_due") if same else None
        result[frame] = {**rules, "next_due": due or (
            now_ms() + rules["interval_minutes"] * 60000 if rules["schedule"] == "interval"
            else next_daily(now_ms(), daily_minute, timezone)), "last_success": old.get("last_success")}
    return result


def due_frames(plan, stamp):
    return [frame for frame, rule in plan.frame_plan.items() if rule["next_due"] <= stamp]


def advance_schedule(plan, frames, stamp):
    from .history_maintenance import next_daily

    values = {frame: dict(rule) for frame, rule in plan.frame_plan.items()}
    for frame in frames:
        rule = values[frame]
        rule["next_due"] = (stamp + rule["interval_minutes"] * 60000
            if rule["schedule"] == "interval" else next_daily(stamp, plan.daily_minute, plan.timezone))
    plan.frame_plan = values
    plan.next_at = min(rule["next_due"] for rule in values.values())
