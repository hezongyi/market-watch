# 手机分页跟手动效

2026-11-16，`feat/managed-live-rollover-20261113` 当前工作树。F0：兼容的手机 UI 交互改动；保留此前所有未提交工作，不改业务 API、数据库或图表。

上一版只在松手后切换 Tab。本次使用官方 shadcn Carousel（Embla 8.6），保留现有 Tabs 外观，内容随手指移动、露出相邻页，松手吸附；短滑回弹，首尾不循环。点击分类同样横向过渡，线形导航使用 Base UI Indicator 平移。支持减少动态效果。

## 实现

- 共享 `components/TabsPanels.tsx`，组合 shadcn Carousel 与 Base UI Tabs，覆盖数据分类、告警规则/记录、事件记录抽屉和管理自选。Carousel 默认的全局方向键拦截在分页组合中关闭，保留原生 Tabs 键盘操作和输入控件。
- 数据页每个分类有自己的面板。仍仅有一个活动列表读取器；未选中的分类只读取按服务器、会话、分类及筛选条件隔离的缓存。未访问分类显示自己的占位，松手选中后读取，避免错用上一分类数据。保留加载页数和滚动位置，切分类时重新绑定下拉刷新目标。
- 事件记录的异常/恢复、系统面板各自保留内容，读取受 `active` 控制；抽屉关闭或切页取消旧请求。自选管理的草稿、排序、删除和确认语义保持。
- 输入框、开关及屏幕两侧 24px 不认领分页手势；取消、多指和斜滑不提交切页。保留 Embla 拖动后的点击抑制，抽屉继续通过 Base UI `data-base-ui-swipe-ignore="x"` 仲裁横向手势。
- 应用全局 `[hidden]` 规则原本会隐藏相邻面板，导致拖动露出空白。仅在分页轨道内允许这些面板作为视觉预览，继续保留 `hidden`、`aria-hidden` 和 `inert` 的访问与操作限制；其他页面的隐藏规则不变。
- CLI 安装保留现有 Button，未覆盖项目控件；移除旧的无动效 `useSwipeTabs`。没有新增轮播按钮、分页圆点或自动播放。

## 验证

- [完整构建](build.log)、[Docker 候选构建](docker-build.log)、`git diff --check` 通过。包含 TypeScript、Vite、专业图表与手机壳。首次 Docker context 受根目录 `**/dist` 排除规则影响，改用本任务私有的成品静态资源 context 后构建成功。
- [数据分类](data/proof.json)：13 组检查、30 张截图。CDP 原生输入验证跟手移动、相邻页可见、短滑回弹、首尾、取消/多指/边缘/斜滑、快速连点、键盘及 reduced motion；分类分页、缓存、滚动位置、下拉刷新、失败恢复、离线和 375/412px、深浅主题、150% 字号通过。
- [数据操作](data-workflow/proof.json)：17 项既有全流程回归、56 张截图，包括新建、维护、实时开关、失败/冲突、离线保护和图表交接。业务写操作全部使用 HTTP 夹具。
- [告警与下拉刷新](alerts.log)：规则/记录及事件抽屉的跟手切换、创建/编辑/归档/处理、慢刷新、失败恢复、切页/后台/断网收回通过。[自选管理](watch.log)：跟手切换不保存或移除，排序、草稿、丢弃和行情生命周期回归通过。
- [记录栏稳定性](record-stability/frames.json)：375/412px、深浅主题、100%/150% 字号共 32 次切换，分页栏垂直位移均为 0px。
- [拖动过程截图](motion/)结合日志中的 `MOTION` 帧数据检查；数据页横拖 100px 时，松手前内容位移约 99px，短滑约 25px 后回原页。增加相邻面板确实有可见内容的断言，避免仅检查 Tab 选中状态。
- [真实实例](runtime/runtime-proof.json)、[运行日志](runtime.log)：Ubuntu 18447 的全部实际分类、8 组宽度/主题/字号组合、告警与事件抽屉、自选管理。阻止业务配置写入及元数据/曲线准备请求，只验证真实界面与读取；不以此声称完成行情准备或真机验收。脚本 `web/tests/mobile-tab-motion.real.cjs` 需要显式提供实例地址和私有凭据目录，不输出密码。
- [部署检查](checks.json)：APK 信任 CA、6 项手机资源、shell/SW 版本、readyz、实际镜像和 APK 下载大小/SHA256 通过；除 web 外所有本任务容器 ID 保持。

上述为浏览器触摸、帧数据和截图验收。Android 真机的手感、系统边缘返回由用户确认。本次不跑远程 CI，不更新 PR，不创建 commit/tag，不操作 Unraid。

## Ubuntu 验收实例

地址：**https://192.168.7.232:18447/m/data**。已安装 APK 无需重装，可在“更多 → 检查更新”应用网页更新。

只更新本机 Docker project `mw-managed-live-rollover-20261113` 的 web；[镜像与回退引用](deployment.json)。后端镜像仍为 `sha256:e7a524c358b02a553aee91fa82c218699763ff3ddbb34248903d1d26a4d8ae40`，没有后台服务重启或数据库迁移。

启动/停止：

```sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

回退时仅将私有 `run.json`、`compose.json` 的 web image 改回 `deployment.json` 中的 previous，再执行：

```sh
docker compose -p mw-managed-live-rollover-20261113 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/run.json \
  up -d --no-build --no-deps web
```

私有配置备份：任务目录 `mobile-tab-motion-20261116-backup/`。不恢复或删除数据卷。
