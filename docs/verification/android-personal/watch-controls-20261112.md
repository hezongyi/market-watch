# 自选操作与分组控件改造

分支 `feat/android-personal-v205`。按用户认可的方向，局部引入官方 shadcn/ui `base-nova` 源码及 Base UI 1.9.0。F0：兼容的前端交互改造，无 API、schema 或持久格式变更；采用本地定向回归和既有 Ubuntu 隔离实例 R1。按用户要求未运行 CI、未更新 PR。

## 实现与边界

- 自选操作、搜索、分组选择、新建/改名及管理使用 Drawer；进场 300ms、退场 190ms，支持跟手拖动、回弹、下滑关闭及遮罩渐变。子界面切换等待操作抽屉完成退场。
- 分组单选用 RadioGroup，统一选中标记、数量和轻量入口；表单使用 Field/Input/Button，删除与未保存确认使用 AlertDialog。
- 管理分组及品种排序使用 Collapsible 展开过渡和 200ms FLIP 位移；提供箭头按钮。支持减少动态效果偏好。
- 脏表单滑动/返回时保留输入并确认；保存中禁用关闭，避免请求尚在完成时放弃。冲突仍保留输入，删除分组仍将独有品种保留在“未分组”。
- Portal 留在自选主题容器；Tailwind 不加载 preflight；其他页面继续使用既有原生 MobileSheet。未额外引入 Motion。当前行情行、左右栏、M5 折线、实时报价末点及前后台连接策略保留。

## 检查与证据

生产构建（含 TypeScript、原生图表钩子和 mobile shell 生成）、`git diff --check` 通过。以下本地脚本通过：

```sh
cd web
node tests/mobile-watch.browser.cjs
MOBILE_VISUAL_OUTPUT=/tmp/mw-watch-controls-final node tests/mobile-watch-a07.browser.cjs
node tests/mobile-alerts.browser.cjs
node tests/mobile-app.browser.cjs
node tests/mobile-sparklines.cjs
node tests/mobile-transport.cjs
```

自选回归使用构建后的真实页面和明确 HTTP 夹具，覆盖真实 CDP 触摸拖动、退场期间保留 DOM、Android 返回事件、未保存确认、删除取消与放弃、排序位移动画、保存中禁止关闭、快速重复开关、缩小视口下提交按钮可达、减少动态效果，以及此前行情与连接回归。排序检测到两行各有 200ms 动画。告警测试原先仍监听已被历史实现替换的 `window.confirm`，本轮更新为操作现有的“继续编辑/放弃修改”控件，未改告警业务。

已人工查看 375/412、深浅主题及 150% 字号截图，另查看缩小视口表单和动效关键帧。相关证据：

- [部署前后控件对照](a07-feedback/watch-controls/before-after.png)
- [动作与触摸记录](a07-feedback/watch-controls/controls-proof.json)、[布局记录](a07-feedback/watch-controls/layout-proof.json)
- [控件交互录像](a07-feedback/watch-controls/controls-motion.webm)（浏览器夹具，截取 7–26 秒，包含拖动、确认和管理操作）
- [浅色操作](a07-feedback/watch-controls/actions-light.png)、[深色分组](a07-feedback/watch-controls/groups-dark.png)、[小视口表单](a07-feedback/watch-controls/compact-form.png)

真实验收实例只读验证登录、行情、导航及控件开关，未保存或修改真实自选；[上线记录](a07-feedback/watch-controls/after/proof.json) 中页面错误和业务写请求均为零。四组主页面行高仍为 72px、图高 50px，各列宽度及横向位置与更新前一致，无三次曲线指令。更新前这次采集中的部分行情仍在加载，故文字块高度不作等值断言；[上一轮已加载的主页面](a07-feedback/watch-controls/main-before-loaded.png)也已人工与[本版主页面](a07-feedback/watch-controls/after/watch-light-412.png)对照。不同采集时间的价格、颜色和曲线变化来自真实行情。

以上为浏览器和 Ubuntu 验收，不代表 Android 真机触感或系统软键盘验收。系统键盘弹出、连续拖动和手机返回键仍待用户实机体验。

## 当前部署

实际主机：Ubuntu 本机 `quant-server`。复用隔离 Compose project `mw-android-personal-v205`，仅更新 web，未操作 Unraid。预检可用内存约 7.5GiB、磁盘约 16GiB。

地址：<https://192.168.7.232:18445/m/>。手机通过“更多 → 检查更新”获取，无需重装 APK。Shell：`14f3120dd832f6e4`。

镜像通过 `mw-docker build --repo . --component web --context . --file web/Dockerfile --tag market-watch-web:android-personal-v205-watch-controls --task mw-android-personal-v205 --project mw-android-personal-v205 --purpose acceptance` 构建，固定 ID `sha256:a4f7c32206120a68174e4fd5e0fae613bd0502c778d70833963f89aa34559a01`。HTTPS CA 校验 `/readyz` 返回 ready；web、api、postgres、tls 状态正常。

配置目录：`/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/`。旧配置独占备份为 `before-watch-controls-run.json`，权限 0600，旧镜像 `sha256:41b01dfc05a5b0025022fec27fc698ddfeec64357d86a90dfdddc21375076654` 保留。

启动/更新：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止（未执行）：同参数将末行改为 `stop web`。配置回退（未执行）：将第一个配置替换为同目录 `before-watch-controls-run.json`，再运行相同 up 命令。回退不触及数据库。
