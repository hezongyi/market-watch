# 历史容量与加载提示验收（2026-10-05）

## 候选行为

实现范围见 [计划](history-capacity-loading-plan.md)。汉堡菜单“历史数据容量”默认为 200,000 根，后端持久化、严格校验；当前 widget 不重建即可应用。默认工作区加权容量 800,000，响应保护 128 MiB，任务 600 秒/300 页。服务器硬上限 1,000,000 根、加权 4,000,000；设置许可不代表所有组合都能达到相应数量，响应、指标、页数和时间保护仍可能先触发。

右下角提示覆盖真正的 getBars 排队、缓存检查、后台补数、交付及原生回调后的绘制帧；显示品种、周期、请求根数、请求区间 UTC、真实缓存页数/收到根数、等待时间。同源并行以最近活动请求的匹配信息展示并标注请求数量；没有假百分比。快速加载少于 250ms 不显示；已经显示的短任务保留结束状态减少闪动。失败/取消由原有明确错误与收尾处理。

已加载区间完全由 widget 缓存定位、没有 getBars 时不出现加载提示。绘制帧结束表示这次数据回调处理结束，不是后台所有可选储备或未来请求均完成。大数据原生同步计算仍可能阻塞图表线程，取消不能中断正在执行的同步计算。

降低容量不删除常驻数据，已有范围仍可定位；减轻指标成本的模板允许继续。新增数据/指标仍须准入。其他已打开页面刷新后应用新容量；后端正在运行的任务按当前设置检查，降低设置可能明确终止超额读取，已提交缓存保留。

## 实测证据

Ubuntu，独立 Compose `mw-native-history-ubuntu-20261004`，四图 W1/M5/H4/D1，真实 OANDA EURUSD、原生 v31.1，Chromium 153；每图 MA200/RSI/MACD 的新容量专项验收。

- [实际菜单与热加载](verification/native-history/capacity-notice-20261005/capacity-menu-hot-product.json)：80,000 下周图 2025-07-14 请求 M5 投影超过 92,000，明确拒绝；菜单调到 200,000 后同 bar 成功。最终专项热测点击至就绪 4.71 秒，常驻合计 96,431 根，iframe JS heap 约 282 MiB，最大观测长任务 1.693 秒（整轮观测，非严格单次 CPU 测量）。新提示包含检查缓存、交付和处理阶段。降低至 80,000 后已加载日期仍能定位；随后恢复 200,000，hover 历史读取 0。
- [真实冷补数阶段](verification/native-history/capacity-notice-20261005/cold-stage-evidence.json)：目标 W1 2024-03-11，取消后重试成功，提示记录真实进度至 18 页。重试点击至就绪 72.76 秒，常驻合计 198,529 根、M5 为主要来源，四图各三指标仍 ready；整轮多次操作后的 iframe JS heap 约 1.06 GiB，最大观测长任务 4.884 秒。此为部分已缓存走廊加缺失补数，不是从空 PG 首次完整加载，也不是全天无泄漏保证。该源脚本随后用 `widget.load()` 验证工作区菜单事件的假设错误而失败；保留原失败。补数/取消阶段通过，最终实际 `loadChartFromServer()` 工作区切换已在菜单专项独立复跑通过，不将整个原脚本伪装成通过。
- [四图连续核心](verification/native-history/capacity-notice-20261005/continuous-four-chart.json) 与 [完整四图回归](verification/native-history/capacity-notice-20261005/complete-four-chart.json)：静止/hover 十字线不重建，故障 busy/provider/timeout/capacity 后有效导航恢复，加载中取消及回最新、MA/RSI/MACD/Python SMA、拖动、画线、保存重开通过。本轮没有执行新的真实供应商修订注入；PG 一致快照与修订模块覆盖通过，之前的真实修订产品证据仍见原验收文档。
- 相关后端单元回归 117 passed；真实 PostgreSQL 隔离 schema 回归及容量测试 24 passed。新增单连接池下热读取、容量读取遵守取消/过期预算测试。测试 schema 清理，不复用生产数据。
- 前端构建、热/冷进度与取消失败 VM、准入升降/模板减负 VM、原生补丁内容校验、历史 reset、视区恢复与 range guard 回归通过。
- 菜单专项用实际保存/加载 API 验证同 iframe 切换时迟到 GET 不重新打开弹窗；来源与 epoch 同时约束旧进度/收尾。
- 深浅主题实际菜单弹窗与 Tab/Escape 已核对：[深色](verification/native-history/capacity-notice-20261005/dialog-dark.png)、[浅色](verification/native-history/capacity-notice-20261005/dialog-light.png)。

## Standards

复核起初发现嵌套容量数据库连接、保存弹窗迟到响应、容量查询缺少预算、打开弹窗迟到 GET 缺少 epoch。全部已修复：读取提前取得容量、传入快照与可选预算；采用有截止时间/取消的事务；卸载 abort 与存活判断；打开回调同时校验源窗口和代次。剩余发现 0。

## Spec

复核起初发现同 iframe 旧加载提示、并行信息混合、降低容量后减负模板被拒。全部已修复并补回归；剩余发现 0。用户新建议“超限时跳到实际边界”目前仅分析，没有加入本候选。

## 访问与管理

人工入口：**https://192.168.7.232:16343/advanced-charts**。图表独立来源 `16344`；六服务运行，API/PG healthy。私有配置路径 `/home/quant/repos/.acceptance/native-history-implementation-20261004/compose.yaml`，登录凭据沿用原验收；不提交私钥/许可/env。生产与 Unraid 未变更。

```bash
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/native-history-implementation-20261004/compose.yaml up -d'
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/native-history-implementation-20261004/compose.yaml stop'
```

更新 API 时 reload web nginx，更新 chart/web 时 reload tls nginx。私有旧 compose/env 保留为 `compose.pre-capacity-notice-20261005.yaml`、`api.pre-capacity-notice-20261005.env`；回退应先停本项目消费者、恢复旧匹配组合，不删除 PG volume。容量偏好也需显式改回旧80k（旧 API 不读新偏好）；不热切模式。

| 镜像 | SHA256 |
| --- | --- |
| `mw-native-history-api:capacity-notice-20261005` | `fcb39f454ef71112d1c2cc3a699ca5791a73526c1805cfa8bfbff4e6e92f935a` |
| `mw-native-history-web:capacity-notice-20261005` | `dafb6473387291498f667377013fbbea4c83942c21c332f49cff834c6f1909b0` |
| `mw-native-history-chart:capacity-notice-20261005` | `60477e142cc4f292e29850f77879d373d9f52eefe84f96f0e7ca166e7eeaf7da` |

## 人工核对

1. 刷新原验收页面；汉堡菜单“历史数据容量”应显示 200,000，修改后再打开/刷新仍保留。深浅主题、Tab/Escape 可用。
2. 原四周期打开十字线及时间同步，点 W1 2025-07-14，M5 到相应时间，不在 hover 后闪烁。
3. 远日期加载超过约 250ms 时，右下角显示对应品种周期、真实阶段/页数、根数、UTC 请求区间和耗时；加载结束清除。即时缓存定位无加载提示。
4. 加载中取消/换目标/切工作区，旧状态不覆盖新状态；下一次仍可加载。
5. 降低至 80,000 后已加载范围仍可查看；超额新日期提示具体容量与设置入口。**当前超限仍保留原位置**；“跳到极限边界”待用户决定后另做。本轮不把拒绝伪装成成功导航。

Standards 0 / Spec 0 剩余发现；原生大数据同步处理成本为明确限制。
