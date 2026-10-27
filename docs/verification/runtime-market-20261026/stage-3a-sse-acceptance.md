# 阶段3A：图表SSE合并切片

日期：2026-10-27。基线：`bb02c6e36c8da013d802bfc95c3651620b264545`（`v1.29.2-rc.1` peeled commit）。本切片只迁移图表供应商事件通道，不搬迁data-worker职责。

## 改动边界

供应商和自建图表共用 `/charts/stream/{subscribe,unsubscribe,events,accept}`，仅一条 EventSource。旧供应商HTTP路径保留为认证的410，不再注册订阅或调用采集服务。服务内部 `provider_service` 方法仍保留，market-stream worker继续通过它维护共享低频采集需求。`?marketPolling=1` 保持原有诊断行为：managed/composite轮询，supplier继续实时SSE，现使用统一通道。

统一 reset 在异步原生历史重载之前使旧bar-range mapping与generation失效；历史窗口仍不追加最新尾部。晚到HTTP历史页仍使用独立bounded revalidation。旧provider-event测试迁移至统一事件，覆盖服务端已核实历史不变、确认修订后原生reset/reload和取消/旧generation边界。

## 验收

- provider subscriptions契约和单前端相关单测通过；`npm run build:ui`通过。
- 本机 Chromium真实EventSource transport覆盖供应商/自建共连接、断线重连保留cursor、reset、切换generation和单路/全路取消。
- 本机 Chromium加载仓库私有授权v31图表库、实际 `chart-runtime.js` 和真实EventSource；HTTP历史及事件为本机确定性fixture。分别执行supplier/composite真实widget回调、新bar可见、历史修订→真实reset→HTTP重新加载、切换、旧generation拒绝、重连、取消。无浏览器错误。
- 旧HTTP端点认证退役合同通过。
- 工作树中的隔离PostgreSQL市场流合同运行中；结果完成后更新本记录，不把启动中的进度当通过。
- 没有真实供应商/生产登录/ntfy投递；本测试不包含真实市场SLA，也不测试生产前端部署。

## 后续

该切片通过后才可把服务端旧HTTP路径按410退役。data profile职责迁移是独立后续切片；整体阶段3A和方案核心仍未完成。Draft PR可以先用于审阅，CI按既有流程运行。
