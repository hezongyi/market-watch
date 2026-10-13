# 稀疏日线告警与时段状态修复验收

日期：2026-10-13，新加坡时间。分支 `fix/sparse-oanda-composite-alerts`。
实际运行主机为 Ubuntu 本机；Unraid 仅做此前根因只读调查，未发布本次修复。

## 结果

原实现的最小回归稳定失败：新鲜报价、已确认来源分钟但稀疏 D1，告警返回 `stale`。
修复后先返回 `coverage_pending` / 当前报价正常；后台同账户原生 D1 四项价格匹配后，
规则建立基准并恢复正常判定，下一日的新穿越只触发一次。
原始 M1、固定日线覆盖、成交量、历史判断证据均未改写。

| 验证 | 结果 |
| --- | --- |
| 最终合并回归组 | 190 passed（66.91s）；以下 SQLite/API 合同均在 Ubuntu Docker 一次合并执行通过 |
| 新增稀疏 D1 回归 | 17 passed；包含错误账户、错误周期/品种、未完成/空响应、价格不一致、暂停/到期停止需求、M1 修订恢复基准、旧租约、23/25 小时 DST 日界线、旧柱不被持续视为新鲜 |
| 组合告警与报价 | 原有合同及新回归通过；组合告警 18 项通过，报价合同 17 项通过 |
| 流采集、REST adapter、原生历史、聚合与 ATR 偏移 | 134 passed |
| PostgreSQL 全组 | 28 passed；含新增证据合同与原有告警并发/回滚 |
| 最终 PostgreSQL 证据组 | 10 passed；确认只抢占一次、旧租约拒绝提交、HTTP 调用期间数据库锁可由另一连接立即取得 |
| 生产捕获输入回放 | 1425 条原始输入仍为 15 个未知分钟；同账户完整 D1 四项价格一致；实际生产 D1 价格规则符合认证条件 |
| 前端最小原始复现 | `scheduled_open / calendar_verified=true` 从错误文案变为“已核实交易时段”；原始断言现在通过 |
| 前端状态合同 | 已核实开市、闭市、未知及未核实开市分别展示；覆盖待核实与 stale 分开 |
| 构建及代码检查 | Ubuntu 专用 BuildKit 构建 API/Web 通过，TypeScript/Vite/native bundle 通过，变更文件 Ruff 与 whitespace 检查通过 |
| 已构建页面浏览器验证 | 真实 Ubuntu Web 镜像的 `data-center-native.js` 挂载，回放捕获的状态字段；1440px/390px 均正确，无 pageerror |

浏览器只对来源状态 GET 回放捕获字段，登录针对独立开发 API；宿主夹具不包含商业图表库。
这是已构建组件的回放验证，不宣称生产页面已修复，也不宣称全部商业图表流程已验收。

证据：[生产回放](production-replay.json)、[浏览器结果](source-session-browser.json)、
[手机宽度截图](source-session-mobile.png)、[最终回归输出](regression-final.txt)。
后台请求共享并使用一分钟失败重试间隔；已有原生证据只有与当前固定输入 OHLC
再次核对一致时才可使用。缺口不会被视为闭市或伪造分钟柱。
本次支持 D1 收盘价格/常量/水平线规则；指标、ATR、斜线和盘中路径仍执行原有依赖要求。
无需新数据库迁移；复用独立 source identity、fenced fetch 及不可变 content blob。

## 本机实例

Compose project / task：`mw-sparse-alerts-20261013`。
独立网络、PostgreSQL volume 与端口；不使用其他任务的实例。

- Web：<http://127.0.0.1:20282>。
- API readiness：<http://127.0.0.1:20281/readyz>。
- PostgreSQL：本机 `127.0.0.1:20283`；凭据仅保存在本机私有目录。
- API、Web、PostgreSQL、native-history worker 启动正常，API/PG healthy。
- 镜像：`market-watch-api:sparse-alerts-20261013`、`market-watch-web:sparse-alerts-20261013`。

启动：

```bash
sg docker -c 'docker compose --project-directory /tmp/mw-sparse-alerts-20261013 -p mw-sparse-alerts-20261013 -f /tmp/mw-sparse-alerts-20261013/compose.yaml up -d --no-build'
```

停止（保留验收数据库）：

```bash
sg docker -c 'docker compose --project-directory /tmp/mw-sparse-alerts-20261013 -p mw-sparse-alerts-20261013 -f /tmp/mw-sparse-alerts-20261013/compose.yaml stop'
```

实例暂保留用于审阅，任务未标记结束；退役时按 `deploy/ubuntu/README.md`
执行精确归属检查、数据库归档和实际恢复校验。私有 env、开发登录及浏览器失败调试文件
位于 `/tmp/mw-sparse-alerts-20261013`（0700），不提交。
