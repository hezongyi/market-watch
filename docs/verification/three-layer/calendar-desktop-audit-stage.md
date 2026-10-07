# 真实日历样本、维护冲突与桌面收口检查

日期：2026-10-07。分支 `feat/market-data-integration`，前置提交 `92b3475`。
本报告是新增证据与缺项修复，完整实现验收及48小时质量结论仍未完成。

## 实际日历样本

Ubuntu隔离API、history-worker、PostgreSQL和真实供应商完成两来源
Dukascopy/OANDA、两品种EURUSD/XAUUSD、三个历史窗口，共12项、50,605根原始M1。
窗口分别为2026-03-05 22:00Z至03-10 21:00Z、2025-10-30 21:00Z至11-04 22:00Z、
2026-08-30 21:00Z至09-02 21:00Z；结束边界不包含。

每项实际发布M1/H4/D1/W1/MN，再由同一原始内容派生UTC0相同五周期。
独立datetime/zoneinfo参考核对时间桶、OHLC和观测根数，不调用产品聚合辅助函数。
NY17/UTC0的M1价格/量/确认一致，共享checksum/content_id，派生供应商请求为零，
原始manifest不变。缺失分钟仍为unknown，不把周末或金属维护段自动证明为闭市。
专用禁用元数据身份避免这些旧窗口成为正常数据集最新基线；没有图表或stream需求。

[`verify_history_calendar_samples.py`](../../../scripts/verify_history_calendar_samples.py)
首次执行查询未命中品种、试图写只读/app导致失败，没有建立样本；修正准确代码、分页和/tmp后通过。
此进程启动后才加上的显式21/22点、167/169小时和双月桶断言，**不计入该次通过**。
后续脚本重新通过实际HTTP读取全部24份NY17/UTC0发布版本，完成这些断言及独立OHLC复核。

[`verify_composite_calendar_samples.py`](../../../scripts/verify_composite_calendar_samples.py)
在同一个Ubuntu PostgreSQL的随机独立schema中复制经过校验的实际原始分块及周期产物，
用实际保存映射合同、preparation claim/commit、确认M1修订、组合输入日志、持久聚合和图表读取代码
重放12组固定历史组合。价格来自已下载的真实OANDA M1，观测时间来自原始读取；没有生成价格。
测试修订/截止点是**明确有界的历史夹具**，不声称经过默认“首次使用到现在”的实时准备链路。
不修改正常组合、不申请实时需求、不下载数月尾部；finally删除精确自有schema。

12组均通过H4/D1/W1/MN独立价格和边界核对。跨源桶总volume为空，保留两段实际观测量；
组合尾部与存储原M1一致，缺口不填价，闭市证据为空时unknown按全桶分钟减观测计算。
NY17春季周末接缝前后恰落两个周桶，W1没有混合观测；MN仍有混合证据。
UTC春季、两相位秋季及换月的W1/MN均有真实混合桶；日界接缝使H4/D1无需混合桶。
不把空周末观察称作DST当刻全市场覆盖或完整会话验收。

重放初轮失败完整保留：容器用户无权读私有样本、夹具instrument及read_kind超出字段长度、
秋季接缝落在换月边界导致没有混合月桶。修正脚本后12项与24份HTTP复核通过，schema_removed=true。
失败未改产品价格/身份规则，也未留下正常组合。

## 维护和版本页缺项修复

配置报告新增实际配置的SHA256修订号。UI固定打开时的修订，后台任务进度不移动修订；
保存在数据集锁下核对。另一窗口已修改则HTTP409 `MAINTENANCE_CHANGED`，保留输入，
展示最新配置并由用户明确载入；随后保存才成功。兼容旧无token客户端，创建幂等清单去除默认null字段。
NY17交易日期显示改用纽约本地日期，避免固定UTC偏移在冬夏令时误算。

真实双窗口HTTP409、保留赢家配置及未保存字段、显式载入后保存通过；
只操作EURUSD春季专用验收计划。初次原无计划，结束设once/M1/UTC00:15/overlap30并暂停；
复跑只接纳脚本自己的已知暂停计划并还原，不修改正常数据集。

需求核对另发现指定区间复查和前版差异缺少UI，已补：

