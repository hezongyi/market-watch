# 告警原生 UI 实施与验收记录

**2026-10-11 更新：PR #38 的审查问题已修复，当前 Ubuntu 验收实例运行最终应用源码 `c77f67c`（v1.19.0）。** 当前复核、运行身份、验证及启停方法见 [修复与合并复核](review-fixes/README.md)。

实现先对齐 v1.18.0，再合并最新 main（v1.19.0），保留报价、日历与范围恢复改动。[v1.18.0 对齐记录](v118/README.md) 与 [PR 首次提交记录](pr-submit/README.md) 保留各自时间与版本的历史证据；下面其余记录为 2026-10-08 原实现。

2026-10-08。工作树 `market-watch-native-alert-ui-impl-20261008`，分支 `feat/native-alert-ui-impl-20261008`，基线 `6fd9273`。**代码与 Ubuntu 本机验收已完成；独立 Docker 实例运行并保留供用户查看。** 未提交、推送、建立 PR 或发布生产。原方案工作树与其他任务实例保留。

## 已实施

业务 React 只在图表 host document 中挂载一份，通过 portal 渲染到真实供应商 iframe 的 widgetbar 页和窗口。父页面持有 API、CSRF 和 localStorage 草稿；图表域仅发送限定业务请求，不复制登录信息。

- 原生警报入口、侧栏拖宽/折叠、警报与日志页、按需搜索、排序/筛选菜单、两行列表、悬停及键盘操作、详情和日期分组日志。
- 条件、摘要及独立消息/通知子页；取消子页还原其草稿，最终保存失败/409 保留输入。提交期间真实原生选择器及输入禁用。
- 创建、编辑、暂停/恢复、复制为草稿、archive 删除、通知确认、图表定位和画线恢复/重试沿用原业务。当前品种筛选跟随活动图，编辑保持发起时品种。
- 复制布局和原生加载布局轮换 session；旧请求失效，草稿按 workspace 保存；原生页面重建只更换 portal target，保留一个业务 root。
- 固定版本私有访问集中在 `advanced-host/native-alert-shell.js`，验证 v31.1.0 和内部版本标识；初始化依赖失败不改侧栏配置，销毁恢复配置、清理订阅和待打开窗口。
- 图表镜像从仓库根构建，复用 web 告警源码。专用 Dockerfile ignore 白名单排除后台与私密配置；四个现行验收 Compose 的 chart 构建入口同步更新。

## 实际复用来源

| 区域 | 来源 | 自有部分或限制 |
| --- | --- | --- |
| 右侧入口、widgetbar、拖宽、折叠、页面切换 | 真实 v31.1.0 widgetbar/layout | 告警页业务 renderer；入口 SVG 自有 |
| 窗口、标题/关闭、位置/拖动、焦点容器 | 供应商 `894450.showWarning` / SimpleDialog | 内容和 footer 通过 portal；适配宽度、禁用与 Esc |
| 选择器和选项 | `221339.Select` / 原生 Listbox | 选项对应既有告警业务 |
| 复选框 | `343577.Checkbox` | 通道说明/迟到策略自有 |
| 输入和消息正文 | `909536.InputControl`、`165770.Textarea` | required 通过原生 input reference 设置 |
| 保存、取消、应用按钮 | `536605.Button` | 编辑删除图标按钮自有 |
| 排序/更多/行操作/到期菜单 | `986418.PopupMenu`、`18392.PopupMenuItem`、`658778.PopupMenuSeparator` | 业务动作、键盘导航与焦点恢复 |
| 图表价格/指标/画线右键入口 | 原有 native context menu/action factory | 既有告警动作与快照逻辑 |
| 列表、日志、条件摘要、健康提示、图标 | 自有 React 业务内容 | 不宣称存在供应商完整告警模块 |
| 搜索、日期输入、占位符入口 | HTML input / datetime-local / 自有业务 | 搜索未复用供应商 InputControl；日期没有官网日历弹窗 |

模块和 webpack 的访问均属于固定版本适配，不是供应商公开 API。没有改私有 ZIP 或原库字节；构建期仍使用仓库原有 reserve 补丁，仅作用于任务构建副本。

## 视觉证据与差异

打开 [comparison.html](comparison.html) 查看 17 个参考场景的等尺寸裁剪，点击图片查看原始像素。完整实施截图在 [screenshots/](screenshots/)，逐项映射和具体差异在 [comparison.json](comparison.json)。主要深色截图为 2744×890、DPR 1，另有浅色及 390px 窄视口。参考中的 5 张局部截图按各自原始尺寸对照。

创建窗口测量为 480×465.94px，内容宽 480px；标签列 120px、间隔 12px，主条件控件 308×34px。参考创建外壳约 480×476px，控件约 304px。尚未达到逐像素一致，差异包括条件选项内容、标题与 footer 文案、高级区、通知通道说明、日志详情，以及原库和官网不同的图标/菜单项。

不新增邮件、Webhook、多条件、无限触发、预设和日志删除。通知仅提供网页及既有 ntfy；有限触发语义保持。编辑的删除调用既有 archive。供应商全屏模式隐藏 widgetbar，业务 root 保留，仍可打开窗口；退出全屏恢复原生告警页。没有强行改变供应商全屏布局。

