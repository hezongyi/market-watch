# RRS原生稀疏历史修复

修复已通过本地162项相关回归，已按用户授权更新mwa API；用户随后要求“直接收口了”。本轮按修复与部署完成交付，真实图表验收因OANDA连接失败未完成，不记为通过。本次为独立补丁，风险F0，无schema、持久格式或worker链路变化；本次执行结果以summary.json和本文末尾Docker记录为准。

## 根因与修复

此前b4e1326a已修复平台RRS按实际观测连续计算，但整合提交1c8a8ac8把三个运行文件的修复覆盖，5项回归测试保留，因此又出现H1/H4/D1加载足够历史仍只有SMA、阈值和信号缺失的问题。此归因由两次提交的代码diff直接确认。

最小反馈环使用300根D1：原始RRS公式与独立literal Pine oracle一致，有39个有效阈值；经输入转换后新增60个gap_before，阈值全部为空。该探针没有缓存参与，排除了公式和缓存作为本次根因。见 [diagnosis.json](diagnosis.json)。

恢复原修复的3处运行代码，共10行新增、5行删除：calculation_rows提供默认True的infer_gaps；仅平台RRS主入口及备用入口传False。时间间隔不再凭空打断RRS，现有显式gap_before、未完成输入的重置保持。其他指标、自建/组合输入策略、Pine公式、参数、K线内容和日历身份均保持原行为。没有修改任何现有测试断言。

## 验证

- 原命令先稳定复现5项失败：[红例](regression-red.log)。修复后原5项全部通过。
- 9个相关文件162项通过，67.32秒：[回归日志](regression-green.log)。覆盖RRS公式/预热/绘图/分页/未完成输入、平台缓存及checkpoint、其他10类指标、自建固定指标、告警计算及Swing日历分段。
- 冻结真实OANDA EURUSD bid/NY17 D1，1957根：全部5个输出及null分布与独立literal Pine oracle一致，最大误差0；1696个有效阈值、81框、49标签；翻页保留完整绘图。见 [本机对照](frozen-oracle-local.json)。该快照来自既有只读采集，不是本次网络实盘查询，也没有执行TradingView Pine。
- 变更Python Ruff、git diff检查通过。未执行本轮完整后端套件，不以162项定向结果声称全量绿色。

