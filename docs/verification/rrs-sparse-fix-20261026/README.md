# RRS原生稀疏历史修复

修复已通过本地162项相关回归；当前mwa未更新。本次为独立补丁，风险F0，无schema、持久格式或worker链路变化；本次执行结果以summary.json和本文末尾Docker记录为准。

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
- 本次未更新长期mwa。现有入口仍为https://test.kookvv.com:8443，原数据、配置和浏览器现场保持。既有工作区/偏好未归因差异属于前轮留证，不在本轮改写或恢复。
- 无PR、外部Issue、推送、main合并或生产发布。


## 当前候选Docker复算

通过mw-docker（market-watch-ubuntu builder）构建的API候选镜像为market-watch-api:rrs-sparse-fix-20261026-r1，实际ID为`sha256:da302a85235d426d62f4f34bfcd209baf8376f80e545bf3950daf4d27232d9df`。构建源码提交4325e69d，精确构建标签见 [docker-smoke.json](docker-smoke.json)。镜像内3个改动模块的源码摘要均与候选一致。

在Ubuntu运行单个短时容器，network=none、只读rootfs、384MiB/1CPU、无数据库和持久卷；仅只读挂载冻结快照和oracle验证器。1957根真实日线复算与本机结果完全一致，误差0，1696个有效阈值、81框、49标签，翻页一致。见 [镜像内结果](frozen-oracle-image.json)。容器以--rm结束，没有留下运行中的新服务；此结果不代表HTTP/浏览器或mwa更新验收。

候选代码修复完成。按用户此前验收前申请的要求，已询问是否将该独立补丁更新到mwa做实图验收；未获得该次回复前不替换长期实例。162项定向回归和有界Docker计算smoke均通过，没有为本次补丁重复运行全量后端或创建完整preview。