## 已运行验证

运行环境：Ubuntu 22.04（`quant-server`），本机 Docker 29.1.3、专用 `market-watch-ubuntu` BuildKit、无头 Chromium。早期 integration/probe 使用进程内模拟 API/行情；下表新增 runtime 验收直接访问独立 Docker 实例，明确区分实际数据来源。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| `npm run build`，tsc + Vite | 通过；已有大 bundle 提示 | 本轮终端记录 |
| 原生 UI integration | 12 组通过，0 页面异常；包含提交中禁用、全屏和失败/销毁清理 | [ui-integration.json](ui-integration.json) |
| 完整 AdvancedWorkspace + host + 许可库 | 4 组通过，0 页面异常/意外 API 路径；Save As、native load、晚到响应、409 | [workspace-integration.json](workspace-integration.json) |
| 独立 React 表单/列表回归 | 4 组通过，0 页面异常 | [standalone-ui.json](standalone-ui.json) |
| 原有真实图表业务 probe | 12 组通过；实际拖动/撤销重做、四指标、多图身份、恢复/删除 | [native-business.json](native-business.json) |
| bridge + UI RPC 单元检查 | 10 项通过 | 本轮终端记录 |
| 后台 domain/api/service/geometry | 35 passed | 本轮终端记录 |
| 生产静态构建 hook 与组合脚本语法 | 通过；在 `/tmp` 副本运行，没有生成 Docker 镜像 | [static-build.json](static-build.json) |
| 独立验收 Compose config | `config --quiet` 通过 | 本轮终端记录 |
| 私有库任务副本 | 2928 个文件 SHA-256 与 manifest 匹配，Git 排除 | 本轮终端记录 |
| `git diff --check` / 修改脚本语法 | 通过 | 本轮终端记录 |
| 真实 Docker 浏览器 + Binance | 8 组通过；0 页面异常/传入图表域凭据 | [runtime-browser.json](runtime-browser.json) |
| 运行 API/worker，合成数据库观察 | 5 组通过；1/2/3 次、区间、历史修订、通知重试和确认 | [runtime-api-worker.json](runtime-api-worker.json) |
| 无网页订阅的真实来源监控 | live interests=0 时最新数据时间与告警检查点继续前进 | [no-browser-real-source.json](no-browser-real-source.json) |
| 缺口、迟到、陈旧数据与重启 | 3 组通过；队列数据恰好处理一次 | [fault-acceptance.json](fault-acceptance.json) |
| API 换 IP 后代理与持久性 | 37.89s 恢复，18 规则/14 事件及通知/队列不变 | [restart-acceptance.json](restart-acceptance.json) |
| 真实原生消息/通知、复制删除、日志确认及全屏 | 4 组通过；0 页面异常/传入图表域凭据 | [runtime-native-ui.json](runtime-native-ui.json) |
| PG 实际备份/恢复 | 1,479,427 字节；全部 public 表行数一致，22 告警/28 版本/14 事件及工作区内容一致，临时恢复库已清理 | [postgres-backup-restore.json](postgres-backup-restore.json) |

证据只归档成功结果与必要几何、复用信息；没有复制许可 bundle、CSRF、请求全集、env、私钥或浏览器状态。源文件对应哈希见 [source-hashes.json](source-hashes.json)。早期 `result.json` 和 `native-alert-sidebar-*` 是接入探针，最新实施结果以上表为准。

## 浏览器复跑

在实施工作树执行，先安装 web 依赖并准备许可库。新 integration 测试自行把当前告警源码编译到各自 `/tmp` 目录，不依赖陈旧 generated assets。

```bash
LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu \
MW_PROBE_LIBRARY=/tmp/mw-native-alert-ui-probe/library \
node web/tests/native-alert-ui.integration.cjs

LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu \
MW_PROBE_LIBRARY=/tmp/mw-native-alert-ui-probe/library \
node web/tests/native-alert-workspace.integration.cjs

node --test web/tests/chart-alerts-bridge.test.cjs web/tests/chart-alert-ui-rpc.test.cjs

PYTHONPATH=backend /tmp/mw-native-alert-python311/bin/python -m pytest -q \
backend/tests/test_chart_alert_domain.py backend/tests/test_chart_alert_api.py \
backend/tests/test_chart_alert_service.py backend/tests/test_chart_alert_geometry.py
```

视觉对照重建需要 Pillow 和原始参考图：

```bash
PYTHONPATH=/tmp/ppt_deps /tmp/mw-native-alert-python311/bin/python \
scripts/native_alert_ui_comparison.py --references /home/quant/repos/monitor \
--evidence /tmp/mw-native-alert-ui-integration --output docs/verification/native-alert-ui
```

## Ubuntu Docker 隔离验收：已运行

用户已授权 Docker。Ubuntu 账户已加入 docker 组，通过 `sg docker` 使用已授权组身份访问本机 socket；`mw-docker` 自动处理该身份。独立 task 已登记，三个镜像标签均为 task/project `mw-native-alert-ui-runtime`、用途 acceptance。没有使用 unraid。

