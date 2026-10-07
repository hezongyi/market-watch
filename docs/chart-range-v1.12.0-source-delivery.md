# 范围映射与柱宽同步 v1.12.0 源码交付

2026-10-07。PR [#12](https://github.com/hezongyi/market-watch/pull/12) 已在 `77834e5` 合入main；受测功能提交 `462ffe0`。本次采用兼容新增功能版本1.12.0，Python/web/锁文件根包及CHANGELOG同步；发布整理只改版本元数据与记录，不改受测功能逻辑。

用户授权合并及推tag。附注标签 `v1.12.0` 指向发布整理PR最终main合并提交，以 `git rev-parse 'v1.12.0^{commit}'` 解析实际发布提交，保留旧标签。运行／构建输入摘要见[受测输入](verification/chart-bar-range-mapping/main-integration/v1.12.0-source-inputs.json)，发布边界及候选镜像见[源码清单](../deploy/releases/v1.12.0-source.json)。

范围映射使用来源真实 `[start,end)` 时间区间；标签精确匹配native OHLC，保留极值bar锚点，只左右退避，纵向固定距矩形8px。标签和全部引线避开K线、图例及另一标签，无空间／屏外／未匹配时隐藏，价格轴不因标签改变。原生同步设置提供颜色、透明度、样式与标签配置。柱宽跟随实际发生用户缩放的图表，与日期范围同步互斥。

当前Ubuntu候选 `horizontal-labels1` / `host.c457e1eb70767468.js`：54项/4组浏览器、21项模块通过，无页面异常；真实H1→M5高低价同时显示且低价水平退避，逐帧稳定性与时间关系检查通过。八图工作p95=4.1ms、提交p95=4ms，预算8ms。两轴审核无开放P1/P2，独立覆盖限制见[审核记录](verification/chart-bar-range-mapping/main-integration/review-final.md)。柱宽同步已人工通过；左右标签没有单独记录用户逐项通过，本次合并和tag按用户明确授权执行。

Ubuntu本机入口、准确Compose及启动／停止命令见[验收说明](chart-range-main-integration-acceptance.md)。[本轮原始证据](verification/chart-bar-range-mapping/main-integration/horizontal-labels/README.md)绑定实际候选资产；旧134项候选结果和早期失败保留，计数与当前54项分别记录。候选镜像并非由v1.12.0标签新构建，其版本和来源保持原记录。

本次无新增迁移或依赖；后端及indicators.js与v1.11.0基线一致，大容量历史与指标基线问题独立跟进。本次源码发布保留当前Ubuntu验收实例和unraid生产。生产构建、备份、切换与回退需另行明确授权，并根据实际发布清单实施；源码回退点v1.11.0。
