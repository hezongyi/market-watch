# 平台行情 RRS 高周期只有 SMA 的修复

用户报告 OANDA 平台 EURUSD 日线加载到 2022 年仍只有 SMA。风险分类 F0：兼容的指标输入分段修复；没有 schema、数据迁移或持久格式变化。本地 Issue 草案及验收记录，未创建外部 Issue/PR。

## 根因与改动

原生平台行情在 `calculation_rows` 中根据日历推断 `gap_before`。圣诞、新年前后未返回 K 线的间隔因此触发 RRS 清空 K 窗口和 252 个历史比值；加载更早历史仍会经过后续重置。总历史已有 1957 根，但最新日线阈值全部为空，仅 2022 年初保留两个历史框。

给输入转换增加默认保留原行为的 `infer_gaps` 开关，仅平台 RRS 的主计算和备用入口关闭时间间隔推断。现有 OHLC 连续进入原版公式；不补造任何 K 线，不推断休市已被认证。来源明确标记的无效/缺口及未完成输入仍按现有规则重置。其他指标、自建/组合输入策略、绘图工具、默认参数与告警语义未改动。

## 反馈与验证

回归命令：

```bash
PYTHONPATH=backend python -m pytest backend/tests/test_provider_squeeze_history.py -q
```

旧代码 5 项失败，包含 H1/H4/D1 的 `calendar gaps must not restart the 252-ratio warmup`。修复后与原 RRS 定向回归共 24 项通过，其他 10 种指标的 checkpoint/batch 对照也通过；Ruff 和 `git diff --check` 通过。定向回归中已有数据库 fixture 使用测试内存 SQLite；它没有参与真实价格对照或实例验收，也没有为产品增加数据库。

- 冻结真实 OANDA EURUSD bid/NY17 D1 1957 根，只读导出；本机及实际候选镜像内，所有 5 个输出的数值/null 分布、框和标签几何均与独立 literal Pine oracle 一致，最大数值误差 **0**。
- 默认 10/252/5%/收盘确认：1696 个有效阈值，**81 框 / 49 标签**。没有执行 TradingView Pine，不扩展为跨平台认证。
- 更新后的真实浏览器：D1 返回 357 根均有有效阈值，其中 51 根 signal=1；81 个原生矩形、49 个 balloon，2026 年当前视窗可见 17 个框。实际截图已目视核对。
- 扩展时间范围后历史框保留；切 H1 为 17 框/11 标签，H4 为 61 框/36 标签。页面未捕获异常 0。
- 使用全新临时浏览器，工作区/偏好/通知写入被只读验收代理拦截；用户保护浏览器未操作。未跑全量后端套件。

## 运行与交付

- Ubuntu `quant-server`，既有 `mw-issue75-v2-20261018`，入口 `https://192.168.7.232:18280`。
- 产品提交 `b4e1326adb779a0b5c53e389681ac008dc75ea13`，独立工作树 `/home/quant/repos/market-watch-rrs-provider-d1-20261024`，分支 `fix/rrs-provider-d1-20261024`；以现有 Chart/Web 的 970a2550 为基线，其后端与此前运行的 8b7ee3ee 相同。
- 只替换 API，实际镜像 `sha256:62a8b6b533367630043061ea9529b3f874c4479f5f75b6ed4c1f04f31a136ee8`。10 workers 仍 8b7ee3ee；Web/Chart 仍 970a2550，此前 NR 加载连续性与偏好提示修复均保留。
- 15 服务 running，API/PG healthy；环境、挂载、端口、网络、资源及重启策略保持。保护浏览器及其启动时间保持。
- 六张保护表的全行哈希保持；此前 23891 条通知查看/处理状态、7 条手机确认保持。正常后台期间新增 3 条通知，不声明整库静止。
- API 验收窗口有 6 个既有请求取消 `CancelledError` traceback，HTTP500/连接池超时为 0；不宣称全栈零异常。
- 没有清库、seed、迁移、生产/Unraid 操作、push、PR 或 main 合并。

统一启动/状态/停止：

```bash
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py status
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py stop
```

本轮审计：`python3 /home/quant/repos/.mwa-rrs-provider-d1-20261024/operate.py audit`。精确旧 API 镜像、原配置与回退 overlay 私有保留于 `/home/quant/repos/.mwa-rrs-provider-d1-20261024`，未执行回退；旧任务 operate 的候选版本不能覆盖当前实例。

原始证据 `/home/quant/repos/.reports/market-watch/20261024-rrs-provider-d1`，真实 OHLC 私有保留。结构化结果见 [summary.json](summary.json)。
