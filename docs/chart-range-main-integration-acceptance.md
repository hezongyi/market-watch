# 范围映射、同步设置与柱宽同步：main 集成验收

2026-10-07（Asia/Singapore）。隔离 worktree `/home/quant/repos/market-watch-range-main`、分支 `feat/range-sync-main-integration`；原功能提交 `80611cb` 与 main `826d316` 在 `96709e8` 整合，功能修订 `fd4dcad`。当前范围收口提交 `31e1e39` 撤回额外的 Python 指标及后端计算修复；后端源码和 `advanced-host/indicators.js` 与 main 基线一致。原 v1.8.0 验收实例与[历史验收记录](chart-range-v1.8.0-acceptance.md)保留。

## 本次交付范围

- “K线范围映射”改为“范围映射”；布局菜单末尾“同步设置”集中配置范围映射、样式、颜色、透明度和高低价标签。恢复最初淡蓝色：Dark `#5A91FF` / 82% 透明，Light `#2962FF` / 88% 透明，可自定义。高低价显示在矩形外侧对应真实极值 K 线的位置，标签只向左／右找空位，保持上下高度；标签与引线都避开 K 线、图例；屏外、未匹配或无空间时隐藏。使用原生 NoticeDialog 和控件皮肤，入口正常文字颜色且与菜单对齐；两个同步开关旁的原生说明图标支持悬停、键盘提示，说明操作不切换开关。
- 柱宽同步跟随实际接收用户横向缩放的图表：鼠标所在图滚轮、原生按钮、快捷键等改变柱宽时，其他就绪时间图跟随，不要求预先切换焦点。仅开启、切换焦点或程序恢复不主动传播。
- 柱宽同步与日期范围同步互斥，开启一项后另一项禁用变灰。工作区保存、刷新与重开保留设置。
- 与 main 的绘图投影、告警图表身份和工作区保存兼容；异步捕获期间 epoch/editRevision 改变拒绝陈旧写入。

大容量历史更新、指标前缀修订和后端性能修复不属于本次任务。发现的基线问题见[独立跟进记录](chart-range-main-baseline-followups.md)，不作为本 PR 的收口条件；若本次范围/同步改动引入回归，仍须修复。

## Ubuntu Docker 隔离实例

实际主机 Ubuntu `192.168.7.232`，Compose project `mw-range-main-20261006`。应用：<https://192.168.7.232:16843/advanced-charts>；图表来源：<https://192.168.7.232:16844>。独立网络、volume、数据库 `range_main`；PG14仅绑定 `127.0.0.1:16832`。原 `16743/16744` 实例保留，unraid 生产环境未改动。

运行 API `mw-range-main-api:candidate1`、图表 `mw-range-main-chart:horizontal-labels1`，图表资产 `host.c457e1eb70767468.js`。部署恢复后 API 健康，22 个宿主 JS 模块逐字节匹配当前源码。私有 Compose、env、TLS、登录信息在 `/home/quant/repos/.acceptance/range-main-20261006`，不提交。自签证书首次分别访问两个地址接受证书；通知仅连接内部验收 sink，不发送真实通知。

```bash
sg docker -c 'docker compose --env-file /home/quant/repos/.acceptance/range-main-20261006/compose.env -f /home/quant/repos/.acceptance/range-main-20261006/compose.yaml up -d'
sg docker -c 'docker compose --env-file /home/quant/repos/.acceptance/range-main-20261006/compose.env -f /home/quant/repos/.acceptance/range-main-20261006/compose.yaml stop'
```

## 自动验证

历史证据：已完成候选2范围/同步169项、14组，均绑定 `host.d0a96d61fcfcc340.js`，无页面异常；[原始汇总](verification/chart-bar-range-mapping/main-integration/summary.json)保留原候选结果。撤回范围外修复后，同候选的同步设置31项、逐帧稳定性9项、映射39项、生命周期6项、导航8项共93项/5组全部通过，未记录页面异常；[最新汇总](verification/chart-bar-range-mapping/main-integration/scoped-final/summary.json)单独归档，不覆盖旧证据。

恢复部署后的逐帧稳定性9项通过：真实 provider W1/M5/H4/D1，M5保留89,199根走廊，最新行情采集303帧、静止鼠标历史加载采集118帧，检查K线像素、model/chart身份以及来源、公开光标、日期标签。时间按来源真实 `[start,end)` 验证；周线标签日期可以与实际纽约17点交易周开始时间不同，小周期十字线时间须落在同一真实区间，跨周期标签不要求文字相同。有限采样不代表任意设备、任意操作绝无闪烁。

旧布局迁移使用2万根容量；导航维持20万根和原目标日期，等待预算180秒，其他组默认60秒。未降低定位、就绪或时间断言。四图容量边界已通过，作为范围映射可达边界检查，不扩展为历史更新修复。

