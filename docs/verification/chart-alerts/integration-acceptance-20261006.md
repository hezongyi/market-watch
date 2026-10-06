# 图表告警与原生 MCP 集成验收

2026-10-06。PR #11 在 `feat/advanced-chart-alerts` 上合入 main `79fb796`（v1.10.0 / PR #10），合并提交 `bbfc409`，审查修复提交 `ab1b702`。保留告警与 MCP 的图表资源、共享行情计算、信号读取和代理路由；原告警验收实例继续保留，本文记录新的组合实例。原验收与数值探针证据见 [历史实例记录](runtime-acceptance-20261006.md)。

## 环境及操作

实际主机 quant-server，Ubuntu 22.04.5 LTS，本机 Docker。Compose project `mw-chart-alerts-integration`，数据库/用户 `chart_alerts_integration`，独立 volume `mw-chart-alerts-integration_chart-alerts-integration-pg`，独立默认网络及 internal 通知网络；没有复用原实例或生产数据。

- 网页 **https://localhost:19543**；图表 origin **https://127.0.0.1:19544**；MCP **https://localhost:19543/mcp**。
- 两个端口均绑定 Ubuntu loopback；远程访问需转发两个端口到这台 Ubuntu。使用本任务自签名证书。
- 私密配置、登录文件、TLS 私钥、MCP token、截图与数据库 dump 位于 `/tmp/mw-chart-alerts-integration`，不提交 Git。登录文件 `login.json`；证书 `cert.pem`，MCP CA 副本 `ca.pem`。
- 原实例仍为 `mw-chart-alerts-acceptance`，网页 19443、图表 19444，数据库及 volume 保留。
- PostgreSQL 17，镜像 `public.ecr.aws/docker/library/postgres:17-alpine`。API 最终验收镜像 ID `sha256:28a14ed068dc0648c154d1121c49c3d3bf127e12575cf244898ae33f6d188898`。

在 `/home/quant/repos/market-watch-alerts` 启动已经配置的实例：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-chart-alerts-integration/compose.env -p mw-chart-alerts-integration -f docs/verification/chart-alerts/compose.integration.yaml --profile notification-test up -d pg migrate api market-worker history-worker managed-history-worker aggregation-worker web chart-origin tls notification-sink notification-worker'
```

只停止本项目，保留数据库 volume：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-chart-alerts-integration/compose.env -p mw-chart-alerts-integration -f docs/verification/chart-alerts/compose.integration.yaml --profile notification-test down'
```

新建环境时先以 `MW_ALERT_ACCEPTANCE_PROJECT=mw-chart-alerts-integration` 运行准备脚本，安装合法许可资源到忽略目录，再构建 `migrate web chart-origin`；不要重新生成正在运行实例的凭据。原实例的操作仍用其原 Compose 和私有目录。

## 迁移与组合回归

`t21_merge_alerts_mcp` 汇合 `(s20_chart_alerts, s20_agent_capabilities)`，Alembic 只有一个 head。升级本身不改业务数据；有图表告警或多次事件时，降级在拆分迁移头之前拒绝，避免 SQLite 部分执行后留下错误结构。

