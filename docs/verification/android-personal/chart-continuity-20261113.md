# 手机图表连续显示与原生 Python 指标

后续用户反馈预览漏命中，已修复数据集 ID 大小写匹配、恢复通知误清预览和准备覆盖层撤下时机。当前验收 Shell 及证据见 [预览漏命中修复](chart-preview-match-20261113.md)，下文保留上一轮记录。

分支 `feat/android-personal-v205`。用户授权实施后完成客户端范围，部署在 Ubuntu quant-server 的隔离 Docker project `mw-android-personal-v205`。F0：兼容的手机生命周期、显示和本地可丢弃图片缓存；不改 API、数据库 schema、供应商历史预取配置及桌面加载策略。未跑 CI、未更新 PR、未操作 Unraid。

## 实现行为与边界

- 导航切页继续保留同一 widget。图表资源、目录/能力和本机设置并行准备。十字线只留图标与可访问名称；顺序为周期、十字线、指标、K 线类型，价格轴保持原样。
- 手机指标入口使用原生简洁列表，只补齐原生控制器遗漏的 Python 元数据；搜索、收藏和添加回调仍是原生行为。适配限定手机 iframe 和固定许可版本，网页增强指标弹窗保持原实现。
- 重建时先显示同服务器/用户、品种来源、周期、主题和保存布局匹配的上次截图；切回曾查看周期时选取该目标的预览。图片标注“上次数据”时间及更新状态，覆盖区域阻止操作，原生 Header 就绪后仍可用。当前行情和指标就绪后移除图片。
- 图片由公开 `takeClientScreenshot()` 生成，限制分辨率与单张大小，在现有分区 IndexedDB 中最多保存六张；不是 K 线数据库，不向行情接口回灌。变更指标/绘图等布局时失效，注销隔离与异步写入围栏沿用现有缓存机制。
- 自选稳定后空闲 1.2 秒启动资源准备；候选为上次图表和当前自选排序第一项，去重最多两个，每项只用最近周期。后台仅串行一个历史 preparation，不建立隐藏 widget。当前图表优先，同目标在途 preparation 接入既有 runtime 复用，不同目标取消；App 后台暂停，注销或换会话清理。
- 沿用 `startupHistoryQuery`、`loadNativeHistory` 与原生历史缓存。prepare 请求保持 `limit=1/countBack=1` 的既有启动机会页协议，供应商最终预取数量仍由原规则决定；不表示只取一根最终 K 线。
- 移除手机阻挡图表的转圈；没有匹配旧画面的新目标使用安静准备/更新文字。已有持久错误与显式重试保留，失败不冒充更新成功。

本轮没有改历史结果交付协议：冷目标仍需等现有整份 result 返回；“当前可见范围和指标必需预热满足后即可提前交付新图”需要后续服务端协议工作，不能用保留旧图片冒充实现。没有引入访问计数排名，也没有改变原生周期缓存失效规则。

## 验证与实际限制

本地构建及以下检查通过，针对本次风险进行验证，未跑 CI：

```sh
cd web
npm run build
node tests/mobile-chart-preparation.cjs
node tests/mobile-cache.cjs
node tests/mobile-transport.cjs
node tests/advanced-market-request-scheduling.cjs
node tests/advanced-history-admission.cjs
node tests/native-indicator-identity.cjs
node tests/mobile-app.browser.cjs
MOBILE_CHART_OUTPUT=/tmp/mw-chart-delivery node tests/mobile-chart.browser.cjs
MOBILE_CHART_CONTINUITY_ONLY=1 MOBILE_CHART_OUTPUT=/tmp/mw-chart-delivery-repeat node tests/mobile-chart.browser.cjs
```

另通过 `git diff --check`。单测使用实际 fake-indexeddb 事务覆盖六张淘汰、主题/来源/周期/布局/用户隔离和注销晚到写入；调度夹具覆盖串行、去重、前台复用/取消、后台暂停和配置复用。

真实许可 widget + API 夹具验证 375/412px、深浅主题、150% 外层字号、绘图与十字线触摸、原生指标搜索、参数放弃、本机保存错误恢复、历史失败重试；延迟历史返回验证重建及 H1/M5 匹配预览、就绪移除。全套及独立重复均无页面错误。截图与 proof 见 [fixture](chart-continuity/fixture/) 和 [repeat](chart-continuity/repeat/)。

Ubuntu 真实 XAUUSD 验证了历史返回、周期收藏/本机保存和重进恢复、十字线拖动、原生 Python SMA 搜索/添加、后台计算结果与图中曲线显示；随后移除浏览器本机 SMA。`errors=[]`、禁止业务写入 `writes=[]`，未改服务器自选、告警、任务或偏好。证据见 [live](chart-continuity/live/)。

真实供应商请求出现过“历史分页暂时未推进 / 平台历史暂不可用”和读取超时提示，后续请求取得 2000 根并完成验证。本轮不宣称消除冷请求的供应商延迟，也没有以测试通过为由隐藏错误或改变预取策略。现有原生缓存继续复用；尚无完整的五次冷/热周期往返性能基准，不作 Android 延迟保证。

另一次真实会话观察到去重后的 XAUUSD/H1 `prepare:true` 请求，`limit=1/countBack=1`；重载时上次真实 XAUUSD 预览可见，live-ready 后移除。该轮无页面错误、业务写入或通知。五次保留 widget 的导航返回观察为 75/60/67/63/73ms，中位数 67ms、最慢 75ms，只衡量浏览器返回已有画面，不是新数据耗时或 Android 指标。证据见 [live-preparation](chart-continuity/live-preparation/)。验收脚本初次按完整 URL 匹配，遗漏 `?wait_ms=3000` 请求；改为按 pathname 匹配后补验通过，未因此修改产品代码。

浏览器验证包含 APK 禁止 blob iframe 导航的行为重放，没有 adb 连接的真机。实际 Android 的触摸、恢复和截图过渡仍需用户协助验收。

## 部署与手机更新

- 地址：<https://192.168.7.232:18445/m/>。
- Shell：`6a2eb632ba46d1db`；图表 manifest：`chart-assets.7b617995e58ece5c.json`。
- 镜像：`market-watch-web:android-personal-v205-chart-continuity-final-20261113`。
- image ID：`sha256:7b82e83fba927296c75fe612997b2885880beac703ce65a403e50bf04501ad3f`。
- 只替换本项目 web；复用原 api、data-worker、tls、postgres，没有新增服务或数据库。部署前可用内存约 9.4GiB、磁盘约 17GiB。
- web running，其他原服务 healthy（data-worker 无健康检查）；使用实例证书验证 `/readyz` 与上述 Shell。私有 `before-chart-continuity-run.json` 保留旧镜像配置，权限 0600。

通过 `mw-docker build` 构建本任务候选。启动/停止仅本项目 web：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web

docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  stop web
```

手机在“更多 → 检查更新 → 更新页面”获取本版，无需重装 APK。
