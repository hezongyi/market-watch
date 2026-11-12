# A07 首轮真机反馈与 APK 0.1.2

后续系统栏黑边与提示移除已交付 0.1.3，当前版本见 [系统栏修复记录](ui-a07-system-bars-20261111.md)。本文保留前轮验证历史。

用户认可执行导航/安全区/Sparkline/真实数据反馈，随后追加“APK 加网站白底 logo；更多里手动更新”。本轮实现上述范围，PR、CI 保持暂缓。兼容的前端与原生能力扩展（F0），无后端 schema 或持久数据格式变更。

## 已实现

- 底部五个图标全部使用此前图表页的 Lucide 图标；各页一致。底栏常规高度由自选页的 73px 降至 64px，底部内边距减少；以 ResizeObserver 测量实际导航高度，避免大字号与安全区下的内容遮挡。
- 自选页头从 88px 压缩至 64px（默认字号），上下边距 4/6px；大字号仍独立换行。
- APK 明确 edge-to-edge，由原生容器只计算一次系统栏、刘海和键盘空间，向 WebView 消费 insets。此前容器加 padding 后仍下传 insets，有重复留白风险；具体 Find X8 像素效果尚待重验。没有通过负 margin 遮盖系统栏。
- Sparkline 使用既有只读缓存接口，显示加载中、暂无日内数据、走势不可用、失败、离线无缓存；已有曲线在离线/刷新失败时标“缓存”。保持固定日界线、缺口和未来时间留白，不补造走势。每行失败独立展示并按既有周期重试。
- 真实品种暴露的长来源改用规范短名称（Binance、Yahoo），长名称省略，完整文本仍在 DOM/行详情描述中；Yahoo 延迟说明独立放置，避免挤高列表。关闭浏览器滚动锚定，避免异步行情文本把显式保存的滚动位置移动。
- 新 APK 0.1.2 / versionCode 3，网站浅色 Waves 标志 + 白色 adaptive icon。同签名可覆盖旧版。
- “更多 → 检查更新”：检查网页及 APK；支持新版说明、下载进度、取消、校验和系统安装。仅当前可信 HTTPS 同源固定目录，禁止重定向、路径越界；校验字节数、SHA-256、包名、递增版本、安装签名。FileProvider 仅暴露更新缓存目录；系统授权/安装确认由用户完成。0.1.1 需手动覆盖安装一次，之后可用新入口。

## 真实数据与运行环境

Ubuntu `quant-server` / `192.168.7.232` 本机 Docker，仍是 `mw-android-personal-v205` 独立 project、PG、volume 和网络。开始时可用磁盘约 34 GiB、内存约 8.8 GiB、5 分钟负载 1.67；增加一个 768 MiB / 0.6 CPU 的任务专属 data-worker。API 与 data-worker 显式连接本任务 edge 网络以访问供应商，PG 留在 internal 网络。其他任务及 Unraid 没有修改。

用户已授权接真实数据，本次仅复制既有本机开发环境的供应商代理路由到任务私有配置；未复制 OANDA 账户凭据或其他数据库配置。开启 Yahoo，Binance 使用公开直接连接；通知投递仍关闭。沿用现有数据运行程序、API 镜像；关闭此验收任务的自动切换与保留清理。

新增分组“真实行情 · UI验收”：BTCUSDT、ETHUSDT（Binance），EURUSD、黄金期货 GC=F、QQQ（Yahoo）。通过真实供应商读取函数填充任务 ProviderBar 缓存，再由现有订阅/data-worker 更新。原 D1 分组和桌面当前分组字段保留。首次准备误用进程内缓存读取，已改用正常持久化缓存读取；没有更改 Sparkline API 的只读语义。

五个品种均读到当前窗口的 M1 点；BTC 验证距离采集时刻不足 3 分钟，说明不是一次性静态灌数。Forex 以纽约 17:00 起算，当时新窗口刚开始，左侧短曲线为真实时间分布。GC=F、QQQ 当时分别标注延迟 30/15 分钟；不把 Yahoo 延迟报价声称为无延迟实时数据。完整时间、点数见 `a07-feedback/real/proof.json`。

地址：<https://192.168.7.232:18445/m/>。网页构建 `b5adb77e34e474b2`。

APK：<https://192.168.7.232:18445/downloads/market-watch-0.1.2-debug.apk>，2,345,146 bytes。

SHA-256：`1ab257cd1d876877200cac07518712f713ceb8f08c321a9f1d8d7bf8d873124c`。

签名证书 SHA-256：`ca8ee3bd68d2aa412119ea53b15f5393b3a2a9e57aea30f68f2e25b450e9fd33`，与已交付 0.1.1 相同。交付清单见 `a07-feedback/apk-release.json`。

### 当前启动/停止入口

接入真实供源后使用显式 task 私有 overlay；**此前仅允许 TLS 出网的通用 `preview up/status` 不再适用于此运行形态**。其余任务仍使用原入口，不放宽全局隔离检查。原离线配置保存在任务私有 `a07-before-live-run.json`，本次没有重置数据库。

```bash
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --wait

# 使用相同的前缀与两个 -f，将最后一行替换为 ps 或 stop。
```

Web 镜像仍通过 `mw-docker build` 指定 task/project/acceptance 构建并以实际 image ID 固定到 run.json。不要提交私有 compose、proxy、凭据或完整浏览器状态。脱敏运行记录见 `a07-feedback/deployment.json`。

## 验证

- Android assembleDebug、lintDebug：0 errors；14 warnings（已有资源化/图标兼容/版本建议等），没有使用 lint baseline。
- JVM 更新清单测试：4 项通过，覆盖跨域/路径、包身份、版本、大小与摘要边界。
- TypeScript + Vite + mobile shell 完整构建通过。
- 自选行为回归、迷你图窗口/取消测试通过；8 组深浅/宽度/大字/横屏检查通过。增加空态/失败/离线缓存、导航图标一致性、更新桥接和壳版本保留检查。
- 实际隔离后端：登录、SSE、五种真实走势、375/412 布局、搜索缩小视口、分组/管理、更多更新入口通过；无 pageerror。实际 DOM/截图证据在 `a07-feedback/real/`。
- Python 系统 SSL 使用任务 CA 验证证书链/主机名；readyz 200；线上清单 no-store，APK 长度与 SHA-256 等于本机构建。新旧签名相同。

## 尚待手机确认

ADB 没有连接设备。需要用户覆盖安装 0.1.2，核对顶部/底部位置、系统栏、软键盘与返回、启动图标、保留已有登录/服务器设置，以及“更多 → 检查更新”显示最新版本。下一次版本升级仍需真机验证下载取消、未知来源授权、安装确认和保留数据；当前同版本检查不会强行重复安装。未宣称已完成原生安装链路或所有页面视觉验收。
