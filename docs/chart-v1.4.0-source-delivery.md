# v1.4.0 原生历史缓冲源码交付

2026-10-02。原生图表历史请求完整保留实际需求 D 与 Python 计算前缀 H，
后端附加有限缓存历史并复用已有预热。默认 cold E400、first PG E2000、
history E2000，多图及 focus 预算仅缩减可选量。语义和验收对应关系见
[R2 方案](provider-native-history-buffer-plan.md)及
[完成审计](verification/native-history/implementation/completion-audit.md)。

本次按用户授权推送源码，通过 `feature/native-history-buffer` 到 `main` 的
PR 保留提交历史，采用附注标签 `v1.4.0` 指向最终 main 合并提交。
版本元数据采用兼容新功能的次版本升级，Python/web 包及锁文件同步为 1.4.0。
发布清单见 [v1.4.0 源码清单](../deploy/releases/v1.4.0-source.json)。

固定集成基线为 Volume main `dd9ba43a4abc09359c0a05aa12390ba1885978df`，
原 native-history 分支为 `efe0ba4783a2ec95697ee494ed0c1c1a28550f54`。
最终受测集成源码为 `93db03bd20cfad60a7a41469a00851fd9742472b`；
其后仅更新版本元数据、发布文档及发布核对证据。
冲突解决保留同一 SQL statement 中的 bars、修订与 Volume 元信息。
独立审查发现的两个生命周期问题已修复：ready bars 后的可选激活复用最终
快照连接并以 SAVEPOINT 隔离失败；取消或过期请求独立释放带身份栅栏的 lease。
六项真实 PostgreSQL 回归覆盖行锁、native/legacy 连接池耗尽和取消/过期 owner。

最终后端全量 **395 passed、1 skipped**，使用一次性 PostgreSQL 17.11；
**40 个非浏览器 Node 脚本及 TypeScript/Vite 构建通过**。
Standards 无硬性违规，Spec 无剩余阻塞；两个低优先级代码整理意见留待独立变更。
332 项受测运行时/测试源码哈希及 229 项原验收证据保持一致。发布阶段再次核对
版本一致性、依赖未变化、源码/证据哈希和敏感信息，并验证新版包/前端构建。
原测试、setup 失败及红色回归记录保留，见
[集成验证](verification/native-history/integration-v1.3.3/README.md)；
发布核对见 [源码发布审计](verification/native-history/source-release-audit.json)。

Binance 固定样本仍是冷首屏 4/10、PG 7/10 数值 FAIL，503 和 PG miss 保留。
用户决定与原样本哈希绑定，见
[验收决定](verification/native-history/implementation/user-acceptance-decision.json)。
这表示接受已记录的交付限制，不表示性能已修复或每项失败已证明源于网络。
getBars 入口到 dataReady + 双 RAF 是主时钟，约一万根远距离导航属于独立压力场景。

此次是源码发布，没有新组合镜像的浏览器/运行验收，也不重建、重标或切换容器。
原 native-history 镜像来源见
[运行清单](verification/native-history/implementation/runtime-manifest.json)，
既有 Volume 本机镜像、schema 和部署来源见
[v1.3.3 本机清单](../deploy/releases/v1.3.3-local.json)。
组合源码 schema 保持 `p17_volume`，无新增迁移；不能将原 native-history
独立 o16 环境的记录当成已运行此组合版本的证明。生产部署须另行固定镜像来源、
核对目标 schema/配置及 API/worker 版本、备份并完成目标环境和回退验收。

源码回退基线是 `v1.3.3`，这会移除本次原生 D/H 合同及缓冲功能，同时保留 Volume。
只关闭 `ALERTS_PROVIDER_NATIVE_HISTORY_BUFFER` 则令可选 E 为零，仍保留原生 D/H，
两者不是同一回退操作。此次源码发布不需要运行回退；未来切换实际镜像前应核对
其来源、配置和 schema，既有 Volume 数据限制及回退条件继续遵循
[Volume 本机交付](chart-v1.3.3-delivery.md)。