复现与验证：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch-history-modes-integration-20261024/.venv/bin/python -m pytest -q backend/tests/test_provider_squeeze_history.py
PYTHONPATH=backend:backend/tests /home/quant/repos/market-watch-history-modes-integration-20261024/.venv/bin/python scripts/acceptance/rrs_frozen_oracle.py /home/quant/repos/.mwa-rrs-provider-d1-20261024/eurusd-d1-frozen.json
```

原始真实快照私有保留；验证器仅输出摘要与checksum。现有独立测试venv只读复用，未修改其他任务环境。没有临时debug日志或临时生产插桩留在源码。

## 源码、实例和边界

- 独立工作树/home/quant/repos/market-watch-rrs-sparse-fix-20261026，分支fix/rrs-sparse-history-20261026，基线53fb056a。
- 产品提交4325e69d；此前接入交付分支未改动。精确运行文件摘要见 [summary.json](summary.json)。
- 本机Ubuntu quant-server，任务/项目mw-rrs-sparse-fix-20261026。磁盘余量低于完整preview启动门槛，采用无网络、无数据库、无持久卷的有界短时Docker计算smoke；不新开完整实例、不操作其他任务数据库。
- 本次仅更新长期mwa API，其余14服务保持原容器。入口https://test.kookvv.com:8443，图表https://chart-test.kookvv.com:8443；原数据、配置和浏览器现场保持。既有工作区/偏好未归因差异属于前轮留证，不在本轮改写或恢复。
- 无PR、外部Issue、推送、main合并或生产发布。


## 当前候选Docker复算

通过mw-docker（market-watch-ubuntu builder）构建的API候选镜像为market-watch-api:rrs-sparse-fix-20261026-r1，实际ID为`sha256:da302a85235d426d62f4f34bfcd209baf8376f80e545bf3950daf4d27232d9df`。构建源码提交4325e69d，精确构建标签见 [docker-smoke.json](docker-smoke.json)。镜像内3个改动模块的源码摘要均与候选一致。

在Ubuntu运行单个短时容器，network=none、只读rootfs、384MiB/1CPU、无数据库和持久卷；仅只读挂载冻结快照和oracle验证器。1957根真实日线复算与本机结果完全一致，误差0，1696个有效阈值、81框、49标签，翻页一致。见 [镜像内结果](frozen-oracle-image.json)。容器以--rm结束，没有留下运行中的新服务；此结果不代表HTTP/浏览器或mwa更新验收。

上段离线smoke发生于mwa更新前，docker-smoke.json内mwa_updated:false仅描述当时状态；随后用户明确授权“更新 mwa 并验收”，实际部署及结果如下。


## mwa更新与用户收口决定

已在Ubuntu quant-server的既有Compose project `mw-issue75-v2-20261018`替换API，运行镜像为上述r1，构建源码4325e69d且dirty=false。API内181个Python模块与候选源码一致，15服务运行、API/PG健康。10个worker保留r12 `sha256:3b6e18e3aadb83cec807532d804b2e4555cc05f3644facc6204f8f0e3566edb5`；Chart/Web及其他基础设施未替换。原生history任务的最终结果在API重新读取并计算，故本轮不为历史采集扩大worker更新范围。

更新前快照见[mwa-before.json](mwa-before.json)，最终保护检查见[mwa-audit.json](mwa-audit.json)：本次更新前所有被监测的工作区、偏好、告警、模板及通知原行无变更或删除，配置/schema/受保护浏览器保持。此审计以新RRS任务操作前为基线，不改写前轮股票接入任务1工作区、3偏好的未知归因差异。两个既有长期manager仅同步API镜像字段，见[manager-sync.json](manager-sync.json)；原始rollback与私有备份保留。

真实浏览器使用临时context、可信HTTPS，阻止保存用户工作区及偏好，市场行情请求没有mock。三次尝试均未到达RRS指标创建/绘图断言：第一次EURUSD D1最新数据加载超时，第二次历史区间导航超时，第三次历史timeframe未能完成加载。原生worker日志显示OANDA的代理TLS连接出现ConnectError/ConnectTimeout，三次采集均无页面推进，最终HISTORY_TIMEOUT；另一次无凭据的连通探针中，既有代理与直连均ConnectError。没有修改代理或重试策略。失败报告及截图保留于browser-attempt1/、browser-attempt2/、browser-attempt3/，原始抓取与日志仅私有保留。

库内已有EURUSD D1/H1/H4历史，但浏览器初始最新需求未完成，正常历史导航也未完成。不能把缓存存在、离线复算通过、HTTP成功或进程健康记为实际图表验收通过。本轮D1/H1/H4框和标签、真实图表分页仍未验收；162项定向回归和冻结真实1957根日线复算结果保持。未执行本轮完整后端套件。

用户了解进度与连接阻塞后要求“直接收口了”，据此停止补验，按“修复与部署完成、实时浏览器验收受阻”的边界交付。OANDA连接问题保留为独立后续事项，不继续扩大本轮范围。没有推送、PR、main合并或生产发布；长期实例、真实数据、配置和保护浏览器继续保留。

管理命令（每次选择一个）：

```bash
python3 /home/quant/repos/.rrs-sparse-fix-20261026/operate.py status
python3 /home/quant/repos/.rrs-sparse-fix-20261026/operate.py start
python3 /home/quant/repos/.rrs-sparse-fix-20261026/operate.py stop
```

start/stop只作用于API；status查看原project。不要运行prepare/update重复覆盖候选。当前API精确回退配置私有保留在`/home/quant/repos/.rrs-sparse-fix-20261026/rollback-compose.json`，本轮未执行回退、迁移、seed、恢复、清库或资源删除。

任务退役清单只读查询返回“Exact project has no containers”：有界smoke已自行退出，未执行--apply；候选镜像正被长期mwa引用，不删除镜像或任何长期资源。见[退役盘点](retirement-inventory.json)。
