# 图表告警接续开发记录

2026-10-06。目标保持完整：按 [正式方案](advanced-charts-alert-system-plan-20261006.md) 开发并真实验收后交付。当前是后台基础实现检查点，**尚未达到交付门槛**。

## 工作区与基线

- 独立工作树 `/home/quant/repos/market-watch-alerts`，分支 `feat/advanced-chart-alerts`。
- 实施前实际 `git fetch origin`；远端主线为 `3c18f60bc4d4bae934ba3e149121660b62bbf476`，包含 v1.9.0 指标目录/计算合同。原主树的未提交文件保持原样。
- 原未跟踪正式方案已显式复制，本树更新其授权状态；原件仍在原树。
- 已读较新指标交付及行情集成记录。行情集成 `5f663e4` 仍是未完成的独立任务，未盲目合入；本实现接入当前主线 managed/provider 系列，后续新数据集 Adapter 需按最终集成状态核对。
- 适用本任务及上层 AGENTS：开发/验证/验收仅用 Ubuntu 本机独立 Compose，不操作 unraid。

## 已实施内容与证据边界

- `chart_alert_domain`：明确条件对象/单位、四类指标参数与输出、价格区间、严格比较、有限 1/2/3 次、纯观察转换、线性/对数 K 线序号几何。数学单元测试不代表已与原生图形核对一致。
- `ChartAlert` / 不可变 `ChartAlertVersion`：稳定创建请求身份、版本冲突、运行轮次、累计次数、健康状态和检查点。普通编辑/暂停恢复保留次数；明确重新启用开新轮次。
- `s20_chart_alerts`：解除旧 watch 单信号唯一约束，按事件唯一键防重；旧 watch 一次性行为仍由原状态及行锁保持。旧事件 ID、证据和通知 FK 保留；已有告警或多事件时拒绝破坏性降级。
- `chart_alert_service`：每事件独立 Signal/Notification/Outbox，与检查点、计数同事务；锁定运行行。通知重试不增加触发数。默认网页通知；未选择 ntfy 不创建外发任务。迟到事件默认仅记录。
- `chart_alert_worker`：无浏览器数据库监控，固定指标计算起点；临时最后一根 K 线从确认历史重新计算；不从 OHLC 重建盘中路径。缺口等待补齐；已判历史修订目前停止判定并显示需核对，尚无自动安全重建入口。
- `provider_service`：活跃告警并入原实时采集分组、预算与来源轮询；独立于会话过期。当前活跃/暂停版本保护缓存。Ubuntu 实例运行证据尚缺，当前仅由隔离数据库测试证明代码行为。
- `/api/chart-alerts`：认证/CSRF、创建幂等、条件编辑、生命周期、筛选、事件日志。现有 `/api/signals` 同样读取新增事件。指标通知和旧日志页面分开展示指标值/市场价格，修正网页声音开关和迟到投递状态。

## 当前验证

实际运行主机为 **quant-server / Ubuntu 22.04.5 LTS**；独立 `.venv`，Python 3.11。没有产品服务运行地址。

- 一次完整后端回归：**521 passed、38 skipped**，163.74 秒；其中跳过环境相关测试。该轮在最后通知时间戳/消息展示调整及新增 PostgreSQL测试前完成，不能当作最终交付的全量验收。
- 末轮定向回归（本任务所有测试 + 原 service/notify/provider_service）：**79 passed、2 skipped**；两个跳过为尚无隔离 PostgreSQL的真实迁移/并发用例。
- 前端 `npm ci` 与 `npm run build`：通过；保留既有 bundle >500kB 提示。
- 变更 Python Ruff、`git diff --check`、Compose 静态解析：通过。Alembic 单头为 `s20_chart_alerts`。
- SQLite 已验证有旧事件/通知的迁移升降及已有数据降级保护。不能据此声称 PostgreSQL升级/备份恢复成功。
- ntfy 验证使用进程内 `httpx.MockTransport`，包含失败后重试及指标单位；没有向真实服务发送通知。

## 环境阻碍与隔离验收准备

本机 `/var/run/docker.sock` 的 Unix 读写访问检查为 False，实际连接返回 PermissionError 13；`docker info` 与 `docker compose ls` 均 permission denied。当前执行策略禁止提权，已请求用户配置本机 Docker 访问。没有转到 unraid，没有启动容器。

