"""Stable execution codes and user-facing explanations shared by API and notices."""

REASONS = {
    "awaiting_worker": "规则已保存，等待后台接管。",
    "awaiting_confirmed_baseline": "等待第一根可验证的确认收盘柱建立基准；首次基准不触发。",
    "awaiting_recovery_baseline": "输入已恢复，等待有效观察建立恢复基准。",
    "price_input_unavailable": "当前价格输入不可用；规则保持启用，等待供源恢复。",
    "takeover_waiting_price": "后台正在接管旧规则，等待有效价格建立基准。",
    "confirmation_source_unavailable": "当前确认来源不可用；已取得的确认柱仍按序处理。",
    "confirmation_query_failed": "此判定窗口的确认请求失败，等待同源查询补齐。",
    "confirmation_window_pending": "此窗口尚无完整查询证明，不能跳过它比较后续价格。",
    "confirmation_aggregation_pending": "此窗口的新确认输入尚未完成聚合，等待发布。",
    "observed_minute_unconfirmed": "窗口内存在已观察但未确认的分钟，等待来源确认。",
    "confirmation_window_unreadable": "所需输入超出可验证范围，请更新历史基线并显式编辑绑定。",
    "realtime_disabled": "实时开关已关闭；请重新开启后检查规则状态。",
    "binding_unavailable": "固定组合来源不存在，请检查并编辑规则绑定。",
    "binding_changed": "固定来源、账号或口径已改变，请显式编辑规则。",
    "binding_frozen": "绑定修订已冻结，请显式编辑为可执行修订。",
    "binding_contract_changed": "固定组合算法契约已改变，请编辑规则生成新版本。",
    "price_baseline_unavailable": "当前没有有效价格基准，不能启用触价告警。",
    "input_retention_exceeded": "部分未处理观察已被保留上限裁剪，无法补判该区间。",
    "price_sample_gap": "相邻价格观察之间存在未观测区间，恢复后先建立基准。",
    "unverified_connection_boundary": "连接更替期间无法证明输入连续，恢复后先建立基准。",
    "observation_mode_changed": "采集模式发生切换，记录口径变化并重新建立基准。",
    "invalid_price_sample": "来源样本未通过有效性校验，该区间不能用于比较。",
    "out_of_order_price": "收到乱序价格，相关区间不能保证连续。",
    "pricing_disconnected": "行情连接中断，等待来源恢复。",
    "collection_stopped": "采集已停止，相关区间无法保证连续。",
    "timeout": "来源请求超时，等待采集恢复。",
    "unavailable": "来源暂时不可用，等待采集恢复。",
    "rate_limited": "来源请求受限，等待供应商允许重试。",
    "unauthorized": "来源账户认证失败，请检查账户配置。",
    "provider_maintenance": "供应商维护中，等待来源恢复。",
    "invalid_payload": "来源响应无效，无法用作价格观察。",
    "upgrade_boundary": "已接管旧规则；升级前未保留的观察路径无法追认。",
    "expiry_unobserved_tail": "有效期末存在未观测区间，无法补判是否触发。",
    "settlement_unobserved_input": "到期结算已结束，部分区间无法判定，记录已保留。",
    "expired_before_price_takeover": "规则在新后台接管前已到期，旧未观测区间无法补判。",
    "settlement_evaluation_failed": "到期结算遇到执行错误，未判定区间已保留，请检查后台。",
    "settlement_input_unavailable": "到期结算所需输入不可用，未判定区间已保留。",
    "worker_not_taken_over": "启用超过60秒仍未被后台接管，请检查行情运行服务。",
    "worker_progress_stalled": "已有待处理输入超过60秒未推进，请检查判定服务。",
    "evaluation_failed": "后台判定失败；规则保持启用，请检查执行服务。",
    "legacy_auto_paused": "旧版本因输入过期自动暂停了此规则；请检查来源后明确恢复。",
    "phone_permission_denied": "手机发送服务拒绝访问，请核对 topic 和访问令牌。",
    "phone_topic_missing": "手机通知未配置 topic，请在通知设置中完成配置。",
    "phone_delivery_disabled": "手机发送已全局关闭，请在通知设置中开启。",
}


def message(code):
    return REASONS.get(code, "价格告警暂时无法判定，请检查来源和后台运行状态。") if code else None


class Unavailable(ValueError):
    def __init__(self, code, text=None):
        self.reason_code = code
        super().__init__(text or message(code))


class NotificationConfigurationError(ValueError):
    field = "notify_ntfy"

    def __init__(self, code):
        self.code = code
        super().__init__(message(code))


def validate_notification(config):
    from .config import settings
    from .price_alert_inputs import is_price_rule

    if not is_price_rule(config) or not config.notify_ntfy:
        return
    if not settings.ntfy_topic.strip():
        raise NotificationConfigurationError("phone_topic_missing")
    if not settings.delivery_enabled:
        raise NotificationConfigurationError("phone_delivery_disabled")
