# 手机图表页迁移与打磨

分支 `feat/android-personal-v205`。使用 `market-watch-mobile-ui` 和 shadcn skill。F0：手机 UI 和现有图表适配协议的兼容扩展，无数据库或服务端 API 变更。未跑 CI、未更新 PR、未操作 Unraid 或18443。保留既有未提交工作。

## 完成范围

- 顶部单行工具栏：当前品种与供应商、周期 Select、十字线 Toggle、指标 Button、图表操作 Button。普通字号高度64px，150%字号允许自然增高；触摸目标至少44px。长代码截断，可在操作抽屉查看完整名称。
- 切换品种复用已迁移的数据搜索与详情 Drawer，支持来源筛选；退出动画结束后再开图。代码、名称和来源分行，输入组只保留外层焦点环。
- 图表操作接入共享 Drawer，提供图表设置和价格告警。平台品种明确禁用组合价格告警，说明原因；组合保留原创建入口。
- 加载使用 Skeleton / Spinner，启动失败使用 Alert 和重载 Button；未选品种与离线状态使用 Empty，离线提供重新连接。失败反馈保留在页面内，避免与顶部通知重复。
- 首次历史读取或向左加载较慢时，900ms后显示不遮挡操作的行情读取提示，跟随已有 native-load 消息，完成或重置后收起；不更改读取、采样和行情订阅。
- App 深浅主题同步到专业图表，导航切换保留同一 widget。原生图表内切换品种时，同步手机的当前品种和本机选择记录，避免顶部名称及告警目标滞后。
- 未应用参数的离开确认迁移到共享 AlertDialog。继续编辑、Android返回保留输入；放弃时调用原生“取消”，恢复已应用值。等待用户决定不计入原来的5秒图表命令超时。
- 补上原生 `series-properties-dialog` 的参数编辑识别，避免图表设置编辑中被自动保存。移除手机模式同时启用/禁用图表模板的冲突，防止设置页调用不存在的模板适配器。

专业图表引擎内的指标选择、指标参数、图表设置和第三方菜单保留原生触屏控件；本轮迁移的是手机宿主控件及跨页交互，没有替换专业图表，也不代表底部告警规则表单已迁移。自选代码/价格栏、sparkline 几何/采样/配色、价格精度和连接生命周期未调整。

## 截图复核

证据位于 [`a07-feedback/chart-controls/`](a07-feedback/chart-controls/)。

- `before/`：原 Ubuntu 实际行情页面，顶部原生周期及三枚工具图标，左侧缺少当前品种入口。
- `refinement/`：首轮截图发现 Empty 的虚线样式在无 Tailwind preflight 下形成大边框；共享搜索的名称依赖自选作用域，离开自选后挤在代码旁。均以图表作用域样式修正。后续焦点截图去掉输入框内部的第二层描边。
- `final-fixture/`：实际许可 widget + HTTP 夹具，覆盖375/412、深浅主题、14/21px字号、横屏、短视口、聚焦搜索、加载/失败/离线/空态、周期、操作、搜索、指标、原生设置及放弃确认。
- `final-live/`：Ubuntu真实供源K线、品种/来源、周期、操作抽屉、原生设置、搜索、主题及窄屏大字号。
- 前后截图的行情会随时间改变；仅以布局、密度、对齐和交互层级评估界面。

## 本地验证

```sh
cd web
npm run build
MOBILE_CHART_OUTPUT=/tmp/mw-chart-final5 node tests/mobile-chart.browser.cjs
node tests/mobile-app.browser.cjs
node tests/mobile-alerts.browser.cjs
```

图表专项覆盖实际许可 widget、支持周期过滤、M5切换、十字线、原生指标/设置、共享抽屉退场交接、真实触摸跟随/回弹/关闭、慢历史请求提示及完成收起、未应用参数确认超过5秒、继续/放弃/返回、切品种、本机重载恢复、仅组合允许告警、两主题/两宽度/两字号、短视口搜索、离线重连、减少动态效果、启动失败重试且只保留一张图。

App回归覆盖20次导航复用一张图、真实原生RSI设置恢复、离线缓存/退出、会话过期、Service Worker安全更新、未提交密码保护和迟到登录响应；告警回归验证返回、通知及既有告警交互。构建和浏览器检查通过，页面错误为零；`git diff --check`通过。

Ubuntu实际检查只成功登录、读取目录与真实行情、打开/取消设置、打开搜索、切换本地主题和导航；未新增/排序/删除真实自选，未创建告警或任务。实际业务写入为零。首次历史冷读可能较慢；宿主现在显示读取状态，未调整供源获取策略。

浏览器缩小视口和触摸/返回模拟不等于完成Android系统键盘、物理返回键及真机手感验收，仍由用户在APK确认。

## Ubuntu预览与回退

实际主机 `quant-server`，既有独立 task/project `mw-android-personal-v205`。更新前可用内存约9.3GiB、磁盘13GiB，仅替换web，未新增数据库、端口或其他服务。

预览 <https://192.168.7.232:18445/m/>。现有APK通过“更多 → 检查更新”获取网页更新，无需重新安装APK。

最终shell、镜像及实际验收结果见本文末尾收口记录。构建使用 `mw-docker build`、专用 `market-watch-ubuntu` builder，显式指定本worktree根context、`web/Dockerfile`、component=web、task/project与purpose=acceptance。

配置目录 `/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/`。更新前 `run.json` 以0600备份到 `before-chart-run.json`，只改 `services.web.image`。上一登录页镜像保留：

```text
sha256:e4d6254497226bcb379c110709eb2e9e45bff8bf37d7f1306d5196ded478ad4a
```

启动/更新：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止（未执行）：同参数将末行换为 `stop web`。回退（未执行）：第一个配置换成同目录 `before-chart-run.json` 后执行同样up命令，不改数据库。web没有Docker健康检查，验收检查其running状态、CA验证的`/readyz`、实际shell及浏览器行为。

## 收口版本

- Shell：`123f54774cdde0f4`。
- 镜像标签：`market-watch-web:android-personal-v205-chart-final-20261113`。
- 容器实际镜像：`sha256:f3263e84237f25fbc1aaa187ebcb9d1d4524fe02d1537135b20115d87074682a`，run配置固定到此ID。
- 图表专项保存30张截图与8组工具栏几何记录，页面错误/禁止的业务写入均为零；含真实native-load延迟请求和收起断言。最终App回归通过。
- web为running，任务CA验证`/readyz`返回ready，线上shell与本地构建一致。
