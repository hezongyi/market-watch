价格规则曾只读最新报价或最后一根收盘柱，后台落后时会漏掉中间穿越；临时输入故障又会改变启用意图。现在触价顺序消费有界持久日志，close 顺序消费固定修订的确认柱；故障、未知区间、实际恢复及到期结算均有持久证据，并在规则详情与通知中心展示。

本 PR 基于 `v2.0.3-rc.1` (`ef57bed61f66715a4c5ec2797f9abd67cb23d2fb`)。以预取候选分支 `perf/provider-chart-prefetch-20261110` 为 PR base，避免把该候选已有变更计为本任务；未合并 main，未打正式 tag，未发布生产。

风险分类 **F1 / 定向 R2**：涉及新增 PostgreSQL 日志表、执行游标和重要后台链路。采用增量 Alembic；真实填充旧库升级保留旧 signal/judgment/pending Outbox，回退前暂停 price-v2 写入者并以原 rc.1 evaluator 验证围栏，不通过 downgrade 删除证据。

已验证：核心199项、执行/close/到期67项、迁移21项；PG专项64项、后续边界15项及既有链路整合46项，无PG跳过；ops110项与88子用例；前端生产构建与69条CI Node命令；独立 Standards/Spec 发现已修复并复核，真实运行时存活停滞/进程停止两场景通过。追加锁后取时修复的132项回归与9项PG并发通过，既有来源PG11项通过；补齐日期敏感fixture的窗口时钟，产品30天限制未改。Ubuntu实例为 `quant-server` 上独立 project，网页 `http://127.0.0.1:28463`，合成行情与本地HTTP通知fixture；不操作其他实例。

**保持 Draft：性能未验收。** 10品种/50规则/40观察每秒的10秒烟测未维持输入速率（基线159.45s、候选111.18s），候选采集p95=459.73ms、信号p95=14877.56ms；主机负载约22–26、PG1CPU/512MiB且同期有功能回归。候选100个预期信号均保留、最终积压零，但不能据此宣称性能达标。要求的600秒固定负载仍需错峰有效运行；最终API/web镜像的真实浏览器完整通过：原生创建/幂等、关闭全部页面且租约自然归零后触发、断线恢复不伪造穿越、恢复通知→规则链接→历史信号。全backend远端CI结果以本PR checks及下方最终运行记录为准。

完整证据、A01–A24对照、启动/停止/复现命令、实际镜像ID和限制见 [验收记录](docs/verification/price-alert-reliability-v203rc1/README.md)，审查见 [reviews.md](docs/verification/price-alert-reliability-v203rc1/reviews.md)。
