# 集成分支 mwa 更新：验收阻断

2026-10-23，按用户“将集成分支更新到 $mw-acceptance”授权，已更新现有长期验收实例 API。**部署完成，业务验收未通过**：持续连接池超时及 MCP 超出调用预算，保留现场等待异常处理决定。

## 当前实际运行

- Ubuntu `quant-server`，Compose project `mw-issue75-v2-20261018`；网页 https://192.168.7.232:18280 ，Chart https://192.168.7.232:18281 ，本机 MCP `http://127.0.0.1:18275/mcp`。
- 集成分支 `market-watch-integration-20261023`，干净构建源码 `545ecefaa794c065a0d88a96b9b07c93db5e1091`；固定 API 镜像 `sha256:e5c73b1aa22e30e93178ec71029fd7e6b5446a1119f34b99d9b37631f80944bb`，标签 `market-watch-api:integration-20261023-545ecef`。
- 418 个运行文件 SHA256 与源码一致，包版本 1.27.0。后续证据文档提交不改变本次构建源码身份；包版本不是本集成功能的正式发布标记。
- 仅替换 API；10 worker/Web 保留 `914525a`，Chart 保留 `b7ef7be`，其余 14 个容器 ID/镜像不变。15 服务 running，API/PG healthcheck healthy，但业务检查失败。
- 环境值、挂载、资源限制、命令、网络、端口、TLS、MCP/Yahoo 和数据卷不变；原保护浏览器容器 ID/启动时间保持，未操作浏览器存储。持久 manager overlay 已同步当前镜像。

## 已通过的本轮业务检查

真实 localhost HTTP MCP 检查通过：指定旧历史版本 UUID/MWH、价格/checksum/逐指标依据、UTC 排他分页与同 run、5 组错误输入和完成预热 null。4,984 根 H1 对照保留的独立 TA-Lib oracle，EMA19/RSI17 有效值及全部 null 一致，最大误差见 JSON comparisons；历史和组合价格、指标、依赖与依据与真实网页图表 HTTP 相同。组合 EMA7/RSI7 七根共 14 个有效值通过。

数据集、12 历史版本/manifest、108 周期产物、工作区内容/修订和偏好哈希前后一致。SourceFetch 219→219、HistoryRun 12→12；无 seed/reset/migrate、新增供应商下载或直接 tick。正常浏览器心跳和 worker 继续运行，需求与指标任务计数可变化，不声称所有表完全静态。

## 阻断项与定位证据

1. 首轮兼容性检查的通用行情无效类型请求返回 HTTP 500，随后独立 MCP initialize 也返回 HTTP 500。
2. API 日志持续 `QueuePool limit of size 2 overflow 0 reached`，15 秒连接超时；部分普通网页接口同时 500。
3. 一次隔离重试恢复 `INVALID_ARGUMENT`，但单次调用耗时 25.64 秒。复跑兼容性检查又在 `system_get_status` 返回 `DEADLINE_EXCEEDED`，故不能按偶发重试成功判整体通过。最近 60 秒观察到 14 次 pool timeout、4 个 HTTP 500；该窗口 MCP 3 个成功请求不能代表持续稳定。
4. PostgreSQL 只读活动采样未见长时间查询/锁等待；新旧镜像依赖相同，只有 market-watch 1.26.0→1.27.0。应用源码亦相同，尚未确认连接占用的具体根因，不将异常归因为新 MCP 功能。
5. 未改连接池配置、未额外重启、未自动回退。因阻断未继续运行额外组合协议全矩阵；先前功能分支证据不能替代本候选完整验收。

## 候选与检查状态

F0：兼容的 MCP 读取扩展，无 schema 迁移。集成分支定向 55 passed，Ruff/diff 检查通过。候选 `545ecef` 的 [CI](https://github.com/hezongyi/market-watch/actions/runs/39967132375) 记录时：Web checks=success；Backend checks=in_progress；Compose checks=success；Classify changes=success。CI 与业务验收分别记录。

完整脱敏证据：[mwa-acceptance.json](mwa-acceptance.json)。原始协议、日志与配置仅存私有目录 `/home/quant/repos/.mwa-integration-20261023`，不提交凭据、环境、cookie 或原始数据。复用缓存输入，不声称本轮重新观察到冷启动 pending/partial→complete；未重跑完整 UI 矩阵。

## 建议与运维

建议先**只回退 API**到已验收的 `2a943eec6717e25e7a5c9b5cf236c19a0f2a6b91` / `sha256:9ca7a217ecf1b12a7de53d0dfb764019191e11ffddf4eeeeb7a62151595fc67f`，保持其余服务与全部数据/浏览器现场，再隔离定位连接池占用。已准备精确 API-only `rollback-override.json` 与原 durable overlay，尚未执行。仓库 AGENTS.md 的异常检查点要求先保留证据并由用户决定下一步。

```bash
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py status
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py stop
```

仅记录启停入口，本轮未停止长期实例；异常处理不要使用旧 manager 的默认整栈回退。未合并 main、打正式 tag、发布生产或删除永久数据。
