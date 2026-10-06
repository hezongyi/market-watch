# 图表告警：Ubuntu 实例验收

2026-10-06。隔离实施树 `/home/quant/repos/market-watch-alerts`，分支 `feat/advanced-chart-alerts`，集成基线 `3c18f60`。按 [正式方案](../../advanced-charts-alert-system-plan-20261006.md) 实施；本记录说明真实运行证据及其边界，不表示生产发布。

## 实际环境与访问

实际运行主机 **quant-server，Ubuntu 22.04.5 LTS**。本机 Docker Compose project `mw-chart-alerts-acceptance`，独立数据库 `chart_alerts_acceptance`、volume `mw-chart-alerts-acceptance_chart-alerts-pg`、默认网络及 internal 通知网络。没有连接 unraid 或生产数据库。

- 网页与登录：**https://localhost:19443**，绑定 Ubuntu 主机 loopback。
- 许可图表静态 origin：**https://127.0.0.1:19444**；与登录主机名分离，浏览器验证未向它发送 cookie 或 Authorization。
- 本机自签名证书，首次访问需信任该任务证书。远程访问须分别转发 19443、19444 至这台 Ubuntu 主机，仍使用以上两个地址。
- 私有配置、登录密码及 TLS 私钥：`/tmp/mw-chart-alerts-acceptance`（目录0700、配置0600）；读取 `login.json` 登录，不把密码写入文档。配置不是仓库内容，重启主机前需自行保留；准备脚本保留已有凭据，只刷新代理配置。
- 实际服务：pg、api、market-worker（BTCUSDT）、history-worker、managed-history-worker、aggregation-worker、web、chart-origin、tls；隔离 notification-test profile 的 sink/worker 同时运行。
- PostgreSQL **17.11**，官方 ECR镜像 `public.ecr.aws/docker/library/postgres:17-alpine`，验收拉取 digest `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`。Docker Hub当时网络失败，通过官方镜像来源取得17版本。

Ubuntu 用户的 docker 组已在系统组数据库配置，旧登录会话组未刷新；以下命令使用 `sg docker -c`。

## 启动、停止及复验

在实施树执行。已配置实例直接启动，不重新生成密码：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml up -d pg migrate api market-worker history-worker managed-history-worker aggregation-worker web chart-origin tls'
```

首次构建先执行 `scripts/prepare_chart_alert_acceptance.py`，再用 `scripts/install-advanced-library.py` 安装本地合法许可包至忽略目录；接着运行同一Compose的 `build migrate web chart-origin`。许可资源不入库。

隔离通知投递只发送至项目内部sink，无宿主端口、不转发，worker固定该地址且清空ntfy token：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml --profile notification-test up -d notification-sink notification-worker'
```

