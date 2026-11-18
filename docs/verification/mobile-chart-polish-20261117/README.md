# 手机专业图表加载与使用体验（2026-11-17）

## 任务与边界

用户认可手机加载边界分析并授权实施、打磨和验收。基线 main `1f2005c3`（v2.0.14），工作树 `market-watch-mobile-chart-polish-20261117`，分支 `feat/mobile-chart-polish-20261117`。

风险 F0：手机端兼容的 UI、预热调度及诊断。没有数据库迁移、后台采集、历史预取量或历史结果协议变更。共享 runtime 的新增消息只在 mobileMode 分支运行；`mobile-chart.js` 仅由手机分支调用。网页工作区、偏好存储与增强指标窗口仍走原入口。

## 已实现

- 预热成功后才记录完成，失败与后台取消不再永久跳过；下一次空闲生命周期允许重新准备。不添加无界重试，保持最多两个候选、串行准备、前台优先与后台暂停；不把自建行情发送到原生预热协议。
- 首次无预览显示主题一致的 Skeleton 工具栏与安静占位；有匹配旧图时保留上次画面，明确标识时间；原生工具栏可用后立即露出。品种、周期、主题、布局和用户/服务器隔离沿用既有规则。
- 预览顶部按真实原生工具栏测量，避免默认高度造成交接错位；新增周期匹配与显示完成的主题检查。
- 长请求用轻量原位状态，历史失败提供数据重试，保留同一 widget。加载反馈的延时基于忙闲切换，多个历史请求交接不会反复重置提示延时。
- 本机图表文档保存失败显示就地重试入口，正常保存与运行反馈不弹顶部浮窗。普通反馈及加载阶段耗时进入“更多 → 日志”。
- 十字线保留原生图标和 38px 工具栏高度，将宽度增至 44px；保留周期 → 十字线 → 指标 → K 线类型顺序，增加短按反馈并尊重减少动态效果。
- 新增只在手机入口加载的耗时记录：本机设置、资源、配置、历史请求与返回、工具栏、首帧。保留最近 30 次诊断，不记录凭据或布局内容。

预览仍是静态截图，不能作为可交互历史，也不伪装成当前数据。冷目标仍使用整份历史 result；没有实现后端“可见范围满足即提前交付”。

## 两轮截图审查

第一轮 `round1/`、`review1/`：加载态已有清晰层次；尺寸检查发现 44px 高按钮被 38px 原生栏裁切，预览默认 46px 顶部也不准确。

第二轮 `after/`：恢复原生高度、保留更宽目标，实测按钮 y=0、宽44px、高38px，完整处于栏内；预览按真实栏底对齐。覆盖375/412px、深浅主题、14/21px根字号；另检查读取失败、保存失败及旧图过渡。

## 本地验证入口

在 `web/` 运行（先完整构建，使用本机已有固定许可图表库）：

```bash
npm run build
node tests/mobile-chart-preparation.cjs
node tests/mobile-chart-resume.cjs
node tests/mobile-cache.cjs
node tests/mobile-logs.cjs
node tests/chart-theme.cjs
node tests/advanced-chart-style.cjs
MOBILE_CHART_POLISH_ONLY=1 node tests/mobile-chart.browser.cjs
MOBILE_CHART_BENCHMARK_ONLY=1 node tests/mobile-chart.browser.cjs
MOBILE_CHART_ISOLATION_ONLY=1 node tests/mobile-chart.browser.cjs
node tests/mobile-chart.browser.cjs
node tests/mobile-chart-resume.browser.cjs
```

- 浏览器使用真实许可 widget 与明确的 HTTP 测试夹具；不能代表供应商响应或 Android 真机。
- 修正旧测试末尾对已改版数据页的耦合，改为直接准备本机选品后验证图表目录错误重试；未恢复旧提示或改动数据页来迎合测试。
- `benchmark/timings.json` 为连续5次受控观察：重载首帧中位836ms、最慢1136ms；导航返回112/172ms；10次周期切换75/95ms。受控即时响应、缓存状态由测试决定，不能用来承诺实盘秒数或声称同比提速。
- 网页设置与布局的写测试使用独立 fixture，不修改真实用户工作区。

## 开发实例验收

目标为 Ubuntu 本机 Docker 持久实例 `mw-dev`，手机入口 `https://192.168.7.232:18443/m/`。仅替换 Web 容器，保留 API、采集/数据/通知 worker、Postgres、ntfy、TLS 和持久 APK 下载挂载。

已通过本机可信 CA 验证 readyz、手机入口、Web 更新清单和 APK 更新清单；APK 实际下载大小及 SHA256 与清单一致，不存在的 APK 返回404。更新清单 `no-store`，部署内容与本地构建 manifest 相同。

- Web 镜像：`sha256:6b7dce8d4ac30d731da71dd8866a9af04e315886647086533be2c9d494f09580`。
- 回退镜像：`sha256:cc312beed291b887f22ec52f35623613660475c0c35e2f547fb4c2126b8eb036`。私有配置留档在本机 `~/.local/share/market-watch-dev/updates/mobile-chart-polish-20261117/`，不提交凭据。
- 启停入口：`mw-dev up` / `mw-dev stop`（日常使用入口不变）；本次只执行同 project 的 Web 单服务重建。回退时将持久 run.json 的 `services.web.image` 恢复上述旧 digest，再单独重建 Web。
- 后端等其余服务容器 ID、镜像、启动时间均未变；真实网页端12项偏好、1份工作区的读取指纹在部署及浏览器核验后仍一致。

实盘浏览器在真实 XAUUSD 自建行情上验证：初始 H1 60根，当前 M5 未完成 K 线收盘价连续变化（3882.995 → 3883.355 → 3883.415 → 3883.515）；导航返回、断网恢复、后台回前台保留同一原生 widget 和已有 K 线。原生指标窗口打开及返回关闭正常，没有写入网页偏好或工作区。实盘证据见 `real/proof.json`，对照界面见 `real/ready.png` 和 `real/indicators.png`。

本次单次实盘首帧2281ms，随后缓存已热的 M5/H1/M5 切换观察为227/49/41ms；这些是当前环境观察，不是手机或供应商延迟承诺，也不是与旧版的性能对比。自建历史不经过 native-load 消息，因此其诊断只记录就绪阶段；没有另加共享 loader 埋点。

自审与截图/交互检查通过。验证使用桌面 Chromium 的手机视口；Android 真机触摸、前后台与系统行为仍需用户验收。本任务不合并 main、不打正式 tag、不发布 Unraid。现有 APK 可通过“更多 → 检查更新”获取本次 Web 更新，无需重装 APK。
