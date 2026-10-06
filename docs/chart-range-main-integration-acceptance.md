# 范围映射、同步设置与柱宽同步：main 集成验收

2026-10-06（Asia/Singapore）。隔离 worktree `/home/quant/repos/market-watch-range-main`、分支 `feat/range-sync-main-integration`；原功能提交 `80611cb` 与 main `826d316` 在 `96709e8` 整合，功能修订 `fd4dcad`。当前范围收口提交 `31e1e39` 撤回额外的 Python 指标及后端计算修复；后端源码和 `advanced-host/indicators.js` 与 main 基线一致。原 v1.8.0 验收实例与[历史验收记录](chart-range-v1.8.0-acceptance.md)保留。

## 本次交付范围

- “K线范围映射”改为“范围映射”；布局菜单末尾“同步设置…”集中配置范围映射、样式、颜色、透明度和高低价标签。深色默认白色透明，浅色默认灰色透明；高低价显示在时间轴下方的信息栏，完整价格数字保留，不覆盖 K 线。
- 柱宽同步跟随实际接收用户横向缩放的图表：鼠标所在图滚轮、原生按钮、快捷键等改变柱宽时，其他就绪时间图跟随，不要求预先切换焦点。仅开启、切换焦点或程序恢复不主动传播。
- 柱宽同步与日期范围同步互斥，开启一项后另一项禁用变灰。工作区保存、刷新与重开保留设置。
- 与 main 的绘图投影、告警图表身份和工作区保存兼容；异步捕获期间 epoch/editRevision 改变拒绝陈旧写入。

大容量历史更新、指标前缀修订和后端性能修复不属于本次任务。发现的基线问题见[独立跟进记录](chart-range-main-baseline-followups.md)，不作为本 PR 的收口条件；若本次范围/同步改动引入回归，仍须修复。

## Ubuntu Docker 隔离实例

实际主机 Ubuntu `192.168.7.232`，Compose project `mw-range-main-20261006`。应用：<https://192.168.7.232:16843/advanced-charts>；图表来源：<https://192.168.7.232:16844>。独立网络、volume、数据库 `range_main`；PG14仅绑定 `127.0.0.1:16832`。原 `16743/16744` 实例保留，unraid 生产环境未改动。

运行 API `mw-range-main-api:candidate1`、图表 `mw-range-main-chart:candidate2`，图表资产 `host.d0a96d61fcfcc340.js`。部署恢复后 API 健康，22 个宿主 JS 模块逐字节匹配当前源码。私有 Compose、env、TLS、登录信息在 `/home/quant/repos/.acceptance/range-main-20261006`，不提交。自签证书首次分别访问两个地址接受证书；通知仅连接内部验收 sink，不发送真实通知。

```bash
sg docker -c 'docker compose --env-file /home/quant/repos/.acceptance/range-main-20261006/compose.env -f /home/quant/repos/.acceptance/range-main-20261006/compose.yaml up -d'
sg docker -c 'docker compose --env-file /home/quant/repos/.acceptance/range-main-20261006/compose.env -f /home/quant/repos/.acceptance/range-main-20261006/compose.yaml stop'
```

## 自动验证

已完成候选2范围/同步169项、14组，均绑定 `host.d0a96d61fcfcc340.js`，无页面异常；[原始汇总](verification/chart-bar-range-mapping/main-integration/summary.json)保留原候选结果。撤回范围外修复后，同候选的同步设置31项、逐帧稳定性9项、映射39项、生命周期6项、导航8项共93项/5组全部通过，未记录页面异常；[最新汇总](verification/chart-bar-range-mapping/main-integration/scoped-final/summary.json)单独归档，不覆盖旧证据。

恢复部署后的逐帧稳定性9项通过：真实 provider W1/M5/H4/D1，M5保留89,199根走廊，最新行情采集303帧、静止鼠标历史加载采集118帧，检查K线像素、model/chart身份以及来源、公开光标、日期标签。时间按来源真实 `[start,end)` 验证；周线标签日期可以与实际纽约17点交易周开始时间不同，小周期十字线时间须落在同一真实区间，跨周期标签不要求文字相同。有限采样不代表任意设备、任意操作绝无闪烁。

旧布局迁移使用2万根容量；导航维持20万根和原目标日期，等待预算180秒，其他组默认60秒。未降低定位、就绪或时间断言。四图容量边界已通过，作为范围映射可达边界检查，不扩展为历史更新修复。

main 集成检查点另已完成后端586通过/46跳过、真实告警8项、MCP SDK15检查/13工具、chart→PG→MCP→刷新6项。这些是原候选的兼容证据，不将指标或历史完整组合失败写成通过；此次不重做无关整链。用户指定 gpt-6.1-sol/max 的 Spec/Standards 审核记录见[复核记录](verification/chart-bar-range-mapping/main-integration/review-final.md)。

## 人工验收与收口条件

四图工作区 **main 集成：范围映射与柱宽同步验收**：W1/M5/H4/D1，Dark，范围矩形、高低价标签、时间与柱宽同步开启，日期范围同步关闭，容量200,000。自动准备与重开检查不等同于用户验收。

1. 保持焦点不变，在另一图滚轮缩放，确认其他图柱宽跟随；再试原生缩放按钮和快捷键。只切焦点或开启同步时不主动统一。
2. 布局末尾打开“同步设置…”，检查柱宽/日期范围互斥、颜色和透明度，保存后刷新重开。
3. 指向历史周线，确认小周期十字线时间在来源周线真实区间内，范围映射边界正确。静止鼠标、加载、拖动、缩放、周期切换时重点观察闪烁或抖动。
4. 高低价数字在时间轴下方，不接触K线；窄屏、高低价屏外时仍能读完整数字。

收口条件是本次功能专项通过、范围内审核无未解决问题、用户人工验收通过。PR人工验收前不合并，未部署生产；大容量历史和指标基线问题独立跟进。
