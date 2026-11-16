# 实时流停更排查（2026-11-16）

环境：Ubuntu 本机 Docker，`mw-managed-live-rollover-20261113`，18447。仅登录、读取状态、读取上游报价；未修改业务配置、数据库或重启服务。未访问生产环境。

## 已复现

`GET /api/market-data/live/status` 两次采样：XAUUSD、USDCAD、EURUSD 的 revision 未变化，最后报价为北京时间 07:31:20～21，connection=disconnected、quality=unauthorized、authentication_hold=true。临时探针断言 connected 且 quote_age_ms<120000 失败。

## 边界验证

API、market-runtime、data-worker 的账号、令牌和代理配置一致（只比较，不输出值）。后台进程存活。23:31:21 UTC 的 M1 确认请求收到 HTTP 401，此后约每五分钟认证复查；期间有 401 和 HTML 504。

同一运行容器、同一令牌只读探测：accounts/账号 instruments/账号 pricing 失败；品种 candles 返回 200。pricing stream 经代理和直连均收到 200 以及三个品种的新 PRICE，最新时间 00:14:52 UTC。因此不能将现象简单归因为令牌全失效或休市；账号 REST 路径异常与仍可读的实时流同时存在。

## 卡点

`oanda_worker.probe_authentication` 使用 `OandaPractice.validate_access`，要求 account summary、catalog、account pricing 全通过。`finish_auth_probe` 仅在完整验证成功时解除账号级认证暂停。现在 REST 失败使暂停持续，worker 不再尝试正常流，即使独立流探针能取得新报价。

现有证据不能确定 OANDA 账号 REST 返回 401 的更底层原因。不要直接改库清除暂停，也不要凭流可用伪造 M1 确认成功。若修复，需要分别处理实时流恢复和 REST 确认健康；保留真实鉴权失败的退避，验证账户身份、断流恢复及确认补齐。

证据摘要：status.json；原始含账号范围的 API 响应仅保留本机临时目录，不入库。上述为排查时状态；修复后结果见下文。


## 修复与实际验收

已更新本任务 Ubuntu 18447 的 api / market-runtime / data-worker，web、APK、配置和数据库结构未变。镜像及旧版本引用见 deployment.json，自动测试和独立审阅见 review.md。

修复将 REST 确认健康与实际流采样隔离；已登记身份的流恢复不依赖 REST 目录。认证暂停只有在所请求品种全部出现真实 PRICE 后才解除，新注册分支同样适用；探针数据不发布为价格或确认分钟。

00:43 UTC 首次解除暂停后，正式流握手再次收到真实401。另以相同流适配器独立重复探测4次，3次收到PRICE，1次401，确认存在间歇上游鉴权异常。保留真实流鉴权失败的退避，不强制清除暂停。

00:48 UTC 正常重试自动恢复，00:48:24～00:50:26 UTC 连续122.2秒采样全部通过。三品种的 source_time/revision 与自建对外报价 observed_at 均前进；分钟确认随后恢复，末次三品种均 connected、quote_ready=true、candle_ready=true、confirmation_error=null。未人工修改库中的认证状态。

真实观测见 recovery-observation.json。独立浏览器只读访问 /m/watch 的截图和结果见 browser.json；浏览器验收不替代 Android 真机。无需重装APK。