| 验证 | 结果与范围 |
| --- | --- |
| SQLite 完整迁移链 | fresh、r19、仅告警 s20、仅 MCP s20 四条路径汇合；分支已有数据保留；重复升级不改数据 |
| 真实 PostgreSQL | 7 项通过，含四条汇合路径，以及原迁移、行锁并发和事件/Outbox 一致性 |
| 完整后端 | 575 passed / 45 skipped，209.21 秒；环境相关跳过不计为通过，真实 PG 项另行执行 |
| 前端与桥 | npm ci / 生产 build 通过；桥回归 7 项通过；已有大 bundle 提示保留 |
| 静态检查 | Ruff、JS syntax、告警浏览器 Prettier、Compose 解析、Nginx 配置和 diff 检查通过 |
| 告警 API/worker | 专属合成数据 5 场景通过；实际通知尝试次数 `[1,1,2]`，逐事件确认互不影响 |
| 最终 API 告警浏览器 | 真实 Binance / 原生图表 8 场景通过：工具栏表单、暂停恢复/复制草稿、几何更新、真实鼠标按住 0 写入/释放 1 写入、线性趋势线/未来反向对数射线、四指标快照 ready、刷新及删除暂停；errors 和图表域凭据泄露均为空 |
| 最终 API MCP HTTPS | 真实 SDK / 13 tools / 15 checks 通过；鉴权、行情/指标/版本一致、创建并发及幂等冲突、确认和取消；行情输入为合成 fixture |
| 原生画线与 MCP | 真实图表创建、PostgreSQL 保存、MCP 投影一致；未保存编辑不可见，后续保存可见，刷新保留对象身份；数据输入为合成 fixture |
| 图表事件与 MCP | 20 个图表事件及 1 个旧事件与浏览器返回相同；只读 token 拒绝确认且记录不变；可写 token 幂等确认一个事件，不改变其他事件或次数/轮次/版本 |
| 全部浏览器关闭 | 兴趣自然过期为 0；真实 Binance latest_at 从 1791265546976 增至 1791265562805，checkpoint 从 1791265531268 增至 1791265546976，缓存从 4803 增至 4804；连续零兴趣期间 ready、count 0 |
| 故障与待判重启 | 实际 API 停止/启动，专属合成数据验证缺口冻结、补数产生两条有序 late 事件、重启待判仅增加第三条事件；陈旧盘中恢复新鲜后 ready 且不误触发 |
| API IP 改变 | 真实重建改变 IP，web 不重启；35.62 秒恢复 HTTPS 登录；40 条规则及 24 个事件连同版本/通知/Outbox 保持一致，运行检查点允许继续推进 |
| PostgreSQL 备份恢复 | 实际 pg_dump/pg_restore，joined head t21；40 规则、46 版本、24 事件、24 通知、7 Outbox、2 MCP 凭据、7 幂等操作的完整载荷相等；随机恢复 DB 已删除 |

原始运行日志留私有目录，去敏结果见 [组合摘要](integration-results-20261006.json)。本文的真实行情浏览器验证接入和快照；四指标逐根数值对照仍引用历史许可 fixture，不把 ready 状态当成逐根数值证明。

## 双轴审查及修复

按 code-review 技能在合入 main 的 `bbfc409` 上审查集成改动，Standards 和 Spec 分别进行。

### Standards

无新增 AGENTS 硬违规。两项可靠性发现已修：浏览器 APP/CHART/私有目录必须匹配已命名本机实例，读取凭据前验证；IP 占位容器按精确名称/project label 核查清理，网络恢复独立尝试并汇总异常。另将 MCP 浏览器登录/初始化也纳入 finally 清理，防止登录失败遗留 Chromium。

### Spec

两项 P1 集成缺陷已修并加入回归：MCP 默认完整 K 线，显式 `provisional=true` 才计算最后未收盘根，返回临时标记；MCP 接受并回传 `calculation_origin`，补入较早 provider 历史后仍保持与图表相同的递归起点。浏览器保留原盘中默认；缓存键包含临时计算开关。另修正 MCP 信号模型允许图表事件无 legacy watch ID，返回 `chart_alert_id`，验证独立确认及旧策略兼容。

两轴各 2 项发现均已解决；不把启发式可靠性建议作为 AGENTS 违规。

## 证据边界

故障、通知次数及备份数据来自本任务合成 fixture；通知只投递内部 sink，accepted 仅证明服务接受。没有真实通知外发，没有操作 unraid、生产发布或合并 PR。

Ubuntu 本次内存和 swap 压力较高，浏览器串行执行；曾临时停止两个本任务项目的部分 worker，现已恢复；组合项目的所有 worker 更新至最终验收 API 镜像，两个项目均实际运行且 API healthy，未操作其他任务资源。首次 MCP 浏览器在 API 启动窗口登录遇 502，加入 readiness 等待后重跑通过。验收产物不包含许可库、密码、token、私钥或数据库原始载荷。

首次 zero-browser 观察与最终浏览器复验重叠，浏览器重新续期兴趣，使 900 秒观察预算在 TTL 自然过期之前耗尽；该轮未生成成功产物。最终浏览器关闭后重新运行观察，不手工清除兴趣、不修改行情时间戳。
