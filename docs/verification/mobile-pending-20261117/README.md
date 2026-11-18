# 手机端待实现清单实施与验收

实施分支 `feat/mobile-pending-20261117`，基线 `aacb80e2`（实施启动时最新部署 HEAD，包含尚未合并的图表、通知与供源修复）；远端 main `1f2005c3`。原方案工作树保留。

## 已实现

- 告警触发详情直达同来源、品种、周期的专业图表。根据事件快照真实判定区间与已接受行情的 `chart_time` 映射定位，支持 NY17 日线等非 UTC0 坐标；事件标记临时保存，返回保留原记录、筛选及滚动。查看不确认、不处理、不暂停规则。版本变化明确说明；旧记录缺证据时不伪称精确判定柱。
- 更多 → 头寸计算：60 个 Dukascopy MT4 USD 合约预设；本机 BigInt 精确运算，USD 基础货币按止损价换算，交叉盘固定参考换算，按合法步长向下取整；离线可手填，记忆有效风险预算及常用参数。排除佣金、隔夜费、滑点等成本。
- 更多 → 市场简报：一个默认关闭的每日晨报计划，按真实自选分组动态成员、北京时间08:00运行。确认 D1 涨跌、有限缓存优先读取、180秒总预算、最多2个并发补取、不可变正文与游标历史；未知日历仅作注明日期的参考，不入有效排行。少量 M1 缺口不阻断来源确认的已结束自建日线。预览不推送。
- 简报独立通知类型，沿用 ntfy 配置及静默设置，实时告警优先；最多3次失败重试、2小时有效期、无确认按钮、不计告警未读。Android 可信服务器来源限定的简报 URI，冷/热启动复用既有壳导航。

## 已通过的本地检查

- 完整 Web 构建与 TypeScript，Ruff，diff whitespace。
- 工具回归111项与94项子检查通过；新隔离Compose明确检查PostgreSQL14.24及JIT能力。既有网页告警编辑/历史搜索回归通过：历史事件fixture显式使用自身上穿条件，避免跟随新增规则默认穿过条件而失真。新增头寸/事件映射/工具浏览器回归已纳入CI。
- 独立算例：60预设、EURUSD/JPY/交叉盘/黄金、half-up、最小手数/步长与风险边界。
- 事件目标解析与实际 accepted interval 模块：D1/W1/MN真实起点与图表标签不同；原生异步range串行、有限dataReady等待、iframe手势取消与标记清理。
- 真实许可专业图表浏览器：通知入口/全局记录/规则记录 → 精确H1与NY17 D1判定柱 → 返回原详情；主导航放弃不会重新弹出隐藏抽屉。临时标记不写布局；查看最新回实时端。简报同ticker D1图表返回保留正文及滚动。
- 头寸与简报：375/412px、深浅主题、150%字号18张截图；短视口/离线有效参数/表单冲突409重读/断线草稿保留/不同报告404不显示旧正文。事件图表另8张主题字号截图。
- 桌面隔离：真实许可桌面widget的增强指标入口、布局保存和偏好不受手机操作影响。
- 隔离 PostgreSQL 合同68项通过：旧schema真实升级、既有自选及通知保留、重复迁移、并发计划/预览幂等/attempt fence、后台预算、周末/DST、真实来源日历身份、稀疏确认D1、通知quiet/401/403/有限重试/无ack/未读隔离；HTTP仅使用测试替身。
- Android Docker离线unit/lint/assemble通过（51 tasks）。0.1.6 / versionCode7，签名SHA256与开发实例已发布0.1.5一致。APK SHA256 `27de9bd04ef8727a13af34b90201c8123048ebb8a80fdbaa7809aafe49bb9b60`。
- F1独立Spec与Standards复审均通过，无剩余阻断。
- PR #144 CI补充回归：健康接口的通知任务集合断言补入已注册的 `briefing_generation`，保留精确集合检查；原失败本地复现后，健康、通知运行组、晨报与运行循环相关37项通过。仅测试预期更新，运行镜像不变；最终CI结果以PR检查为准。

## 开发实例部署

已部署并完成 Ubuntu 本机 Docker `mw-dev` R1，候选 `a5efdf7e83bfcd0a0c5a94b978e91105ef7ed66f`。只替换 API、Web、data-worker、market-runtime、notification-worker，TLS/PostgreSQL/ntfy 保持原容器。保留此前图表、供源、通知等未合并成果。

- 入口：`https://quant.kookvv.com:8443/m/more`；内网 `https://192.168.7.232:18443/m/more`。启动/状态/停止：`mw-dev up`、`mw-dev status`、`mw-dev stop`。
- API镜像 `sha256:2859c77d79d491911adf59309760de5841c006d594e0b1d021455ec8f4dacaa2`；Web镜像 `sha256:76bd14db7cdc54cf0ae2fcd15482cee875e4f64a3cc6ff5ba21f6fb5f325f53f`，均来自干净提交。后续文档提交不改变运行镜像。
- 实际 API 数据库为 `dev_mobile_20261116`。已备份完整schema及15张受影响的持久业务表，在隔离数据库恢复原主键/唯一约束/索引并升级至 `be58_market_briefings`；恢复前后及部署后，11份规则版本与通知/供源配置指纹相等。大体积历史行情缓存未复制，未宣称全库恢复。首次误取的默认 `dev` 库归档保留并明确标为不可用于本次部署。
- 域名HTTPS证书校验、ready、真实认证的自建列表/告警列表/简报计划与历史通过；新 `briefing_generation` 后台角色有实际成功进度。晨报计划不存在时返回默认关闭、revision0，报告为空；未修改真实规则、供源或通知设置，未发送真实测试通知。
- 真实D1抽样：Dukascopy黄金和Yahoo英伟达，旧缓存被识别为未更新；有限补取分别约1.53/2.19秒后读取到11月16/17日两根已结束日线并标为ok。未知日历仍明确仅作日期参考，不纳入有效排行。没有为验收开启订阅或维护计划。
- APK 0.1.6/versionCode7 已原子发布到开发实例持久下载目录，保留旧包。HTTPS清单 `no-store`、文件大小/哈希和缺失路径404验证通过；可在更多→检查更新获取。系统覆盖安装与实际手机签名仍待真机确认。

## 回退

新增表保留，不downgrade/drop。暂停晨报并取消未发送的briefing Outbox，随后可回退Web与worker镜像。API保留本候选的通知计数兼容代码：旧API会把已生成且无ack的briefing计为未读，不能直接退回旧API；如确需完整API回退，先构建含该计数修复的兼容旧候选。报告和真实告警历史均不删除、不伪造ack。

## 证据与边界

本机 `/tmp/mw-pending-final-contracts.log`、`/tmp/mw-event-chart-browser/proof.json`、`/tmp/mw-mobile-pending-browser/proof.json`、`/tmp/mw-pending-desktop.log`、`/tmp/mw-pending-android.log`；私有部署、备份与配置指纹置于仓库外 `~/.local/share/market-watch-dev/evidence/mobile-pending-20261117/`。

Android真机输入法、覆盖安装、真实ntfy实收及锁屏点击冷/热启动待用户协助验证。本轮未发送真实通知，浏览器测试不等于手机端到端验收。
