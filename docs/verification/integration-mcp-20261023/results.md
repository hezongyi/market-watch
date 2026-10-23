# 集成分支 mwa：连接池占用修复与验收通过

2026-10-23，按用户“不更新 PR，先排查原因、修复并验证”执行。修复后本轮业务与短时并发验收通过；修复及本报告仅保存在本地，未更新 PR 或触发 CI。

## 当前运行与范围

Ubuntu `quant-server`；project `mw-issue75-v2-20261018`。网页 https://192.168.7.232:18280 ，Chart https://192.168.7.232:18281 ，本机 MCP `http://127.0.0.1:18275/mcp`。

API 源码 `fa795974d3f26987140050e1b8360987303f20e1`，镜像 `sha256:d11170144b986d2a9f4b76f8d1537976ad94d8d8b08e204b8f1226dc9cf0d45c`，标签 `market-watch-api:integration-pool-fix-20261023-fa79597`。171 个运行时源码/包配置文件 SHA256 与干净构建提交一致。包版本 1.27.0，仅表示集成基线，不是新正式发布标记。

F0：优化读取，无 schema 或持久格式迁移。仅替换 API；10 worker/Web 保留 `914525a`，Chart 保留 `b7ef7be`。其余 14 个容器 ID、镜像不变。环境值、连接池 2/overflow 0、挂载、资源、命令、网络、端口、TLS、凭据、数据库卷、受保护浏览器容器 ID/启动时间保持。15 个服务 running，API/PG healthy。未操作浏览器存储。

## 根因与修复

首次候选 `545ecef` 出现连接池 15 秒超时、普通 HTTP 500 及 MCP DEADLINE_EXCEEDED。临时恢复后最小 MCP 检查仍可失败；没有把重试成功视为修复。

只读线程栈捕获到图表请求在 `fixed_indicators.lineage → Session.get` 逐层查询父任务，另一个连接等待 `indicator_demands.guard` 的事务锁，其余图表/认证/通知请求排队等连接。数据库真实最长继承链为 **697 层**。根因是每个父节点及结果区间各查询一次，随实时追加增长，并在处理期间保留连接和可能持有的需求锁；不是仅根据池大小推断容量不足。

修复将祖先的有效继承区间放入递归 CTE，一次批量读取匹配结果块；检查点保留当前任务的索引快速路径，缺失时批量查找祖先。保持区间裁剪、继承优先级、校验和、指标数值与不可变任务身份，不增大池、不改数据。

真实数据库同一请求只读对比：697 层 / 400 根结果，SQL **830→1**，耗时 **6.2989→0.0888 秒**，全部结果和检查点相同。时间为共享主机下的一次对比，不承诺固定性能倍数；优化后的数据库往返次数由回归测试约束。

## 验证

- 修复前新增回归稳定失败：128 层链的 lineage/outputs/checkpoint 分别执行 128/129/129 条 SQL。修复后限制为最多 2 条，结果与检查点保持。
- 本地 `fa79597`：固定指标、observed 指标、前台指标展示、组合 MCP、历史指标 MCP 共 **111 passed**；Ruff、diff 检查通过。
- 实际 HTTP MCP：28 只读工具、managed/provider 兼容性、原先失败的无效参数返回、system status 通过。
- 历史版本 UUID/MWH、checksum、UTC 排他分页/同 run、负向输入、预热 null 通过。**4,984 根 H1** 对照独立 TA-Lib oracle：EMA19/RSI17 有效值和 null 全部一致，最大绝对误差 0。
- 组合修订/input_revision、MWC、默认选择、临时快照、UTC 分页与负向输入通过；EMA/RSI 有效值及真实网页图表 HTTP 的价格、指标、依赖和依据一致。
- 使用真实长父链图表并行 2 个读取 + 1 个 MCP status，36 个并发检查请求及 12 次原无效参数检查全部通过，历时 64.36 秒；图表最大 1.539 秒，MCP status 最大 1.709 秒。现有浏览器与 worker 持续运行。
- 从本次 API 启动至记录的 216 秒日志：pool timeout **0**、HTTP 500 **0**、日志 DEADLINE_EXCEEDED **0**；主动 MCP 调用亦断言无错误。这是短时验证，长期稳定性未验证。
- 数据集、12 历史版本/manifest、108 产物、工作区内容/修订、偏好前后哈希一致。SourceFetch 219→219，HistoryRun 12→12；无 seed/reset/migrate、直接 worker tick 或新增供应商下载。正常任务/心跳计数可以变化。

复用已有缓存输入，不声称本轮重新观察冷启动 pending/partial→complete；未重跑完整浏览器 UI 矩阵。旧阻断记录保留在 JSON 的 `priorBlockedAcceptance`，修复前后的私有操作证据分开保留。

## 运维与交付

证据：[mwa-acceptance.json](mwa-acceptance.json)。私有原始返回、日志与精确 API-only 回退 overlay：`/home/quant/repos/.mwa-integration-pool-fix-20261023`；不提交凭据、env、cookie 或原始数据。持久 manager 的 candidate overlay 已同步当前固定镜像。启停入口：

```bash
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py status
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py stop
```

本次未停止长期实例、回退、更新 PR、push、合并 main、打 tag 或发布生产。CI 不作为本次已完成证据；后续若提交 PR，应针对修复提交再执行检查。
