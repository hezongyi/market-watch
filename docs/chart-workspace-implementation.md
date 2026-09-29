# 图表工作区实现与维护

本模块在 `feature/chart-workspace` 开发。需求见 chart-workspace-plan.md；生产上线单独执行发布步骤。

## 入口和操作

工作台导航「图表工作区」进入 `/chart-workspaces`。占满页面，无工作台侧栏。
顶部新建、切换、复制、重命名、删除命名工作区。编辑后约900ms自动保存，也可手动保存。
选择活动图表后再切品种、周期、指标。六个固定布局支持分隔线拖动/键盘调节和单图临时最大化。
默认联动时间范围/十字线；不同品种不联动价格。周期离散导致边界按目标图可用时间点显示。

左侧八种工具：水平线、趋势线、射线、矩形、斐波那契、文字、平行通道、多空盈亏比。
选中或从对象列表打开属性，修改价格、样式、文字/级别；对象列表可隐藏、锁定、删除。
Esc取消绘制；Ctrl/Cmd+Z撤销，Shift+Ctrl/Cmd+Z重做；Delete删除选中对象。
同工作区同品种共享完整对象，不同工作区独立。盈亏比单位为价格距离和百分比，不计算金额或手数。

手机宽度760px以下只读，底部切换图表，不写回桌面布局、指标、画线或时间范围。
断网保留浏览器草稿，恢复网络自动保存；并发冲突提供加载服务器版本/另存副本。
草稿不是备份，正式数据在PostgreSQL。

## 数据与边界

- 延续现有 M1 采集，图表每15秒读取已入库结果。隐藏标签不轮询，不产生行情源额外订阅。
- EURUSD/XAUUSD 为 OANDA Bid，NY17；BTCUSDT 为 Binance Last，UTC0。时区切换仅显示。
- M30 在请求时合成两根系统M15（M15源自原有M1）；检查源完整性/预期交易时段。
- W1/MN 在请求时合成系统D1；纽约周日17点周界，月线按D1结束交易日期归月；BTC周一UTC0/自然月。
- 新周期不加入既有策略TIMEFRAMES，也不改采集/修复worker；底层M15/D1修复自动使聚合失效。
- 黄金周/月完整性还要求每个预期交易日的维护开始时刻有明确日历覆盖。日历不是对未来所有临时假日的保证。
- 未完成/缺失为灰色；指标以完整K线为基线，缺口重新预热，不填虚构OHLC或成交量。
- Python从全部已存同周期历史计算，再切分页，新增行情不滚动改变递推起点。补录历史/修订会有意重算，前端重新校验已加载页。
- 行情缓存最多16条且合计20万行；指标缓存最多64条且合计25万个值，15秒过期。超大单次序列不会驻留缓存；超长历史计算成本仍随数据量增长，后续可用持久化检查点优化。
- 未来空白区为后台120个交易桶的坐标网格，不是价格预测。插件增加日历边界保护，拒绝在网格外推算坐标；未加载历史/远未来锚点保留原值并提示，加载相应历史后显示。

## 存储设计

新增 `chart_workspaces` 和 `chart_indicator_templates`。画线与布局保存在同一JSON文档，用revision乐观锁原子提交。这替代原方案建议的独立画线表：单人规模下避免跨表部分保存和共享冲突，最多1000对象/2MB文档，每图最多12指标。

迁移 `e6_chart_workspaces` 仅加表。现有备份按Base全表处理，自动包含新表。生产备份仍在 `/mnt/user/backup/trading-alerts`。

## Python指标扩展

`backend/alerts/chart_indicators.py` 内注册目录和纯数组计算器：

```python
register("CLOSE_OFFSET_V1", {
    "label": "收盘偏移", "pane": "sub", "params": {"period": 20},
    "styles": {"value": "line"},
}, lambda high, low, close, params: {
    "value": close - talib.SMA(close, timeperiod=params["period"])
})
```

在应用启动前导入注册代码。返回等长NumPy数组；NaN作为预热空值；支持line/histogram/area、多线、主副图、levels。
空数组也需返回相同输出键。参数默认整数2—500，deviation为0.1—10；特殊参数类型需扩展验证和前端表单。
算法变更使用新的名称（例如V2），不覆盖已注册算法；现有协议version固定为1，模板记录名称/version/参数。
常规参数和图层自动显示；特殊交互不承诺无需前端适配。图表扩展不会自动增加策略预警条件。

首批：SMA/EMA/LWMA(WMA)/BBANDS/RSI/MACD/ATR/STOCH；STOCH14/3/3 SMA、20/80。

## 第三方与构建

Lightweight Charts5.2.1固定版本；7个Line Tools仓库固定commit、MPL-2.0源代码和许可证随web发布。
`cd web && npm ci && npm run vendor:build && npm run build`。
`web/vendor/README.md` 记录来源、修改及重建。构建脚本只给上游geometry添加日历范围保护。

## 开发验证

所有Python命令使用 `PYTHONPATH=backend`，避免共享开发虚拟环境的editable路径指向主工作树。
后端：`PYTHONPATH=backend .venv/bin/python -m pytest backend/tests -q`。
浏览器：`web/tests/chart-workspace-acceptance.mjs`、`chart-workspace-resilience.mjs`（固定localhost，产生开发工作区，不用于生产）。
Playwright需要环境已有浏览器和依赖，脚本中的本机路径应按运行环境调整。

## 发布/回退

1. 对生产现版本备份数据库与配置到既有backup目录；记录备份与镜像摘要。
2. 构建/固定API和web镜像，确认静态源代码许可包随web产物发布。
3. 在开发隔离库验证迁移后执行生产 `alembic upgrade head`，仅添加两表。
4. 更新本项目服务，验证登录、原监控/演练路由、工作区创建/保存/恢复；不发真实手机通知做图表回归。
5. 回退只回退API/web镜像，保留新表，避免损失工作区；不执行删表downgrade作为生产回退。
6. PostgreSQL整库备份后应在隔离临时库恢复，检查一个含画线/指标的工作区，禁止覆盖生产演练。

当前实现没有部署到Unraid；本地提交和交付验收完成后才准备生产版本。
