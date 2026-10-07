# 自建历史维护写 MCP 阶段验证

日期：2026-10-07（Asia/Singapore），分支 `feat/market-data-integration`，前置提交 `cd6b386`。
此阶段交付维护写操作，不等于完整三层或长期质量验收通过。

## 行为

八个写工具覆盖创建、配置、暂停/恢复/归档、任务提交/控制、改日界、周期准备和物理回收。
浏览器与 MCP 共用调用者拥有事务的命令；命令只改变状态或排队，不进行供应商 I/O、创建实时需求。
需要独立 `market:read` + `market:write`，旧只读/告警凭据不扩权。
同 agent、工具、key 在续期凭据之间仍幂等；不同意图拒绝，内部任务编号采用结构化命名空间，
避免分隔符构造造成代理间别名。业务、成功审计、输出校验和幂等记录同事务提交。
失败注册撤销来源/品种/数据集/维护/任务；不能只回滚幂等记录而留下业务副作用。

改日界产生独立数据集/版本，复用原始 M1，不替换旧回测或组合基线。
原始 M1 发布与周期产物发布分开；未发布周期不可读取。
回收复用锁内检查，要求暂停+归档+无业务引用及活动任务；共享分块与来源缓存保留。

## 验证结果

- 全量后端 **968 passed /186 skipped /259.92s**，`history-writes-full.log`。
  最后命名空间修正另由下述定向测试及最终实际环境调用覆盖；跳过不算通过。
- HTTP抽取/维护/数据中心/回收/旧MCP **50 passed /35.94s**，`history-writes-refactor.log`。
  扩展维护测试最初 **2 passed /1 failed**：测试误将直接版本报告当作含 `task` 的对象；
  核对浏览器合同后修正，**3 passed /5.94s**，`history-writes-mcp-expanded.log`。
- 最后本地维护/旧MCP/数据中心 **45 passed /49.23s**，`history-writes-final-local.log`。
- 真实 Ubuntu PostgreSQL 初轮 **4 passed /12.35s**，`history-writes-pg.log`；
  最后维护MCP/维护生命周期/回收 **22 passed /52.78s**，`history-writes-final-pg.log`。
  每项独立schema，禁止 API lifespan 引发共享实例 bootstrap 或供应商线程。
  覆盖四凭据八次并发只注册一个数据集/任务、部分写入失败完整回滚、权限、
  不同意图冲突、原始M1派生和保存引用/回收竞争。
- 实际 HTTP/MCP 八工具发现、写入和原key重试均通过，`history-writes-mcp-real.json`。
  OANDA Practice AUDUSD 新建NY17数据集，固定两小时区间取得 **108根来源M1**；
  未观察分钟仍未知，不当作全区间完整。原始版本
  `b2617349-2ab4-4f49-95a3-74fd1b96769a` 保留；无实时租约由此产生。
  UTC派生 `c882b7a3-0336-4c22-97eb-029214d7e5ed` 与原始M1价格一致，M1/H4独立发布。
  原版本因派生引用回收受阻，UTC版本因本次保存工作区回收受阻；删除准确测试工作区后，
  仅本次无引用UTC派生价格回收成功，原版仍可读且价格不变。原计划保留暂停状态、解除归档。
- 实际脚本最初在周期待发布时读取收到422；修正为显式等待周期。
  删除测试工作区漏传revision也收到422；核对准确ID/名称/绑定后清理该测试工作区，
  修正为乐观版本删除，重新验证通过。失败原日志保留在 `history-writes-mcp-real.log`。
- 最后命名空间修正重启API后，真实有限复查提交/重试、未发布周期拒绝、任务取消通过；
  该取消版本 `649e0083-f325-4d73-9e0a-ae432db230ce` 以 ignored JSON 的实际记录为准。
  Ruff与 `git diff --check` 通过；本阶段未改前端代码。

## 实际环境与启停

Ubuntu本机隔离 Compose project `market-watch-three-layer`，PG14，既有迁移aj37不变。
API、history-worker、pricing-worker、web、chart-origin和PG运行；16629 `/readyz` 实际就绪。
管理/图表 `http://127.0.0.1:16629`，许可origin `http://127.0.0.1:16630`。
外部delivery禁用，测试预警仍暂停，无订单或消息发送。凭据及验收产物均在忽略目录。
短暂停止本项目history-worker以验证任务控制后已恢复；旧观察、其他项目及生产未改。

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml start api history-worker web chart-origin'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime up -d --no-deps pricing-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop api history-worker pricing-worker web chart-origin'
```

实际验证脚本 `scripts/verify_history_writes_mcp.py` 分queue/verify两步；已有实例不得重复queue创建新任务。
verify最终回收测试派生版本，结束后重跑需重新建立明确测试输入，不能将已回收版本当待验收数据。

## 剩余交付

原生Dukascopy、回测统一固定周期产物、其余策略/搜索入口、真实Dukascopy→OANDA、
多品种/维护并发、完整桌面兼容及长期质量继续。空间约4.7GB/97%。
不推送/PR、不改生产，MT4后续；实现与质量验收分开，完整目标保持未完成。
