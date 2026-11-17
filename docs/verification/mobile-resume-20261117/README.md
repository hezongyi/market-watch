# 手机端前台恢复同步（2026-11-17）

## 范围与风险

F0：兼容的手机端会话、行情恢复及显示逻辑；无 schema、服务器采集或预取策略变更。后台仍暂停手机连接，回前台补齐数据。服务器告警和 ntfy 投递不改动，不发送真实告警测试。

独立工作树 `market-watch-mobile-resume-20261117`，分支 `fix/mobile-resume-20261117`。保留开发实例已部署的告警生命周期、界面及告警选品修复；其余任务工作树不修改。

## 复现与修复

- `node tests/mobile-resume.cjs`：旧实现模拟 20 秒无心跳，流数量仍为 1（预期 2），复现假在线。手机端增加心跳超时恢复、联网立即重试和有界的注册请求。休市/价格不变不会触发重连，后台取消检查。
- `node tests/mobile-watch-resume.browser.cjs`：旧实现重连后 sparkline 读取数仍为 1，未立即补齐。重连同时读取完整曲线和报价快照；按数据时间防止 SSE 重放/迟到 HTTP 覆盖新报价。
- `node tests/mobile-chart-resume.cjs`：旧实现恢复没有建立新世代。恢复从 native 实际接受的 cursor、尾部版本与观察时间重新注册，丢弃旧世代；超出重放范围仍复用后端显式 reset/历史补齐能力，Python 指标沿用现有协调器。
- `node tests/mobile-chart-resume.browser.cjs`：旧实现离线后 iframe 数为 0，销毁了图表。已验证会话在短暂离线时保留同一 native widget、K 线和参数；会话失效和退出仍清理。回前台不再重读旧的本机选品/主题覆盖当前操作。
- sparkline 历史准备与较新的观察请求交错时，按服务端 `as_of` 拒绝旧曲线，保留真实缺口，不插值生成价格。

## 本地证据

已通过：完整 TypeScript/许可图表构建；mobile cache、chart preparation、transport、resume、native resume、sparklines、共享订阅、行情 datafeed、API 读取恢复；自选恢复及完整自选交互浏览器测试；真实许可图表离线保留、断线期间 K 线补齐、当前 bar 更新与指标参数保留；共享 SSE 浏览器回归。

原有 `chart-stream-native.browser.cjs` 在未修改的基线 runtime 也失败（固定旧 generation 推送时，native 已重建为另一 generation）；本轮新建的真实许可手机图表用例等待当前订阅后验收。此旧测试失败不冒充通过。

浏览器测试使用明确行情夹具，不代表供应商实盘或 OPPO/ColorOS 锁屏实测。开发实例部署、真实行情和下载链路证据待补。