停止仅本项目，保留数据库volume：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml --profile notification-test down'
```

复验真实PostgreSQL迁移与并发：同一Compose `build verify` 后 `run --rm verify`。五个Python实例脚本位于 `scripts/chart_alert_*acceptance.py`；使用 `PYTHONPATH=backend .venv/bin/python scripts/<脚本名> --database-host <本项目pg的实际bridge IP>`。IP通过精确 `docker inspect mw-chart-alerts-acceptance-pg-1` 核对，不能固定依赖历史IP。

- runtime脚本仅生成随机 `ALERTFIX_*` 数据，用真实HTTP管理与容器worker判定；通知重试复验前仅重建本项目sink，重新启用首次503，不读出完整sink records（含通知确认token）。
- fault脚本仅生成 `ALERTFAULT_*` 数据，短暂停止/启动本项目api；为模拟已有运行明确移动生成规则的epoch，不修改其他规则。
- restart脚本 `--force-ip-change` 将旧IP短暂保留在标记归属的容器，重建api后删除该临时容器；不重启web。
- backup脚本运行前停止本项目api及notification-worker，运行后用同一Compose start恢复；pg_dump仅保存在私有目录，新随机恢复DB比对后删除。
- no-browser脚本要求全部页面关闭，等待兴趣自然TTL过期再测；不制造行情时间戳，连续零兴趣期间核对真实行情与checkpoint推进。

真实浏览器脚本，无HTTP route mocks：

```bash
LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome node web/tests/chart-alerts-runtime.browser.cjs
```

浏览器及共享库路径为当前Ubuntu已安装工具；其他主机按本机安装调整。脚本通过登录创建任务workspace/告警，成功与失败截图都留私有目录；不提交浏览器状态。

## 验收合同与证据

| 正式验收项 | 结果与直接证据 |
| --- | --- |
| 单次/2/3次、持续成立、等号与同根往返 | 运行API/自主worker/真实PG，合成观察输入，精确累计及完成状态通过；双向边界另有纯判定回归 |
| 价格区间跳空 | 运行worker只计实际进入，不推测未观测路径，通过 |
| 创建/编辑及版本 | 真实父页/API保存快照，创建已满足只基准；原生修改产生新版本，版本事务回归覆盖编辑基准、冲突、旧版本事件 |
| 并发一致性与迁移 | 独立PG三项通过：行锁并发、一致事件/Outbox、简化旧数据迁移及完整Alembic旧队列链升级；旧ID/证据/通知FK保留 |
| 重启 | api真实重建、IP确实改变；web不重启，HTTPS登录自动恢复，规则版本/轮次/次数/状态及不可变事件/通知/Outbox相同；运行checkpoint继续推进，不要求冻结 |
| 重启期间待判数据 | fault合成输入：既有两事件，停止api写入待判bar，启动后只增加第三个，未重复、未跳过 |
| 关闭网页继续采集 | 所有浏览器兴趣自然过期至零；真实Binance `latest_at` 与告警checkpoint从1791259512523推进至1791259527659，health ready、count0 |
| 缺口、补数、陈旧、修订 | 运行worker缺口阻止checkpoint推进，补齐后两次事件均late；盘中180秒旧样本stale，新鲜样本恢复无误触发；EMA历史修订blocked，明确rebaseline保留次数/轮次、不重发 |
| 正常闭市 | worker日历回归区分周末闭市与交易时段陈旧；此项使用固定历史时间，未伪称当前真实闭市 |
| native交互与生命周期 | 实际部署浏览器验证工具栏表单、消息、暂停恢复、复制草稿、真实画线保存/修改、刷新恢复、明确删除暂停；native许可fixture另覆盖真实鼠标/undo/redo、多图、切品种周期、布局 |
| 拖动失败/超时/连续/旧版 | Adapter公开边界7项验证串行版本、超时读回已提交、失败重试/恢复及代次隔离；后台事务回归验证旧版本事件身份。故障流程使用可控fixture；不是对真实外部网络随机故障的宣称 |
| 斜线几何 | 部署浏览器保存线性趋势线、未来端点反向对数射线，经真实geometry endpoint取得20实际/未来bar索引并自主判定ready；真实许可fixture验证周末56小时=8根bar及对数中点200，几何回归验证500未来槽与范围方向 |
| 指标 | 部署浏览器从四个native study创建参数/固定history快照，在真实Binance数据上ready；许可fixture四指标各463根study输出与后台逐值完全一致，含临时最后根；gap、真实零、修订有算法回归 |
| 通知 | 内部sink首次503，实际Outbox重试后accepted；逐事件确认不影响其他事件及次数。只证明服务接受，未证明手机接收/响铃，也未发送真实通知 |
| 旧策略兼容 | 完整旧迁移链及旧service/notify/domain策略回归通过；完整回归包含已有回落突破与前日高低点。生产数据未参与 |
| 备份恢复 | 实际PG17 pg_dump/restore，随机恢复DB的全部规则、版本、checkpoint、事件证据、通知和Outbox字段相等，s20；已删除该恢复DB，dump0600不入库 |

## 本轮真实部署发现及修复

1. 图表镜像忽略规则漏带 `chart-alerts.js`，已添加白名单并实际重建。
2. 验收Compose缺managed history/aggregation workers，已补并启动。
3. api容器IP变化后Nginx静态解析旧地址导致502；web及任务TLS代理采用Docker DNS动态解析upstream。实际IP变化后自动恢复HTTPS登录通过。
4. 反向射线当前报价在有效范围外时，曾错误提示指标预热。新增回归先失败后通过，现在显示“当前观察值不在画线有效范围内”。射线保留原方向，不人为扩展条件。

## 结果边界与产物

完整后端回归 **548 passed、41 skipped，130.55秒**；其中环境相关跳过仍有，独立PG三项另行真实执行通过。前端生产build及此前native/UI探针通过；本轮Ruff、Prettier、Compose解析、nginx -t及diff检查通过。

这里组合使用运行实例端到端、真实许可库可控fixture及纯算法/事务回归。真实行情场景没有等待自然市场穿越产生全部次数，而是用专属合成输入确定验证边界；未将不同证据层混称。四指标在真实部署上验证接入及快照，逐根数值对照来自许可fixture，不宣称已对每个真实provider做全量数值验收。仅开放能力校验允许的来源/日历组合，未知日历或不支持价格轴阻止写入；OANDA账户fencing为回归证据，未使用真实OANDA凭据。

原始去敏前记录、截图、dump位于 `/tmp/mw-chart-alerts-acceptance`，仓库只保存 [去敏结果摘要](probe-results-20261006.json)。实例数据库保留本任务生成的验收workspace/规则；均非生产。开发交付不包含生产发布、合并主线或真实通知外发。
