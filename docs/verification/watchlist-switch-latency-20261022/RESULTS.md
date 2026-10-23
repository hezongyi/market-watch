# 自选切换优化：当前结果

2026-10-23 最终候选已部署 mwa，**完整业务复验 13/13 通过，包含三轮 15 次加载中连切**。连切修复、回归、平台分段测量及局部结果轮询优化已完成。建议按本轮批准范围收口；平台和指标仍有数秒等待，尚无稳定 p95 或其他链路零下降结论。完整对照与建议见 [CLOSEOUT-20261023.md](CLOSEOUT-20261023.md)。

## 固定候选与现场

- 原集成基线 `983b402`；分支 `fix/watchlist-latency-20261022`；worktree `/home/quant/repos/market-watch-watchlist-latency-20261022`。
- API／10 个 worker 与 Web 干净构建 `914525a`；Chart 保留干净构建 `b7ef7be`。后续文档提交不改变产品制品身份。
- Ubuntu `quant-server`，project `mw-issue75-v2-20261018`；15 服务运行、API／PG healthy。
- 末轮替换 12 应用服务；Chart／PG／gateway 未替换，环境、Yahoo／MCP、挂载、端口、网络、TLS、资源上限、真实数据与保护浏览器保持。
- 风险 F1：原生历史和指标取消后台链路；无 schema／持久格式／供源口径变化，新增兼容 capability 和结果进度元数据。

| 制品 | 构建提交 | 固定镜像 ID |
| --- | --- | --- |
| API／worker | 914525a | `sha256:a7c395db8e4ce6355d60085f5ee6f33c47fccab44837e6a58581fac1a48472e4` |
| Web | 914525a | `sha256:1ec604df54f2923798e478489326e74b6684bbdfd2a7fdb39f468fb9d710526e` |
| Chart | b7ef7be | `sha256:41707f26ad94eedd85655366d73a77153364c8af48b7f3bee6c652916e78b64d` |

[制品标签](continuation-candidate-images.json)、[部署审计](continuation-mwa-update-audit.json)。Web：`https://192.168.7.232:18280`；Chart：`https://192.168.7.232:18281`。启停使用 `python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`。

## 实际行为与证据

最初实现普通四槽／后台二槽／报价单飞，活动首屏优先且有界公平；成功价格先交付，清理在四生命周期内继续；可选预热锁忙跳过。真实连切随后暴露重复报价／释放占满 64 项队列，首屏被拒后不再重试。续轮清理失效排队项、共享同集合在途报价、合并未派发释放，并修复共享报价相对较新 SSE 的观察围栏。

分段测量后改用既有 result 入口轮询，完成时同次返回结果和最终页数；能力缺失保留旧流程。前版两轮 10/10、6/6 任务在 ready 后另取结果，当前 **0/10**。回调／原生绘图为毫秒级，暂无线索支持改变 worker 认证／历史任务次序。见 [分段证据](continuation-stage-measurements.json)。

| 检查阶段 | 实际结果 |
| --- | --- |
| 首轮实现 | 106 项 Python／PG、50 条前端 runtime、6 条 Chromium、构建／Ruff／diff 通过；defdcf9 最终连切失败，历史证据保留 |
| 连切续轮 | 53 条前端 CI runtime 最终通过、42 项 Python、7 项隔离真实 PG 通过；报价围栏增量七项复跑通过 |
| 结果轮询增量 | 20 条 bridge CI 命令、18 项 Python、2 项真实 PG、TypeScript／Vite／data-center、Ruff／diff 通过 |
| 独立 Standards／Spec | 续轮两项 P2 修复并复核关闭；b7ef7be…914525a 无新增阻断；可选 P3 重复代码不阻断 |
| 前版 b7ef7be 业务验收 | 13/13：原五图／指标、两类翻页、三轮连切、报价、容量与持久状态 |
| 当前 914525a 业务复验 | **13/13**：同样三轮 15 次连切，无 pageerror 或意外 HTTP 失败，revision 78 与工作区／偏好哈希保持 |

各阶段测试有重叠，不加总为独立测试数。原容量测试首次触发 5 ms 时序断言后复跑通过；两个非 CI 旧 VM 脚本 bootstrap 失败未进入断言，不计为通过。真实 PG 属本任务隔离实例，结束后停止、保留卷。构建保留既有大 chunk 提示。详细边界见 [CONTINUATION-20261023.md](CONTINUATION-20261023.md)。

当前短时业务样本：平台首入五图 6.421 秒、回切 8.039 秒，组合原指标 12.595 秒；自建指标从前版样本 4.000 秒变为 5.672 秒。保留变慢反例。共享主机、缓存与供源未受控，不算改善比例或稳定分位数。[业务对照](continuation-business-acceptance.json) 和最终报告包含完整边界。

## 历史资料与交付边界

[OUTCOME-20261023.md](OUTCOME-20261023.md) 是 defdcf9 失败及用户选择继续前的历史报告，当前状态以本页和最终报告为准。旧 JSON 保留其原版本身份。[实施合同](IMPLEMENTATION.md)、[本地 PR 草案](PR-DRAFT.md)。未推送、创建远端 PR、合并 main、打正式 tag 或发布生产。

紧邻前版回退资料：`/home/quant/repos/.mwa-watchlist-latency-20261022/continuation-update-914525a/`。明确决定回退后，仅结合该目录 rollback-override 和原 base 指定本轮 12 服务，并恢复 previous-candidate-override 至持久入口；不使用任务顶层更旧回退或历史 manager 默认 rollback。
