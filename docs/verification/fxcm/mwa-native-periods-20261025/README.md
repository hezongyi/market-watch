# FXCM 原生周期、目录搜索与图表修复

候选：`integration/fxcm-mwa-20261025`，基线 `8dd4faf2` 加工作树集成差异，产品文件摘要见 source-identity.json。F0：兼容供源及 UI 变更，无 schema 迁移。用户已授权更新 mwa。

## 修复与证据

- FXCM 会话能力显式刷新后维护在本地账户目录（517 项）。搜索、metadata 不登录、不下载 K 线；去除搜索路径 seed、无关来源扫描和重复凭据读取。
- 接入系统全部 9 个原生周期：M1/M5/M15/M30/H1/H4/D1/W1/MN。FXCM 小写 m1 对应分钟，大写 M1 对应月线。两品种真实 helper 及已部署 API 18 项全通过，见 native-session-samples.json、http-periods.json。
- 切源遇不支持周期时通过图表公开方法切换可用周期，并校验延迟回调仍属于当前图表。H4 切 FXCM 现在真实显示 K 线。
- 原生搜索和添加商品复测首批结果 629/239/216 ms；原实测为 5680/8230/5633 ms。成功首页本地缓存 5 分钟，空筛选值归一，目录管理操作清缓存；分页仍取下一页，错误不缓存。见 dialog-timing.json。
- 来源/类型筛选、黄金/空查询/无匹配通过；隔离浏览器注入 HTTP 500 能结束加载，实际重试恢复结果。见 search-filters.json、search-error-regression.json。
- 冷快照以实际响应观察时间判新鲜；近期尾部覆盖允许先补必需历史，避免未来留白反复触发尾部请求。FXCM 新鲜度与其至少 60 秒的有限快照轮询一致。
- 149 项后端关联测试及 5 项 JS 专项通过，Ruff/JS 语法通过。测试包含冷登录超过 TTL、未来查询留白、缓存过期/筛选归一/分页/取消、过期切源回调。详见 automated-tests.txt。
- OANDA H1 实际 20 根兼容通过，见 compatibility.json。黄金 M1/H1/MN 原生界面均 dataReady，见 ui-periods.json（此记录为 r5；最新 r6 图表记录另列）。

## 构建与运行

Ubuntu quant-server，现有 Compose project `mw-issue75-v2-20261018`；入口 <https://test.kookvv.com:8443>，图表 <https://chart-test.kookvv.com:8443>，正常 TLS 校验及真实表单登录已通过。

API、Chart、Web 全部由 mw-docker build 显式 task/project/purpose 构建；后续仅重建修正组件。实际最终镜像见 candidate-images.json、运行容器见 runtime.json。SDK、helper、凭据及回退配置留在私有目录，不入库。旧镜像/helper 保留。

运行管理：`python3 /home/quant/repos/.mwa-fxcm-20261025/operate.py start|stop|status`。不用此脚本旧 update/audit；本轮独立 audit 已同步当前 candidate 与统一 manager。

## 数据与已知限制

- 无迁移、清库或业务数据重置。PG/gateway 身份、原配置及资源限制保留，后端仅 helper 挂载源更新；浏览器 profile 不动。原工作区 17 项仍在，告警、模板、schema 与原通知状态核对见 runtime.json。
- 验收路由最初漏拦截 `/advanced-charts/native-charts/save`，3 次图表自动保存改变了当前工作区的选中项及视图，已修正路由。使用正常 API 版本校验恢复测试前已确认的 USDOLLAR FXCM／日线选中项，其余当前字段保留；完整原视图没有快照，不能宣称工作区内容哈希完全未变。见 workspace-selection-restored.json。未以猜测恢复整份布局或覆盖其他人工改动。
- 首次 FXCM 请求仍受冷登录、供应商响应和全源串行额度/冷却影响。r5 实测 H4 有一次 65 秒等待超时后重试成功，不能把接口 200 或最后显示等同于首次性能全部通过。最新 r6 实测另列，保留前次失败记录。
- 月线 DST 同标签可能含两个原生分片，仅以 PreviousClose 唯一连续链合并同月，并保留分片；歧义明确失败，不用日线重采样冒充原生月线。额外旧史探针发现黄金 2009-08-31 原生 OHLC 不合法，保持校验失败，不改写来源价格；本次不认证全部远古历史。

人工清单：[manual-acceptance-mwa.md](../manual-acceptance-mwa.md)。所有未完成的人工检查保留未勾选。

## 本轮收口决定

用户要求本轮先收口，FXCM 首次加载性能后续处理。全部功能修复已部署到长期验收实例；最新 r6 黄金 H4 切源真实显示，整次 41.326 秒，上游一页 26.733 秒，见 chart-xau-h4-r6.json。此项只代表能够显示，不代表性能目标通过。目录搜索、9 周期取数及兼容检查通过。人工验收仍待用户执行；不继续开展本轮性能优化。
