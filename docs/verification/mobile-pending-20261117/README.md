# 手机端待实现清单实施与验收

实施分支 `feat/mobile-pending-20261117`，基线 `aacb80e2`（实施启动时最新部署 HEAD，包含尚未合并的图表、通知与供源修复）；远端 main `1f2005c3`。原方案工作树保留。

## 已实现

- 告警触发详情直达同来源、品种、周期的专业图表。根据事件快照真实判定区间与已接受行情的 `chart_time` 映射定位，支持 NY17 日线等非 UTC0 坐标；事件标记临时保存，返回保留原记录、筛选及滚动。查看不确认、不处理、不暂停规则。版本变化明确说明；旧记录缺证据时不伪称精确判定柱。
- 更多 → 头寸计算：60 个 Dukascopy MT4 USD 合约预设；本机 BigInt 精确运算，USD 基础货币按止损价换算，交叉盘固定参考换算，按合法步长向下取整；离线可手填，记忆有效风险预算及常用参数。排除佣金、隔夜费、滑点等成本。
- 更多 → 市场简报：一个默认关闭的每日晨报计划，按真实自选分组动态成员、北京时间08:00运行。确认 D1 涨跌、有限缓存优先读取、180秒总预算、最多2个并发补取、不可变正文与游标历史；未知日历仅作注明日期的参考，不入有效排行。少量 M1 缺口不阻断来源确认的已结束自建日线。预览不推送。
- 简报独立通知类型，沿用 ntfy 配置及静默设置，实时告警优先；最多3次失败重试、2小时有效期、无确认按钮、不计告警未读。Android 可信服务器来源限定的简报 URI，冷/热启动复用既有壳导航。

## 已通过的本地检查

- 完整 Web 构建与 TypeScript，Ruff，diff whitespace。
- 独立算例：60预设、EURUSD/JPY/交叉盘/黄金、half-up、最小手数/步长与风险边界。
- 事件目标解析与实际 accepted interval 模块：D1/W1/MN真实起点与图表标签不同；原生异步range串行、有限dataReady等待、iframe手势取消与标记清理。
- 真实许可专业图表浏览器：通知入口/全局记录/规则记录 → 精确H1与NY17 D1判定柱 → 返回原详情；主导航放弃不会重新弹出隐藏抽屉。临时标记不写布局；查看最新回实时端。简报同ticker D1图表返回保留正文及滚动。
- 头寸与简报：375/412px、深浅主题、150%字号18张截图；短视口/离线有效参数/表单冲突409重读/断线草稿保留/不同报告404不显示旧正文。事件图表另8张主题字号截图。
- 桌面隔离：真实许可桌面widget的增强指标入口、布局保存和偏好不受手机操作影响。
- 隔离 PostgreSQL 合同68项通过：旧schema真实升级、既有自选及通知保留、重复迁移、并发计划/预览幂等/attempt fence、后台预算、周末/DST、真实来源日历身份、稀疏确认D1、通知quiet/401/403/有限重试/无ack/未读隔离；HTTP仅使用测试替身。
- Android Docker离线unit/lint/assemble通过（51 tasks）。0.1.6 / versionCode7，签名SHA256与开发实例已发布0.1.5一致。APK SHA256 `27de9bd04ef8727a13af34b90201c8123048ebb8a80fdbaa7809aafe49bb9b60`。
- F1独立Spec复审：无剩余阻断；Standards修复后复核记录在交付证据。

## 开发实例部署

正在准备 Ubuntu 本机 Docker `mw-dev` 迁移及R1，只替换本轮需要的API/Web/三个后台角色，保留真实配置与数据。首次部署不启用晨报，不改真实规则，不发送真实测试通知。

## 回退

新增表保留，不downgrade/drop。暂停晨报并取消未发送的briefing Outbox，随后可回退Web与worker镜像。API保留本候选的通知计数兼容代码：旧API会把已生成且无ack的briefing计为未读，不能直接退回旧API；如确需完整API回退，先构建含该计数修复的兼容旧候选。报告和真实告警历史均不删除、不伪造ack。

## 证据与边界

本机 `/tmp/mw-pending-contracts.log`、`/tmp/mw-event-chart-browser/proof.json`、`/tmp/mw-mobile-pending-browser/proof.json`、`/tmp/mw-pending-desktop.log`、`/tmp/mw-pending-android.log`；私有部署、备份与配置指纹置于仓库外 `~/.local/share/market-watch-dev/evidence/mobile-pending-20261117/`。

Android真机输入法、覆盖安装、真实ntfy实收及锁屏点击冷/热启动待用户协助验证。本轮未发送真实通知，浏览器测试不等于手机端到端验收。