main 集成检查点另已完成后端586通过/46跳过、真实告警8项、MCP SDK15检查/13工具、chart→PG→MCP→刷新6项。这些是原候选的兼容证据，不将指标或历史完整组合失败写成通过；此次不重做无关整链。用户指定 gpt-6.1-sol/max 的 Spec/Standards 审核记录见[复核记录](verification/chart-bar-range-mapping/main-integration/review-final.md)。

## 当前左右退避候选

用户选择矩形外框后，价格轴标签和底部信息栏均已撤销；没有 priceAxisViews/optimalWidth 包装、轴迁移处理或绘图/指标新增。映射仍使用真实 `[start,end)` 区间；只有目标 native OHLC 与 accepted metadata 的极值精确相等时才锚定，避免把相差一个有效 tick 的价格当作同价。标签及短引线独立检查所有可见 K 线与图例的碰撞，保持真实极值 bar 锚点。最新修订只向左／右退避，标签与矩形边界的纵向距离固定为8px；选择最近安全空位，直角引线仍指向原极值 bar，不做上下移动。正常/对数/百分比/Indexed/反向轴只读原生坐标，不写轴配置。

本轮证据归档于 [horizontal-labels](verification/chart-bar-range-mapping/main-integration/horizontal-labels/summary.json)，绑定 `host.c457e1eb70767468.js` 与 `horizontal-labels1`，22个JS模块和CSS匹配运行资产。几何13项、逐帧稳定性9项、同步设置31项、真实左右退避1项，共 **54项/4组浏览器检查**通过，无页面异常；外框模块 **21项**独立计数。八图60秒采样2799帧，1800次标签绘制、7个目标pane，新增工作p95=4.1ms、提交与after-rAF延迟p95=4ms，每目标每帧setter最多1次，均在8ms预算内。

真实 BTCUSDT H1→M5 额外补测中，三个目标图高低价均同时显示，其中两个低价标签分别左移约12.08px和20.81px；上下位置固定，真实极值bar锚点、全部引线、标签与K线／图例／另一标签的碰撞断言通过。[真实退避截图](verification/chart-bar-range-mapping/main-integration/horizontal-labels/horizontal-retreat.png)与完整坐标证据同时归档。测试使用原生时间／价格可见范围准备场景，未伪造行情或障碍；产品hover不会调整轴。最初D1→H1探针未找到“两标签＋退避”的样本，其记录作为诊断保留，不计入通过数。

### rectangle-ui8 历史矩形外框验证

历史证据归档于 [rectangle-ui](verification/chart-bar-range-mapping/main-integration/rectangle-ui/runtime-ui8.json)。ui8 同步设置31项、逐帧稳定性9项、鼠标下拉/原生弹窗6项、菜单8项、保存恢复等扩展20项已通过；八图真实标签60秒采样2940帧，标签绘制1727次、7个目标pane，新增工作p95=3.7ms，提交延迟p95=3ms，每目标每帧setter最多1次。最新／静止历史分别采集299／108帧，K线像素、图表身份、十字线时间与标签稳定检查通过。外框模块17项通过，涵盖高精度tick和完整引线碰撞。原生几何13项已在ui8复验，历史169/93项不计入新镜像通过数。

[诊断记录](verification/chart-bar-range-mapping/main-integration/rectangle-ui/diagnostics/)保留较早并行采样性能超预算、静止标签一次消失、保存/历史请求及fixture超时；对应的单独ui8复测结果不覆盖失败历史，也不宣称已查明所有旧采样触发原因。导航8项已通过；映射39项也已通过，最终共134项/8组浏览器检查，无页面异常；17项外框模块独立计数。

## 人工验收与收口条件

四图工作区 **main 集成：范围映射与柱宽同步验收**：W1/M5/H4/D1，Dark，范围矩形、高低价标签、时间与柱宽同步开启，日期范围同步关闭，容量200,000。自动准备与重开检查不等同于用户验收。

1. 保持焦点不变，在另一图滚轮缩放，确认其他图柱宽跟随；再试原生缩放按钮和快捷键。只切焦点或开启同步时不主动统一。
2. 布局末尾打开“同步设置”，检查柱宽/日期范围互斥、颜色和透明度，保存后刷新重开。
3. 指向历史周线，确认小周期十字线时间在来源周线真实区间内，范围映射边界正确。静止鼠标、加载、拖动、缩放、周期切换时重点观察闪烁或抖动。
4. 在同步设置选择“高低价矩形”并开启外侧高低价。指向较大周期已完成 K 线，确认小周期标签对应真实高／低极值 bar、正常轴上高下低；遇K线／图例只向左或右退避，上下不移动，引线对应原极值bar；窄屏或屏外无合法空位时隐藏。价格轴的位置、宽度和缩放不应因标签改变。

柱宽同步已由用户人工验收通过；本轮范围映射外观、原生设置与外框高低价标签仍待用户人工验收。

收口条件是本次功能专项通过、范围内审核无未解决问题、用户人工验收通过。PR人工验收前不合并，未部署生产；大容量历史和指标基线问题独立跟进。
