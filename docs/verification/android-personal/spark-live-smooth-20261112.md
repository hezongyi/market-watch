# 自选走势末点更新与像素简化

> 历史记录：本次的按图宽减少折点和圆滑曲线已按用户要求回退，当前形态及保留功能见 [折线恢复验收](spark-lines-restored-20261112.md)。

分支 `feat/android-personal-v205`。F0 兼容的前端行情展示与加载生命周期修复，无后端、schema 或持久格式变更。用户认可后实现，未操作 Unraid、PR 或 CI。

问题复现：旧页面一次实盘观察中，右侧报价在约 24.4 秒变化，走势历史在约 71.5 秒才返回更新，相差约 47 秒。历史轮询在历史准备完成后再等 60 秒，实测请求间隔约 69 秒。M5 显示采样已生效，但全天外汇窗口中相邻点约隔 0.8px，固定 M5 点数不足以改善密集折角。

修复：

- 当前交易日已存在的曲线叠加同品种、同组合修订的有效报价末点，仅供绘图，不改写历史或其本机缓存。准确报价用 `quote_time`，来源 M1 或组合 M1 采样用 `data_start`，不使用 `read_at` 伪造事件时间。上一交易日、固定历史、日线报价、无时间戳、过期/未来/较旧报价、会话冲突与修订不匹配均不叠加；跨缺失分钟仍分段。
- 快照返回后即安排下一次历史轮询，历史准备拥有独立的去重队列，最多两个并发；观察轮询不取消正在进行的准备。切后台或自选页隐藏时取消历史任务；导航仍保留已实现的报价订阅。
- M1 原数据保留，继续以 M5 显示代表点为基础，按实际 CSS 图宽简化。以约 3px 顶点间距为目标，简化阶段容许误差最多 2.2px；每段端点和 M5 代表点中的最高/最低点优先保留，显著尖峰可突破密度目标。随后使用单调三次曲线，控制点限制在每对端点的价格范围内，避免圆滑造成过冲。72px 行高、50px 图高、固定时间窗、未来留白、参考线和配色保留。

回归：`node tests/mobile-watch.browser.cjs` 的新用例先在旧构建上失败（收到报价后两秒内 SVG 不变化），修复后通过，并验证末点更新不产生额外历史请求。`node tests/mobile-sparklines.cjs` 覆盖时间戳边界、原始数据不变、缺口、上一交易日、修订、缺失历史空态、三次曲线控制点无过冲、两次观察期间历史继续且去重。`mobile-transport.cjs`、`mobile-watch-a07.browser.cjs`、前端生产构建和 `git diff --check` 通过，无页面错误。完整页面包括 375/412、深浅主题、大字号、横屏、下拉刷新与状态检查。

同一份实际行情回放对比：黄金折点 78 → 35，EURUSD 101 → 43，GBPUSD 103 → 52，USDCAD 95 → 56，USDJPY 113 → 55，NVDA 57 → 46，AAPL 56 → 36。对比图使用同一窗口和同一数据，未拉伸时间坐标。见 [前后对比](a07-feedback/spark-live-smooth/comparison.png)。

Ubuntu 本机 `quant-server`，既有隔离项目 `mw-android-personal-v205`，地址 <https://192.168.7.232:18445/m/>。资源预检可用内存约 8GiB、磁盘约 18GiB；只更新 web，API/数据库保留。通过 `mw-docker build --repo . --component web --context . --file web/Dockerfile --tag market-watch-web:android-personal-v205-spark-live-smooth --task mw-android-personal-v205 --project mw-android-personal-v205 --purpose acceptance` 构建，固定镜像 `sha256:587fcee9e9ffa3ce1b6b19ff432e08f82793db6208e3bea4081dde87d064cda1`，shell `04f4b7638075c509`。HTTPS CA 校验 `/readyz` 返回 ready，新 shell 已提供。

私有配置目录 `/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/`，原配置备份 `before-spark-live-smooth-run.json`（0600），旧镜像保留。更新/启动：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止（未执行）：同参数使用 `stop web`。回退（未执行）：第一个配置改为同目录 `before-spark-live-smooth-run.json`，再执行相同 up 命令。

实盘浏览器已观察到有效新报价与曲线在同一次 DOM 提交中变化，发生在下一次历史观察请求之前；本轮 EURUSD、GBPUSD、USDJPY 的来源 M1 时间戳均为 `1794491460000`，历史尾端为 `1794491400000`，报价变化时曲线同步改变。375/412 × 深浅主题四组截图与布局通过，7 行仍均为 72px/50px，无页面错误。证据见 `a07-feedback/spark-live-smooth/live-proof.json`。浏览器验证不能代替 Android 手机 WebView 的实际观感和系统调度验收；手机从“更多 → 检查更新”取得此版本。
