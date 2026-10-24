# D1 历史绘图边界堆叠修复

用户报告 OANDA EURUSD D1 的旧信号挤在 2023-07-12，更早没有图形。F0：兼容的前端绘图投影修复，无 schema、持久格式或计算算法变化。本文件兼作本地 Issue 草案；未创建外部 Issue/PR。

原生绘图工具会将未加载价格范围的日期吸附到已加载边界。RRS 原先直接画全历史 snapshot，且其重绘签名不包含价格加载范围，所以补载后没有恢复原坐标。

现在从原生 mainSeries 读取实际已加载 K 线首尾时间：范围外标签和矩形暂缓绘制，跨边界矩形裁剪到已加载部分。范围变化加入重绘签名，加载更早 K 线后从完整 Python presentation 恢复原始端点和标签；未变化对象复用原生 ID。不是按可见视窗过滤，也不使用可能仅保留近期指标响应的 record.bars。固定 v31.1.0 私有接口与本仓库 bar-range-mapping 已用接口一致。

## 验证

- 新回归旧实现失败：`unloaded old labels must not pile up at the native boundary`，2 != 1；修复后覆盖范围裁剪、prepend、eviction、旧 ID 复用、隐藏恢复与销毁。
- `node web/tests/squeeze-history-display.cjs`、`squeeze-contract.cjs`、`indicator-runtime-contracts.cjs`、`nr-breakout-display.cjs` 均通过。
- `node web/tests/squeeze-native.browser.cjs` 实际许可库的几何、样式、颜色、回滚、隐藏、模板、多实例、保存排除及窄屏通过。该 fixture 先加载完整价格区间，再核对全量 snapshot。
- 原始部署资源、无源码注入、无强制重绘：平台 OANDA EURUSD 默认 10/252/5%/收盘确认，逐个比较原生框/标签的时间与价格，包含裁剪后的矩形端点。页面异常 0；隐藏/恢复/删除及 H1/H4 控制通过。

| 场景 | 框 | 标签 | 实际坐标核对 |
| --- | ---: | ---: | --- |
| d1-initial | 27 | 16 | 通过 |
| d1-july-2023 | 62 | 37 | 通过 |
| d1-2021 | 81 | 49 | 通过 |
| d1-2019 | 105 | 62 | 通过 |
| d1-return-recent | 105 | 62 | 通过 |
| d1-restored | 105 | 62 | 通过 |
| control-60 | 12 | 7 | 通过 |
| control-240 | 2 | 1 | 通过 |

截图 `browser/d1-july-2023.png` 已目视检查，旧标签分布在实际信号日期，没有边界堆叠。提供商历史补载扩大了后台 snapshot，不能以先前 81/49 的固定计数判断后续完整历史；必须逐个对照当前加载范围。最初探索请求从 2019-04-10 开始的大视窗触发原生 setVisibleRange timeout；保留失败记录，后续实际覆盖 2019 年的视窗与逐项坐标通过，不把超出当前加载范围的暂缓图形计为缺失。没有执行 TradingView Pine 或全量后台套件。

## 实例与保留

Ubuntu quant-server，现有 `mw-issue75-v2-20261018`；入口 https://192.168.7.232:18280 ，Chart https://192.168.7.232:18281 。产品 `bacbcd7d9ea0eea7beab82252bb2f32b925aef96`，镜像 `sha256:d43f9949bc8ed2b4df8cad7bad4ae26df026605d43d0caff3982f16196b7d8cc`；只替换 Chart，保留当前 API b4e1326a / workers 8b7ee3ee / Web 970a2550，以及已验收 NR 连续性与偏好草稿修复。

15 服务运行、API/PG healthy；环境、挂载、端口、网络、资源、重启策略、其余容器与保护浏览器身份/启动时间保持。六张保护持久表全行哈希、原 23970 条通知状态及 7 条手机确认保持；新增 1 条正常通知。平台历史读取可以按既有流程补入缓存，不声明行情缓存静止。临时浏览器拦截工作区/偏好/通知持久写入，未修改用户图表现场。

API 窗口 13 个 traceback、26 处 CancelledError，HTTP500/连接池超时 0；不声明全栈零异常。未迁移、seed、清库、push、PR、main 合并、生产发布或操作 Unraid。

统一运维：`python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`。本次审计：`python3 /home/quant/repos/.mwa-rrs-drawing-history-20261024/operate.py audit`；精确旧 Chart 镜像及配置回退在 `/home/quant/repos/.mwa-rrs-drawing-history-20261024/rollback-override.json`，未执行。durable overlay 已同步。

原始证据 `/home/quant/repos/.reports/market-watch/20261024-rrs-drawing-history`，结构化结果见 [summary.json](summary.json)。