预备 [Compose](verification/chart-alerts/compose.yaml) 项目 `mw-chart-alerts-acceptance`，独立默认网络、`chart-alerts-pg` volume、数据库 `chart_alerts_acceptance`。预定网页 `https://localhost:19443`、图表独立域 `https://localhost:19444`；端口检查当时空闲，**地址尚未运行**。默认关闭外发，仅启动 Binance 品种的 managed worker；不读取或复制生产 env。

已运行 `scripts/prepare_chart_alert_acceptance.py`，在 `/tmp/mw-chart-alerts-acceptance` 生成任务独立凭据、登录文件和 TLS 私钥（权限 0600，目录 0700）；不提交 Git。重复使用配置，不能重置已部署实例的密码。

权限就绪且功能准备就绪后的命令（均尚未运行）在本 worktree 执行：

```bash
.venv/bin/python scripts/install-advanced-library.py /home/quant/repos/research/TV_v31.1.0_0430.zip
docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml build migrate web chart-origin
docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml up -d pg migrate api market-worker history-worker web chart-origin tls
docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml build verify
docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml run --rm verify
```

停止只针对本项目，保留 volume：

```bash
docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml down
```

不执行全局 prune。许可库安装仅到被忽略目录，安装时核对 manifest；完整许可资源不入库。Dockerfile.verify 从本任务实际 API 镜像派生，PostgreSQL测试使用随机命名的任务拥有 schema，只清理其自身 schema。

## 剩余门槛（不能据当前检查点标记完成）

| 正式验收项 | 当前直接证据 | 尚需证据/实施 |
| --- | --- | --- |
| 单次/2 次/3 次、持续成立、边界往返 | 纯判定/事务测试 | 产品表单、运行 API 与完整实例核对 |
| 创建/编辑已成立不触发 | 判定/worker、版本测试 | 图表创建及编辑交互实测 |
| 并发/重启、计数/Outbox一致 | 回滚/新会话测试；PostgreSQL用例待运行 | 真实 PostgreSQL锁并发、容器重启、备份恢复与旧库升级 |
| 关闭网页后继续采集 | 无会话provider需求测试 | 运行实例关闭全部网页后持续采集及判定 |
| 数据中断/闭市/补数/修订 | BTC缺口补数、迟到和修订停判测试 | 来源完整性、正常闭市、修订恢复入口、真实故障注入 |
| 画线提交/失败/超时/连续拖动 | 版本冲突及明确删除服务测试 | 公共桥接口、业务对象关联、提交核对/重试、旧版事件及原生图形验证 |
| 多图、切图、布局恢复 | 尚无产品新增证据 | 固定上下文/代次、刷新关联恢复、切换不误暂停、复制不复制活跃告警 |
| 趋势线/射线与图上一致 | K线序号/对数数学、已存在端点映射代码 | 原生真实几何核对、未来端点、周末/缺口、周期变化；不得缩减为仅水平线 |
| SMA/EMA/RSI/MACD收盘/盘中 | 独立数值向量、临时/缺口/零值测试 | 固定历史合同在图表Adapter中对齐，逐根及临时真实图表数值核对 |
| 行情身份与能力矩阵 | 写入来源校验、provider dataset身份 | 明确能力查询及UI；Yahoo日历目前阻止判定，不能标成已支持；OANDA账户变化 fencing需核对 |
| 表单/消息通知子页/侧栏日志 | API及旧日志兼容调整 | 新表单、工具栏/价格/对象入口、筛选/复制/编辑/定位/证据、暗亮主题和键盘验收 |
| 每事件确认/通知真实状态/单位 | 本地模拟投递及已有确认测试 | 隔离通知通道端到端、设备与服务接受状态区分；真实外发未授权 |
| 旧规则/事件兼容 | 原 service/notify定向及一次全量回归 | 最终全量回归、实际 PostgreSQL旧记录迁移、产品回归 |

下一阶段从上述产品入口、上下文与指标/几何探针继续；Docker权限阻碍不取消总范围。正式交付仍需满足完整合同、最终 review和实际运行验收。当前目标保持 active。
