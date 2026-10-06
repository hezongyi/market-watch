# 图表告警 v1.11.0 源码交付

2026-10-06。PR [#11](https://github.com/hezongyi/market-watch/pull/11) 新增 Advanced Charts 后台持久告警，与 v1.10.0 原生 MCP 集成；采用兼容新增功能版本 1.11.0。最终功能受测提交 `bf1e3431622322518087abf0e268305b25f08f24`，其后的提交只记录验收与发布资料。Python、web 及锁文件根包版本均为 1.11.0。

附注标签 `v1.11.0` 必须指向 PR #11 的最终 main 合并提交，保留旧标签；用 `git rev-parse 'v1.11.0^{commit}'` 获取实际发布提交。源码及构建输入的 224 项 SHA-256 见 [受测输入清单](verification/chart-alerts/release-source-inputs-20261006.json)，版本及验收镜像见 [源码发布清单](../deploy/releases/v1.11.0-source.json)。合并后逐项核对输入，不把验收镜像声称为最终合并提交的新构建。

## 审阅修复

以 main `79fb796`（v1.10.0）为固定点，按 code-review 技能进行独立 Standards / Spec 审阅；原始六项发现和复审新增一项均已解决，两轴最终无剩余合并阻断。

- 生命周期加独立 `control_revision` 与持久 `ChartAlertAction` 请求身份，旧状态操作返回冲突；已提交请求重试返回当前状态，不覆盖较新的恢复，重试 restart 只增加一个轮次。表单、侧栏与画线删除都使用相同协议。
- published 值与其自身观察时间绑定，未发布的 staging 更新不能推进 published 检查点；旧 payload 缺失观察时间按陈旧处理，等待重新发布。
- 启用前的旧缺口用于分段预热，不阻塞新有效段建立基准；启用后的缺口仍等待补齐。managed 行情身份包含日历，缺失或禁用品种阻断旧规则。
- provider 采集器不根据过期查询快照写 expired；生命周期到期仅由持锁 evaluator 写入，避免覆盖延长到期时间的并发编辑。
- 验收 API stop 超时也执行恢复；TLS 准备保留凭据，私有文件权限在 openssl 前收紧，失效或缺失证书/私钥可重建并重跑。

新增 `u22_chart_alert_actions` 位于 `t21_merge_alerts_mcp` 后，实际组合库从 t21 升级至 u22；重复升级保留数据。fresh、r19、仅告警 s20、仅 MCP s20 和缺失 control_revision 的旧 t21 路径均有验证。有规则、请求记录或多事件时，降级在修改结构前拒绝。

## 最终验证

| 验证 | 结果 |
| --- | --- |
| 完整后端 | 586 passed / 46 skipped，152.00 秒；跳过项不计通过 |
| 真实 PostgreSQL 17 | 8 passed，四条原升级路径及并发同请求 restart 只产生一个新轮次 |
| 前端及桥 | 生产 build 通过，桥 7 passed；已有大 bundle 提示保留 |
| 静态检查 | 变更 Python Ruff、diff、JS syntax/Prettier 通过；全目录 Ruff 有 5 项既有未改文件 import 顺序问题，不声称全仓无告警 |
| 新运行回归 | 实际 HTTPS API / 后台 worker / PG，published 观察绑定、旧请求冲突/重放、restart 幂等四场景通过 |
| 真实 Binance 浏览器 | 完整 8 场景通过；表单、暂停恢复、拖动按住 0 写入/释放 1 写入、斜线/对数射线、四指标、刷新/删除暂停；页面错误及图表域凭据泄露均为空 |
| HTTPS MCP | 官方 SDK 13 tools / 15 checks；合成行情数值、鉴权、并发及幂等通过 |
| MCP 与图表事件 | 27 图表事件与 1 旧事件一致；只读拒绝、写入逐事件幂等确认通过 |
| 故障恢复 | 实际停止/启动 API；缺口补齐有序 late 事件、重启待判不重复、陈旧盘中恢复三场景通过 |
| 备份恢复 | pg_dump/pg_restore，u22；62 规则、72 版本、28 事件、28 通知、7 Outbox、2 MCP 凭据、10 MCP 操作、10 生命周期请求完整一致；临时恢复库已删除 |
| 全部浏览器关闭 | 兴趣自然过期为 0；真实 Binance latest_at 和检查点从 1791270387214 增至 1791270402748，ready / count 0；无手工清除兴趣或改造时间戳 |
| 实际镜像来源 | 当前 API 的 165 项仓库输入哈希与受测提交一致；镜像 ID 记录于清单，所有组合 worker 使用同一 API 镜像 |

完整去敏记录见 [最终结果](verification/chart-alerts/review-release-results-20261006.json)。既有数值探针、通知尝试 `[1,1,2]`、IP 重建与 MCP 原生画线保存/刷新证据见 [前一轮组合验收](verification/chart-alerts/integration-acceptance-20261006.md)；其旧 t21 镜像和测试计数作为历史记录保留。真实浏览器的 ready 验证不替代历史许可 fixture 的逐根数值对照。

保留失败轮次：修复前降级保护测试失败；新增 publisher 测试初用 int 导致 Decimal fixture 错误；首轮最终浏览器刷新等待补数超时，恢复本任务历史 worker 后完整重跑通过；首次新运行脚本在 API 启动窗口遇 502，readiness 后重跑通过。真实 u22 升级先留私有 dump，旧 API 的两个本任务数据库残留连接阻塞 ALTER TABLE，核实归属后精确终止，随后升级成功。

## Ubuntu 环境和操作

主机 `quant-server`，Ubuntu 22.04.5 LTS，本机 Docker / PostgreSQL 17。独立 Compose project `mw-chart-alerts-integration`、数据库 `chart_alerts_integration`、volume `mw-chart-alerts-integration_chart-alerts-integration-pg`、独立网络；没有复用生产数据。访问地址：

- 网页 https://localhost:19543
- 图表 origin https://127.0.0.1:19544
- MCP https://localhost:19543/mcp

端口绑定 Ubuntu loopback，远程访问需转发两个端口。凭据、TLS 私钥、MCP token、dump 及许可资源位于私有或忽略目录，不提交 Git；登录文件 `/tmp/mw-chart-alerts-integration/login.json`。

在 `/home/quant/repos/market-watch-alerts` 使用已准备好的环境启动：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-chart-alerts-integration/compose.env -p mw-chart-alerts-integration -f docs/verification/chart-alerts/compose.integration.yaml --profile notification-test up -d pg migrate api market-worker history-worker managed-history-worker aggregation-worker web chart-origin tls notification-sink notification-worker'
```

停止本项目且保留数据库 volume：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-chart-alerts-integration/compose.env -p mw-chart-alerts-integration -f docs/verification/chart-alerts/compose.integration.yaml --profile notification-test down'
```

原项目 `mw-chart-alerts-acceptance` 的 19443/19444 和原数据保留，仍使用其原 Compose/私有目录。两项目此前暂停的 worker 已恢复，API healthy；组合项目全部 worker 更新至记录的最终 API 镜像。通知仅内部 sink，accepted 仅证明服务接受，没有真实通知外发。

## 发布与回退边界

本次发布源码、合并 PR 并推送附注标签，不部署生产。生产构建须以正式标签另行构建并记录镜像，迁移前备份并验证恢复。回退源码基线为 v1.10.0；已有告警/事件/请求时不能直接降级库或仅回退镜像，需评估并恢复已验证的升级前备份，同时保留升级后备份以保全新证据。没有操作 unraid 或生产实例。