实际资源与镜像身份见 [runtime-environment.json](runtime-environment.json)。独立 task/project `mw-native-alert-ui-runtime`、数据库/用户 `native_alert_ui`、project 自有 `native-alert-ui-runtime-pg` volume 与默认网络；私密材料位于 `/tmp/mw-native-alert-ui-runtime`（目录 0700，文件 0600）。许可库已复制到本工作树 ignored `advanced-host/charting_library` 实目录，适合根 context 的 Docker COPY；原 `/tmp` 库未改。

实际地址（已验证 HTTP 200）：主站 `https://localhost:19643/`，隔离图表来源 `https://127.0.0.1:19644/`，均只绑定 Ubuntu loopback。管理员登录密码保存在私密 `/tmp/mw-native-alert-ui-runtime/login.json`，未写入仓库。配置生成器 [prepare_native_alert_ui_acceptance.py](../../../scripts/prepare_native_alert_ui_acceptance.py) 已运行；重复运行会保留并拒绝覆盖凭据。

本轮实际构建使用专用 `market-watch-ubuntu` BuildKit 和 `mw-docker`：

```bash
mw-docker compose-build --repo . --task mw-native-alert-ui-runtime \
--project mw-native-alert-ui-runtime --purpose acceptance \
--env-file /tmp/mw-native-alert-ui-runtime/compose.env \
--file compose.native-alert-ui.yaml

sg docker -c 'docker compose --env-file /tmp/mw-native-alert-ui-runtime/compose.env \
-p mw-native-alert-ui-runtime -f compose.native-alert-ui.yaml \
up -d --no-build'

LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu \
PATH=/tmp/mw-native-alert-python311/bin:$PATH PYTHONPATH=/tmp/ppt_deps:backend \
APP_ORIGIN=https://localhost:19643 CHART_ORIGIN=https://127.0.0.1:19644 \
MW_ALERT_PRIVATE_DIR=/tmp/mw-native-alert-ui-runtime \
node web/tests/chart-alerts-runtime.browser.cjs

# 先运行运行中 API/worker 和 fault fixture，再执行补充真实 UI 检查。
LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu \
node web/tests/native-alert-ui.runtime.cjs
```

本轮基础镜像来自 Ubuntu 本机，并按 digest 交给专用 BuildKit。实际浏览器验收使用真实 Binance 来源；无浏览器验收等待订阅自然过期，确认 live interests=0 时数据与告警检查点继续前进。API 换 IP 后真实 HTTPS 登录恢复，规则/事件/通知未变化。

从其他电脑查看，可建立两个本机端口转发，再打开 `https://localhost:19643/`（主机证书为验收用自签证书）：

```bash
ssh -N -L 19643:127.0.0.1:19643 -L 19644:127.0.0.1:19644 quant@192.168.7.232
```

通知协议测试还可用独立 profile 启动；接收器没有外部出口，default 配置仍禁用外部投递：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-native-alert-ui-runtime/compose.env \
-p mw-native-alert-ui-runtime -f compose.native-alert-ui.yaml --profile notification-test \
up -d --no-build notification-sink notification-worker'
```

后台复跑先查询本任务 PG 容器当前 IP，仅连接独立数据库：

```bash
sg docker -c 'docker inspect mw-native-alert-ui-runtime-pg-1 \
--format "{{(index .NetworkSettings.Networks \"mw-native-alert-ui-runtime_default\").IPAddress}}"'

MW_ALERT_ACCEPTANCE_PROJECT=mw-native-alert-ui-runtime PYTHONPATH=backend \
/tmp/mw-native-alert-python311/bin/python scripts/chart_alert_runtime_acceptance.py \
--database-host TASK_PG_IP

MW_ALERT_ACCEPTANCE_PROJECT=mw-native-alert-ui-runtime PYTHONPATH=backend \
/tmp/mw-native-alert-python311/bin/python scripts/chart_alert_no_browser_acceptance.py \
--database-host TASK_PG_IP
```

实际 dump 保存在私密 `/tmp/mw-native-alert-ui-runtime/`，没有提交仓库。备份核验期间仅停止本任务写入服务，完成后已恢复并确认 readiness。停止实例后可用同一 `up -d --no-build` 恢复：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-native-alert-ui-runtime/compose.env \
-p mw-native-alert-ui-runtime -f compose.native-alert-ui.yaml stop'
```

已执行 retire 预览，清单精确包含本任务 12 个容器、1 个 PG 数据卷和 2 个网络，未执行 apply；其他项目不在清单。只有任务实际验收结束并不再需要实例时，先预览、再按精确归属退役；工具需备份数据卷且实际恢复校验，失败时保留资源：

```bash
mw-docker retire --task mw-native-alert-ui-runtime --project mw-native-alert-ui-runtime
mw-docker retire --task mw-native-alert-ui-runtime --project mw-native-alert-ui-runtime --apply
```

实例保留供用户查看，生命周期 task 仍登记为进行中。用户验收结束后按上述 retire 流程清理，不提前 finish 或删除供验收的资源。通知接收器仅处于本任务 internal network，未发送外部通知。
