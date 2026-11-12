# 自选页与关联控件打磨验收

范围：自选列表、搜索添加、分组选择、新建/改名、管理分组与品种排序。延续已经确认的 A07 方向；不引入 UI 库。P0 显示及局部交互调整，没有 API、持久格式或数据库变更。本轮按用户要求不更新 PR、不跑 CI。

## 最终调整

- 保留 72px 常规行高、42px 小图高度，375/412px 下实际小图宽度分别 159.02/185.20px。平台只显示代码与供应商，自建/组合只显示代码。
- 顶栏添加/管理入口统一尺寸与圆角；连接说明改为普通用语，通信时间使用稳定的 24 小时格式。
- 加载元数据时使用“读取中…”占位，避免内部长 ID 撑高列表。错误报价没有可用名称时显示“暂不可用”。真实加载截图确认行高保持 72px。
- 延迟说明纳入价格块正常布局，和价格间距为 2px，避免紧贴分隔线。
- 搜索结果突出代码；长名称独立为次要信息。添加使用强调色，详情/开图保持次要层级，已添加状态可辨认。
- 分组选择改为整行选项，显示数量与当前选择标记。弹层关闭按钮、输入框、来源筛选、选中/禁用/焦点状态统一处理。
- 管理页用“当前分组 / 数量”代替重复说明。品种排序按需展开；删除与移动分离。发生分组草稿编辑后，底部固定显示“保存分组”，无需滚动寻找；未编辑时显示“完成”。
- 新建/改名输入框增加示例提示，保留冲突输入、离开草稿确认和原有撤销逻辑。

## 截图与检查

- [控件前后对比](a07-feedback/watch-finish/controls-comparison.jpg)：相同 412×852 fixture 视口。新版搜索额外加入未收藏的 SPY，以覆盖添加/已添加两种状态；其余列表仍为同一组示例品种。
- [真实目录与管理控件](a07-feedback/watch-finish/live-controls.jpg)。读取现有验收数据，未增删或排序用户自选。
- [列表前后对比](a07-feedback/watch-finish/watch-comparison.jpg)：375px，裁去空白区域。两个时间点的市场价格、灰态及走势可能不同，未替换截图中的数据。
- [编辑时固定保存操作](a07-feedback/watch-finish/layout/group-save-light-14.png)、[150% 大字号](a07-feedback/watch-finish/layout/group-save-dark-21.png)。
- 完整原图在 `a07-feedback/watch-finish/{before,layout,live}`。`layout` 是 built React + API fixture；`live` 是部署后的真实目录/行情页面，不是 Android 实机截图。

通过：`npm --prefix web run build`、`git diff --check`、`web/tests/mobile-watch.browser.cjs`、`web/tests/mobile-watch-a07.browser.cjs`。

A07 检查涵盖 8 组页面尺寸/主题/字号布局、3 个弹层入口和另外 24 张窄屏控件截图（搜索、分组、新建、展开编辑、排序、草稿保存 × 深浅色 × 标准/150% 字号），以及加载/空态/断线缓存、延迟报价。大字号编辑状态断言保存按钮位于视口内，所有弹层无横向溢出。交互回归包括新增自选、分组选择隔离、改名、保存保留未知字段、409 冲突保留输入、排序、丢弃草稿、过期搜索结果丢弃、通信断线后报价灰态恢复。

实际验收使用当前 4 个品种 EURUSD、GC=F、XAUUSD、USDCAD；375/412 深浅四组通过，无页面异常或横向溢出；延迟报价间距 2px。元数据全部到齐后再次截图。行情通信连接与报价新鲜度独立，待对齐报价按既有逻辑显示灰色。

检查记录：[真实页面](a07-feedback/watch-finish/live/proof.json)、[布局](a07-feedback/watch-finish/layout/proof.json)。已实际打开审阅前后对比、真实搜索和管理、深浅色及大字号编辑截图。浏览器范围内达到本轮交付标准；Android 系统栏、软键盘及手指操作仍需用户实机验收。

## 运行版本

- Ubuntu 本机 `quant-server` / `192.168.7.232`，Compose project `mw-android-personal-v205`。
- 地址：<https://192.168.7.232:18445/m/>。18443 为另一个实例。
- 最终 shell build：`2ec54e427e2e3e25`。
- 最终 web：`sha256:6ca7f1091d2342a25b57a33f36f312b116940eb2c1595436f45aaa607a352681`。
- 旧 web：`sha256:cf00d72897d7f7487bec04ffd8a223e37e4054ccb25f750c68aad56d4d12f3fa`；私有配置备份 `before-watch-finish-run.json`。
- 本次仅替换 web，复用现有 API/data-worker/TLS/PostgreSQL 服务与独立数据。部署前内存约 10 GiB 可用，磁盘约 27 GiB 可用，无端口冲突。不涉及 Unraid 部署。
- 使用 `mw-docker build`，显式 task/project `mw-android-personal-v205`、purpose `acceptance`。容器 healthy；使用任务 CA 校验 `/readyz` 和 shell manifest 均为 200，manifest 与本地构建一致。
- 已安装 APK 0.1.3 可通过 **更多 → 检查更新** 获取页面版本，无需重新安装 APK。

启动命令（完整现有实例）：

```bash
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --wait
```

停止将末行换成 `stop`；本轮更新仅执行 `up -d --no-build --pull never --no-deps --wait web`。私有配置和凭据未写入仓库。
