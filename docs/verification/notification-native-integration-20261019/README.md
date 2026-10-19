# Issue #75：原生通知整合与真实行情验收

2026-10-19。运行源码候选 `f00235f`，固定基线 `v1.26.1`。本轮直接把用户确认的共享预览组件接入实际通知传输；最新补丁移除了慢加载时挤压图表的顶部状态条。

## 环境

- 实际主机：Ubuntu `quant-server / 192.168.7.232`，本机 Docker，独立 task/project `mw-issue75-v2-20261018`。
- 验收地址：<https://192.168.7.232:18280/advanced-charts/mw75-real>，图表来源 <https://192.168.7.232:18281/>。自签名证书，密码单独交付。
- 独立任务 PostgreSQL 14.24 的 `preview_mw75_real20261019`；此前测试数据库保留。使用真实供源，不注入合成 K 线或告警观测。供源凭据仅在私有运行配置中。
- 全部 15 个长期服务运行：postgres、api、projector、web、chart、gateway，以及实时、图表历史、图表聚合、原生历史、历史、组合聚合、定价、行情流和通知 worker。迁移为一次性任务。见 [服务状态](services.tsv)。
- [供源数据快照](real-provider-data.csv)保留实际来源、周期、条数及最后观测时间；真实 OANDA EURUSD/XAUUSD 持续更新。
- 启动全部服务：`python3 /tmp/mw75-integrated-compose.py up -d --no-build`。
- 停止：`python3 /tmp/mw75-integrated-compose.py stop`。wrapper 对应本任务私有 `runtime/integrated-compose.json`，不使用旧 UI fixture wrapper。
- [实际镜像](images.txt)。API 镜像标签记录的是早期构建提交，不能据此推断源码版本；已逐字节比较当前候选的 453 个后端、迁移和依赖输入文件，全部一致，见 [比较结果](backend-bytes.json)。Web/chart 镜像标记源码 `f00235f`。
- 外部手机投递关闭；仍保留实际手机 pending 状态用于隔离检查。未合并 main、创建正式 tag 或部署生产。

## Playwriter 实测

使用 Playwriter session 2，真实许可图表 v31.1.0、实际 API/数据库/worker，1440×960 和 850×960。只导出专项结果，不导出凭据或完整浏览器状态。见 [结构化结果](playwriter-results.json)。

| 场景 | 结果与证据 |
| --- | --- |
| 原生系统中心 | 实际 Dialog / DialogSearch / NavButton 与原生细滚动条；搜索不自动聚焦，点击输入无蓝色描边；真实中文查询有效；仅系统消息；列表滚动且无分页栏。见[深色](system-center-dark.png)、[浅色](system-center-light.png)、[850 宽度](system-center-850.png)。本轮实际历史不足一个完整后端页，跨页连续加载由既有 history/runtime 回归补充验证。 |
| 真实交易触发 | 四条真实 EURUSD 规则由正常行情 worker 触发，不调用合成 consume。原生顶部卡 x542.5/y46/w355，深灰底、原生白色确定按钮，另有待确认数量。见[交易卡](trade-dark.png)。 |
| 持久队列 | 未确认超过 30 秒及刷新后仍保留当前条和后续条；点击记录不确认；第二标签确认只移除当前事件并同步第一标签；逐条确定后清空，不补弹等待期间的系统消息。 |
| 系统与交易优先级 | 交易卡存在时对实际保存请求注入网络失败：新系统故障进入中心，不替换交易卡。见[告警记录与卡片](alert-log.png)。抢占和排队边界另有 runtime 回归。 |
| 手机隔离 | 网页查看记录、逐条确定前后，四条真实事件 viewed/handled 仍为空，手机 pending/stopped_at 状态相同。 |
| 系统限时卡 | 实际保存失败触发原生系统卡；未将焦点移入卡片；悬停超过 8 秒仍显示，移开后 8 秒消失。见[实拍](system-live-toast.png)。同图的草稿保护确认属于原有防丢失操作界面。 |
| 慢加载无位移 | 将真实 EURUSD 周期切换的 `/api/charts/history-loads` 请求延迟 12 秒；超过旧 5 秒阈值时无自动加载条。iframe 始终 x0/y0/w1440/h960，画布始终 x56/y42/w972/h809，加载后相同。见[慢加载实拍](slow-loading.png)。 |
| 主动加载操作 | 左上角三横线 → 历史加载详情；按需浮层保留进度、取消、重试、容量操作，打开也不改变画布尺寸。菜单另提供取消历史加载。见[入口实拍](history-menu.png)。 |

本轮浏览器 pageerror 为空。网络中断与 12 秒延迟是明确的故障/慢网注入，响应数据和交易触发来自真实服务。验收结束已解除本轮路由拦截，移除本轮创建的绘图并成功保存。真实告警和故障历史保留。

## 风险与检查

整体 **F1 / Ubuntu R2**：告警浮窗确认增加本地持久语义，沿用 IndexedDB v1 的 cache store，无服务端 schema 变更。原服务端迁移、旧版本兼容和手机协议证据见[原 R2 执行记录](../unified-notifications-20261018/execution.md)。本轮慢加载补丁是 F0 展示调整，不重复数据库迁移。

通过的本地检查：TypeScript、生产 Web/chart Docker 构建、Runtime 回归、真实 IndexedDB 事务接口回归、历史进度累计回归、脚本语法及 diff 检查。持久化回归覆盖 25 条队列、重复接收、游标事务中断重试、40 天未确认保留、主体隔离、重新打开及旧 v1 客户端兼容。

整合实现 `d5aef7f` 经独立 Standards / Spec 两轴复核，修复初始化存储时序、详情 ID 丢失以及网络阻塞待确认恢复等问题后无剩余 P1/P2。`f00235f` 的局部展示修正另经本人自审、真实慢加载和菜单操作复验。

整合源码 CI：[d5aef7f，全部通过](https://github.com/hezongyi/market-watch/actions/runs/39205187334)。慢加载补丁 CI：[f00235f，全部通过](https://github.com/hezongyi/market-watch/actions/runs/39207282638)，后端全量 2620 通过 / 17 跳过（996 秒），Web/Compose 和 required checks 全部通过，见 [源码 CI 清单](source-ci.txt)。后续归档只修改文档和证据，不改变此运行候选；不将源码 CI 冒称为后续提交的检查。最终 PR 状态以 [PR #87 checks](https://github.com/hezongyi/market-watch/pull/87/checks) 为准。

未声称外部手机实际送达、用户物理听见、真实读屏设备或长时间性能压力已测。原生入口失效、其他深链和降级行为沿用此前专项回归及原记录；本轮不把旧合成数据截图当成真实行情证据。
