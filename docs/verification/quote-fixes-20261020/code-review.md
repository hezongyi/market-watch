# PR #87 最终增量审查与返工

使用code-review skill的独立Standards／Spec两轴审查。固定PR base `2fe919a23d4adcb97ca1a98caafbad8693a410d3` 到 `e6c3943f6f26bb87d9dae750173c847dd7c5dcff`，结合此前全PR/13–21审查记录核查整体接入，重点本轮22–23及工具栏补丁；返工固定提交 `25152a409bc7d2a4d3b64751e7f3f1b5e5e9a109`。文档归档不改变产品代码。

## Standards

标准来源：AGENTS.md、CONTEXT.md、deploy/ubuntu/README.md，加skill的Fowler smell基线。未发现剩余明确规范违规或需整改smell。

发现1项P2：关闭`notification_center_sources_enabled`时，record_result不写waiting_since，Calculator每次以now回退导致2–2.5秒探测无界。返工增加配置开关保护，关闭时保持原15秒；新增0/31秒回归。独立静态复核确认修复，最终另行窄复核25152a4三个Python文件（含D1返工）通过，无新阻断。主会话最终定向49项通过。

Standards独立执行价格格式、provider subscriptions、真实原生ToolbarIconButton及模板顺序回归均PASS。未独立重跑全量Docker/浏览器，不将主会话验收冒称代理实测。

## Spec

需求来源：Issue #75、通知合同与实施记录、待改清单22–23、两项只读分析及本轮验收README。

发现1项P2：stale保留bars后仍计算quote_previous_close，冷D1缓存会打开单品种HTTP，违反“有限缓存重读，不额外打开供应商请求”。独立无网络调用链实证stale时进入D1/count2上游。原fixture全局替换昨收查询，漏掉此路径。

返工：pending/stale跳过派生昨收读取；保留正常报价的既有流程。fixture移除全局昨收替身，以native_page守卫覆盖真实派生路径，修复前明确红、修复后通过。Spec独立运行最新共享等待文件**6 passed**；同时复核关闭通知源的15秒保护。

整体集成及新增重点无其他明确偏差：等待既不报错也不恢复；持续30秒升级、旧价采样时间保留；共享事故去重、取消与真实恢复分离；自建精度补零及平台政策、原生工具栏模板排序正确。代理分段诊断与账户批次持久化属于后续扩展。独立前端价格、provider subscriptions、notifications runtime、advanced market stream四项PASS。

## 最终验证边界

产品返工49项定向后端及最终API c2镜像代码12项PASS，Ruff/diff通过。原生浏览器自建价格三行在c2更新后再次匹配；Chart/Web未改。15服务running，API/PG healthy，11运行后端Yahoo=true，环境/挂载、PG/gateway/初始化及原浏览器现场保留。

首轮固定HEAD `e6c3943` 的CI [39434933202](https://github.com/hezongyi/market-watch/actions/runs/39434933202) 全部success；返工与最终归档以PR当前HEAD checks为最终结果。修改前后同样存在的本地60ms预算波动保留原始日志，不作为忽略新CI失败的理由。

Standards：1项P2已关闭，剩余0；Spec：1项P2已关闭，剩余0。代码审查、实例业务验收与最终CI分别记录。保持Draft，未合并、未发布生产。
