# 来源身份与多源固定 M1 基础验证

日期：2026-10-06。范围：三层方案阶段 A 的来源关联及阶段 B 的多源固定 M1/共享内容基础。
不代表完整阶段 A/B、数据中心、组合行情、策略接线或整体三层产品已经完成。

## 实现与契约

- 采集身份独立于日界身份，已知旧通道显式关联，未知旧系列保持原语义。
- 管理能力/关联读取无注册、组合创建或实时需求副作用。
- Dukascopy 与 OANDA Practice 共享固定 M1 历史接口；OANDA 每次请求最多 4000 分钟。
- 来源 M1 内容按来源身份与内容校验和去重，版本保存独立分区、观测时间和引用；改日界复用原始内容。
- 共享请求有独立租约，网络期间不持有数据库事务；过期拥有者不能提交。
- 新版本可重新查来源修订，旧历史版本/回测输入不变。新分块引用共享内容，旧内嵌分块仍可读取。
- y26/z27 为增量迁移，不改写旧身份、原内嵌内容或 manifest；新增能力仍需后续维护与发布接线。

## 验证结果

| 检查 | 实际结果与范围 |
| --- | --- |
| 本地全量后端回归 | 784 passed，67 skipped，241.55 秒；未运行的 PG 场景不能用此结果宣称通过 |
| Ubuntu 独立 PG 定向回归 | 19 passed，22.16 秒；来源关联、并发共享、租约替换、内容保护、旧内嵌迁移、原身份/日界/来源会话与历史派生兼容 |
| 真实 PG 全链迁移 | `alembic upgrade head` 成功；`alembic current` 为 `z27_source_m1_store (head)` |
| 改动文件 Ruff | 通过 |

首次运行本地 pytest 未设 PYTHONPATH，加载失败，设置为 backend 后执行上述有效回归。
首次扩展 PG 回归为 12 passed/1 failed：旧 s20 fixture 重建后缺少 x25 asset_class。
测试现在先确认旧 schema，再执行 x25 和来源表升级后使用当前 writer；复验的 19 项全部通过。
没有为这批后端基础运行前端或三层整体浏览器验收。

本地全量原始日志位于 ignored `artifacts/data-integration/three-layer-local-regression.log`。
测试文件为 `backend/tests/test_source_registry*.py`、`test_history_sources.py`、
`test_source_history_store*.py` 以及既有历史/迁移/聚合回归。

## 实际环境与启停

主机：Ubuntu 本机 Docker。Compose project：`market-watch-three-layer`。
Compose 文件：`docs/verification/three-layer/compose.yaml`；独立网络和数据库 volume。
本阶段仅启动独立 PostgreSQL 和临时 verify 容器，未部署新 API/UI。
数据库在项目网络内 `postgres:5432/three_layer`，未发布宿主端口；当前没有新浏览器访问地址。
verify 使用已有后端依赖镜像、只读挂载当前工作树代码，不更新旧观察服务。

独立密码文件：ignored `artifacts/data-integration/three-layer-compose.env`，不提交、不打印。

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml up -d postgres'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml run --rm verify python -m pytest backend/tests/test_source_registry_postgres.py backend/tests/test_source_history_store_postgres.py backend/tests/test_market_datasets_postgres.py backend/tests/test_aggregation_policy_postgres.py backend/tests/test_source_history_postgres.py -q -p no:cacheprovider'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml run --rm verify alembic upgrade head'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml stop postgres'
```

测试用唯一 schema，在结束时仅清理其自有 schema。旧 project `market-watch-data-integration`
与两个后台观察 service 未停止/重启，旧观察不能证明这批新代码的长时质量。
根盘最近快照约剩 15G，不作为后续整体验收容量承诺。

## 未完成范围

仍需完成日更/重叠复查/补数与恢复任务、各周期不可变产物、数据中心 UI、组合定义和固定接续、
共享需求、策略就绪及防重、Dukascopy 原生路径，以及方案逐项真实环境验收。
现有共享缓存以规范化来源和请求分区复用；不同请求分区的进一步重用由维护/版本复用层完成。
来源 blob 的物理回收和数据库级引用保护需结合后续引用/删除工作一起验收。
