# 手机图表：真实画面恢复与错误收口

2026-11-17；分支 `feat/mobile-chart-continuity-20261117`，基于 `5a776433`，保留已部署的 ntfy 默认手机推送等功能。

## 范围与结果

分类 **F0**：兼容的手机 UI/读取缓存改造。沿用 IndexedDB `mw-mobile` v2、已有 origin/subject/schema 分区，新增可丢弃的 `chart-history` 记录，无服务端 schema 或业务数据迁移。旧客户端不依赖该可选记录；回退后可继续正常读取行情。

- 删除上次截图的显示、采集和定时存储，启动时清理旧 `chart-previews`。已有截图不再参与图表启动。
- 有足够的本机真实 K 线时，原生 widget 直接绘制可操作图表；同一查询在后台读取正式行情，返回后重置该数据源，沿用同一个 widget 更新。通过价格实际变化断言验证替换，不能只凭提示消失判断成功。
- 没有足够缓存时使用轻量准备画面；原生工具栏可用后立即显示，不用旧图片遮挡。保留既有历史读取、指标协调和预取策略，没有改造服务端分段返回协议。
- 缓存按行情身份、系列类型和周期隔离，最多6项，每项6000根；不跨用户/供源/周期替用，不用缓存回答指定固定版本或指标专属请求。已读取的主序列历史与补充页仅在相同数据版本下合并；持久化失败不阻断正式行情读取。
- 这是近期 HTTP 行情缓存，不承诺持久保存最后一个实时 tick。缓存阶段用轻量“正在同步行情”提示；正式历史被原生图表接受前，不用缓存建立实时流确认游标，避免跳过中断区间。
- 原生指标可能在冷启动额外索取预热 K 线。缓存启动先完成本机已知范围的绘制，避免追加预热请求挡住整张图；新数据返回后原生数据源重置，重新计算指标并恢复正式历史边界。指标参数和 Python 指标协调仍沿用既有实现。
- 导航切回保留 widget、周期、指标与视区。后台暂停传输，前台补齐并恢复当前柱；缓存同步结果跨周期切换暂存，回到对应周期继续更新。用户在历史位置时保持日期范围，在最新端时沿用原生最新端行为。
- 行情读取和真正的本机保存失败使用紧凑提示，提供重试、关闭；相同已关闭错误不反复弹出，实际恢复后自动清除。普通反馈和详细错误进入“更多 → 日志”。一次不相关的原生成功报告不会清除仍未恢复的缓存同步错误。

## 验证

先 `npm --prefix web run build`。浏览器使用本机已有许可图表资源和实际原生 widget，未提交许可库。

| 检查 | 结果与证据 |
| --- | --- |
| IndexedDB 缓存、后台替换、失败重试、用户/周期/版本隔离、退出登录、指标补充页、容量边界 | `node tests/mobile-chart-history.cjs` 通过 |
| 既有准备/预热策略 | `node tests/mobile-chart-preparation.cjs` 通过 |
| 原生恢复与手机连接单测 | `node tests/mobile-chart-resume.cjs`、`node tests/mobile-resume.cjs` 通过 |
| 完整图表流程：周期收藏、画线/删除/保存、十字线、原生/Python 指标入口、参数取消、切页、缓存、真实保存失败 | [full-browser.json](full-browser.json)，通过，无页面异常或桌面设置写入 |
| 375/412px × 深浅主题 × 100%/150%字号；真实保存错误与自动恢复 | [layout-and-save.json](layout-and-save.json)；原生十字线44×38px且未裁切，外围操作44px |
| 缓存同步期间快速切周期、已保存 RSI、历史视区保持、新价格替换 | [cache-switch-rsi-viewport.json](cache-switch-rsi-viewport.json)，通过 |
| 自建/组合系列缓存失败后重试；大小写身份一致性 | [composite-retry.json](composite-retry.json)，通过 |
| 断网/后台后同 widget 补齐3根缺失 K 线，更新形成中的当前柱，保留 RSI 参数 | [native-resume.log](native-resume.log)、[foreground-recovery.png](foreground-recovery.png)，通过 |
| 网页专业图表增强指标窗口、原生保存、工作区与指标参数隔离 | [desktop-isolation.json](desktop-isolation.json)，通过 |
| 行情失败提示深浅主题/375/412px/150%字号，重试与关闭可达 | [error-matrix.log](error-matrix.log)，通过；关闭后不立刻重现 |