- 区间任务明确选择补数/复查，相同意图的失败重试保留request_id。
- 发布版本显示发布时间、固定回测入口和前版清单对比；优先选任务固定父版。
- 比较固定范围、观测/unknown、周期状态及相同分区checksum；不将分区变化解释为逐分钟改价数。
  非相同分区明确不可直接比较，回收版本仍可看清单，不能打开价格。
- HTTP/MCP共用只读对比接口；引用页提供准确映射入口、保存映射和按精确数据集分页的组合详情。

真实浏览器执行专用春季EURUSD的一日复查，受控丢弃**已成功返回的HTTP响应**，
再次点击使用相同key返回同一任务。实际worker发布、原父manifest不变、暂停计划不变；
固定父版对比和回测链接、三桌面宽度/200%内容缩放通过。保留该新发布供审计。
首轮标签可访问名称未准确匹配导致浏览器超时，加明确aria-label后通过，没有首轮任务副作用。

## 桌面与回归

11个实际页面覆盖列表/平台/任务、自建概览/覆盖/版本/维护/引用、组合概览/使用和创建。
1024/1440/1920、200% CSS内容缩放、键盘可见焦点、减少动画、503保留真实快照及重试、
定时刷新保留表单/焦点、离线保存保留字段通过，无pageerror或管理写入。
初轮发现muted文字4.388:1，数据中心作用域调整后最终**997个可见DOM文字样本**通过。
排除canvas、禁用控件及未解析渐变/透明层；不声称覆盖这些排除项、完整浏览器缩放或整应用深色主题。
最后API重启后立即启动浏览器曾因服务尚未就绪在登录阶段超时；确认/readyz就绪后同一完整审计
复跑通过，未将该次未进入页面的运行计为验收成功。

前序全量1068 passed/232 skipped/297.35s；本次新增对比后定向本地维护13 passed/2.69s、
实际PG14 passed/16.95s，MCP/权限本地26 passed/26.23s；最后实际PG维护/对比/写入
18 passed/27.95s，映射列表筛选及HTTP/MCP本地3 passed/11.19s。
最后完整后端 **1069 passed/233 skipped/254.71s**，33个既有迁移警告，
`calendar-audit-full-regression.log`。随后增加的精确数据集组合列表筛选由上述最后3项HTTP/MCP合同
独立覆盖，不将未重新执行的新断言说成已经包含于全量结果。
TypeScript/Vite、Ruff、浏览器脚本语法和diff检查通过，保留既有bundle体积提示。
新增测试首次误用不存在密码设置字段、一次PG命令引用不存在测试路径，均保留失败日志并修正复验。

私有完整记录在ignored `artifacts/data-integration`：`calendar-history-real-01.json`、
`composite-calendar-real-01.json`、`maintenance-conflict-real-browser.json`、
`history-review-real-browser.json`、`data-center-final-audit.json`和相关成功/失败日志、截图。
凭据、许可资源、完整记录不提交仓库。可提交验证入口为本报告所链接Python脚本，以及
`web/tests/maintenance-conflict-real.browser.cjs`、`history-review-real.browser.cjs`、
`data-center-final-audit.browser.cjs`。

## 实际环境与剩余范围

Ubuntu Compose `market-watch-three-layer`，PostgreSQL14，migration ak38；
UI/API <http://127.0.0.1:16629>，许可origin <http://127.0.0.1:16630>。
API/history-worker已经重启加载新代码，web挂载实际新dist；其他本项目worker运行。

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime start api history-worker native-history-worker composite-aggregate-worker pricing-worker web chart-origin'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop api history-worker native-history-worker composite-aggregate-worker pricing-worker web chart-origin'
```

2026-10-07 09:49新加坡时间只读运行复核：API/PG健康，八服务运行；实际数据库约268MB，
有效图表需求0、活跃stream拥有者0，剩余calendar_replay schema为0。约51GB可用；
无Docker清理、无旧实例或生产变更，无推送/PR/订单。MT4后续。
完整逐项审计继续，特别是删除影响细节、长标签/错误焦点及存储增长容量、稳定观察工具。
新三层48小时观察未启动，实现验收与质量验收分开；本阶段通过不能替代最终交付。
