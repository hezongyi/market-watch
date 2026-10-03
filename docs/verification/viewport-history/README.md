# 原生视窗历史储备验收

实施提交 `5717f81`，基线 `5dd196e`（v1.5.2）。完整要求见
[实施计划](../../native-viewport-history-buffer-plan.md)。生产未部署。

## 结果

完整产品链采用真实许可库 v31.1.0、生产构建网页与 bridge、实际 HTTP API、
独立 PostgreSQL 16 和 OANDA bid 原始 OHLC。EURUSD 的 M5/M15/D1 和 XAUUSD 的
M5/M15 各准备有限 4000 根。没有通知 worker，没有修改生产数据库或布局。

- 单图真实鼠标连续拖动，以及 2/4/8 图非焦点独立移动均通过。每次原生主图绘制
  同时检查可视索引已经存在、左侧六分之一画布有 K 线像素；历史缺口和空白均为 0。
- 2/4/8 图十字线、时间、时间范围分别开启和组合开启均通过。覆盖同周期、
  M5/M15 跨周期、真实鼠标切换焦点、开启同步时切换周期、保存刷新后继续拖动。
  跨周期的每种独立同步单独验证，日期范围同步不能掩盖时间定位错误。
- 十字线检查实际原生时间标签可见、有文本、映射到对应 bar；时间同步检查
  鼠标松手时间定位到 peer 中部；范围同步按实际周期检查两端边界。
  EURUSD/XAUUSD 四图的独立及组合同步也通过。价格不要求跨品种相等。
- 主图增补历史未改变指标、画线、独立图柱距或撤销状态。同步图的 peer 柱距由
  原生拟合范围调整；关闭版相同操作也出现 6 → 5.9333，最终日期范围一致。
- 所有储备 HTTP 响应 mandatory=0、供应商 candles HTTP attempts=[]；D1 before
  使用平台交易日标签。只有普通必需加载可以调用上游。
- 131 个相关后端测试、16 个独立 PG schema 测试、12 组已有 JS 回归、布局保存刷新
  7 组通过。新增储备排队与生命周期回归通过。Ruff、语法、diff 检查和生产构建通过。

[results.json](results.json) 保存精简结果、代码/原始实验文件 SHA256、镜像 ID。
本目录截图显示真实十字线时间/价格标签。原始大规模绘制记录保留在隔离实验目录，
Git 不包含凭据、许可 bundle 或模拟行情全文。

## 异常与体验边界

真实许可库的受控实验补充了网络延迟、失败、空缓存和历史终点；其更早 OHLC
通过重复生产捕获区间构造，属于合成历史，不能当成真实供应商历史。
MA200、M5/D1、1200ms 回调、储备先就绪后连续约 0.8 屏快速拖动：155/160 次
绘制均无缺口。储备未就绪时同样激进拖动曾出现缺口（M5 7 次），如实记录。

首屏优先显示，后台建立储备；远历史未预热、刚加载或突然跨越多屏时不能保证
任意速度无限无感。默认两屏阈值/一屏补充，快拖或慢请求临时升至三屏/两屏，
PG 仍采用 basic1000/depth4000；已加载原生历史不主动裁剪。

审核发现同身份多图失败会接力重试、旧请求失败影响新图预算，现已修复：退避和
失败和空缓存合计四次上限绑定共享原生线程，图窗各自记录移动基准。新图接入或切回已耗尽线程
不会立即重试，实际移动超过四分之一屏可恢复。确定性回归覆盖 8 图、失败和
空缓存、不同图窗偏移、新增图窗、切回旧品种、旧成功/失败、销毁线程。
旧代码运行该测试为红色，修复后绿色。实际 EOD 的受控实验到达数据真实边界后出现空白属于没有更早数据，不纳入无缺口
拖动通过指标；它验证停止在 9 次请求，
静止后不增长；缓存 miss 不当成 EOD。新增真实许可八图共享线程故障实验也通过：
一次初始化 + 四次储备尝试，总计 5 次，静止后保持 5 次，所有 peer 共用相同失败/
空缓存次数。故障实验主动缩小柱距建立不足储备，不把无需求静止当成重试通过。

## 复现

先本地安装许可分发，提供私密 `/tmp/mw-viewport-acceptance/api.env`、`login.json`
（`{ "password": "..." }`）、TLS cert/key 和 `tls.conf`。env 至少配置独立 PG URL、
`ALERTS_DATABASE_APPLICATION_NAME=mw-viewport-acceptance`、关闭通知、独立登录密码
哈希、OANDA token/source；不要把 env 或登录文件提交 Git。compose 使用 raw env
避免 Argon2 哈希中的 `$` 被展开。TLS 443 代理 web，444 代理 chart-origin；本机端口
15743/15744。PG 数据只能用本 compose 专用卷。重建 api/web/chart-origin 容器后
重启 tls 以刷新 nginx 上游容器 IP，避免沿用旧解析地址。

```bash
docker build -t market-watch-api:viewport-acceptance .
docker build --build-arg VITE_ADVANCED_CHART_ORIGIN=https://localhost:15744 \
  -t market-watch-web:viewport-acceptance web
docker build -t market-watch-chart-origin:viewport-acceptance advanced-host
docker compose -f docs/verification/viewport-history/compose.yaml up -d
# 只允许专用数据库，脚本内有环境断言。
docker cp scripts/viewport_history_prepare.py mw-viewport-acceptance-api-1:/tmp/viewport_history_prepare.py
docker exec mw-viewport-acceptance-api-1 python /tmp/viewport_history_prepare.py EURUSD --timeframe M5 --count 4000
# 同法准备 EURUSD M15/D1、XAUUSD M5/M15。
node web/tests/advanced-viewport-reserve.browser.cjs
node web/tests/advanced-viewport-sync.browser.cjs
COUNTS=4 SYNC_PEER_SYMBOL=MWP:XAUUSD node web/tests/advanced-viewport-sync.browser.cjs
node web/tests/advanced-native-reserve-lifetime.cjs
```

测试 browser 脚本的 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 和依赖路径按本机安装指定。
只读诊断 hook 在主图 `_drawSources` 之后观察绘制，不改变行情或原生渲染行为。
非焦点组使用公开时间轴 API；同步组使用真实鼠标，不依靠 API setter 自动补历史
来冒充真实拖动效果。新增请求排队脚本从 `web/` 执行。

## 构建与关闭

许可 bundle 原始 SHA256 固定为
`114428b8dde6eb137fd7ef3bc20ef35882189186c4bd092bb743b64d11682be1`。
未知分发、部分安装或锚点不唯一拒绝安装；完整安装幂等。关闭恢复后的 SHA256
与原版逐字节一致，关闭镜像 host 标记为 false。

```bash
# 推荐完整关闭：还原原生 bundle 并关闭宿主策略。
docker build --build-arg NATIVE_RESERVE_ENABLED=false \
  -t market-watch-chart-origin:viewport-disabled advanced-host
# 本地还原；不发布该文件。
node advanced-host/patch-native-reserve.mjs --disable
```

仅运行时关闭可在 chart-origin URL 加 `native_reserve=off`；构建默认启用。
升级后端 API 后再启用 chart-origin；旧后端缺少 `/reserve` 会按有限失败退避退出，
不会用旧 API 忽略字段后扩大 mandatory 的方式请求上游。