在 `web/` 可用以下环境开关分别复验 `tests/mobile-chart.browser.cjs`：

- `MOBILE_CHART_POLISH_ONLY=1`：布局、保存、缓存、失败恢复。
- `MOBILE_CHART_CONTINUITY_ONLY=1`，叠加 `MOBILE_CHART_CACHE_STUDY=1`、`MOBILE_CHART_CACHE_SWITCH=1`、`MOBILE_CHART_CACHE_PAST=1`：指标、快速切周期、历史视区。
- `MOBILE_CHART_CONTINUITY_ONLY=1 MOBILE_CHART_CACHE_COMPOSITE=1 MOBILE_CHART_CACHE_FAILURE=1`：自建/组合缓存同步失败重试。
- `MOBILE_CHART_ERROR_ONLY=1`：错误提示主题/字号矩阵与关闭。
- `MOBILE_CHART_ISOLATION_ONLY=1`：实际桌面 widget 隔离。

各次设置独立 `MOBILE_CHART_OUTPUT`，防止覆盖其他脚本证据。完整流程无开关运行。`mobile-chart-resume.browser.cjs` 单独复验实时补齐。

## 截图检查

检查的是实际渲染与交互；行情价格变化不作为 UI 误差。已逐张查看缓存画面、同步后画面、深浅主题大字号及错误提示。

| 画面 | 截图 |
| --- | --- |
| 改造前的底部错误 | [error-before.png](error-before.png) |
| 改造后的深色/浅色大字号错误 | [error-dark-375-large.png](error-dark-375-large.png) · [error-light-375-large.png](error-light-375-large.png) |
| 紧凑保存错误 | [save-error.png](save-error.png) |
| 可交互缓存含 RSI → 同步后真实价格更新 | [cached-with-rsi.png](cached-with-rsi.png) → [revalidated-with-rsi.png](revalidated-with-rsi.png) |

## 部署与回退

只更新 Ubuntu Docker 持久开发 project `mw-dev` 的 Web。访问：

- <https://quant.kookvv.com:8443/m/>
- 局域网 <https://192.168.7.232:18443/m/>

新镜像 `market-watch-web:mobile-chart-continuity-20261117`，固定 image ID：

`sha256:a70e38d5a49f70ed88a040513cb0dfd2afd5efc29409dab546cc9aa040ff4d95`

原 Web 回退 image ID：

`sha256:23bf85de00a3399d6761b8e7df7a6c15105f09c1f6e75cc1ac18140eb3833768`

使用 `mw-docker build`，task `mw-mobile-chart-continuity-20261117`、project `mw-dev`、purpose `acceptance`；根目录 build context、`web/Dockerfile`。部署前只读盘点现有容器与端口，内存可用约10GB、磁盘可用约17GB；复用实例，不新增数据库。

私有候选清单、原配置、容器 ID 和实际验证脚本保留在：

`/home/quant/.local/share/market-watch-dev/updates/mobile-chart-continuity-20261117/`

实际 launcher `mw-dev` 使用：

`/home/quant/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json`

只替换该文件的 `services.web.image`，保留其他配置与下载只读挂载。定向启动/停止 Web：

```sh
docker compose -p mw-dev -f /home/quant/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json up -d --no-build --no-deps web
docker compose -p mw-dev -f /home/quant/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json stop web
```

回退也只将该文件的 Web image 换成上面的原 image ID，再执行第一条命令，不整体覆盖配置、不重建数据库或后台服务。不清理其他任务、旧实例或镜像。

## 实例检查与验收边界

部署后的真实认证访问、缓存冷启动和同步证据见 [deployed-proof.json](deployed-proof.json) 与 [actual-interactive-cache.png](actual-interactive-cache.png)。实际数据带 `chart_time` 与 `start`，验证不是只靠夹具的 `start` 字段。对真实历史请求暂缓后，原生图表仍能画出缓存 K 线；放行后同一 widget 更新。对比网页偏好/工作区及现有告警配置指纹，无业务写入和测试通知。APK 更新清单仍为0.1.5/code6，无需新 APK。

其他7个运行中的 `mw-dev` 容器 ID、镜像及启动时间均保持；API、行情、数据维护和通知 worker 未重建。

本记录证明浏览器、原生许可 widget 和 Ubuntu 实例链路。Android 真机的触摸、系统字号和前后台切换仍需用户实机确认；模拟后台及手机视口不等于真机验收。未创建 PR、未合并、未打正式 tag、未部署 Unraid。
