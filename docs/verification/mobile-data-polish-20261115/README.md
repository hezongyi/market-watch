# 手机端数据页 UI 打磨

2026-11-15。风险分类 P0：手机端局部布局、样式和对象内反馈，无 API、schema、后台维护或接续策略变化。工作区 `market-watch-managed-live-rollover-20261113`，分支 `feat/managed-live-rollover-20261113`，基线 HEAD `17af8e2533eb8ffd4b152135223f51aaa164ecef`。保留本分支此前已授权的未提交工作；本轮增量位于 `DataManagedPage.tsx`、`ManagedDataFacts.tsx`、`data-controls.css`，[文件指纹](source-hashes.json)。

## 完成内容

- 列表保留两行身份和已有分类标签，移除行间卡片空隙；常规行距约 95px → 81px。状态字号约 10px → 12px，状态列为 5.5rem，375px/150% 字号仍能显示“小米集团－W · 新浪财经”等常见名称。长内容允许自然增高，不裁掉信息。
- 实时开关保持现有 shadcn/Base UI 大号变体、扩大触摸范围、提交锁和真实状态语义；失败原因独占行，避免挤压名称/开关。历史更新异常与“不支持实时”分别显示，避免重复“更新需处理”。
- 顶部继续使用无框、无底纹的筛选/搜索图标。筛选生效时有轻量标记，并直接显示来源/范围；叉号一次清除。空结果只保留一个清除入口，不重复创建提示。
- 筛选抽屉将“任务与来源”改成底部导航行，与两项筛选区分开。
- 自建详情复用品种两行信息和一个分类标识，M1派生/bid/NY17 等特点仍独立成标签；AKShare 采集通道保留。
- 历史范围提前到历史区域首项并突出日期；周期代码自然排列，整项换行，不留下孤立分隔点；自动维护、近期成功/失败和已有历史可用性继续显示。
- 实时状态与标题并排，操作按钮按内容分配，窄屏大字号按需换行。打开图表/加入自选放在更多操作前；任务、版本、补数、归档等原有流程保留。
- 无数据与加载态采用更轻的无卡片框列表样式。普通操作反馈仍静默记录，阻断错误原位显示。

## 截图迭代

1. 原始截图发现列表松散、状态字偏小、历史范围排在周期后、筛选条件不明。
2. 第一轮完成列表、范围和筛选层级；通过全流程验收后，复拍发现实时操作纵向占用较多、常用动作排在更多操作后。
3. 第二轮缩短详情、减轻空态，实际大字号截图发现来源末字和按钮末字换行、周期分隔点落在行首。
4. 第三轮收窄状态列、按内容分配按钮、周期整项换行；复拍后未发现新的布局问题。

[列表前后对照](screenshots/comparison-list.png) · [详情前后对照](screenshots/comparison-detail.png)

[真实 375 浅色](screenshots/runtime-list-light-375-14.png) · [真实 375 大字号](screenshots/runtime-list-light-375-21.png) · [详情大字号操作区](screenshots/runtime-detail-actions-light-375-21.png) · [筛选](screenshots/runtime-filter-yahoo.png) · [筛选空态](screenshots/runtime-filter-empty.png)

## 验证

- 完整 Docker web 构建（TypeScript + Vite + 手机壳/原生图表资源）：[日志](logs/build.log)。未新增 UI 依赖。
- 数据全流程：使用显式 HTTP 夹具验证创建、丢失响应核查、防重、维护冲突、实时开启/关闭/失败回退、归档/恢复、版本/图表身份、离线保护、未保存确认与嵌套返回；375/412px、深浅主题、14/21px 字号、缩小视口和减少动态效果。[最终日志](logs/workflow-final.log)、[结果](workflow-proof.json)、[截图](workflow/)。所有写操作发生于夹具。
- 共享搜索与详情：分页、取消请求、失败/重试、当前组添加、冲突、版本可用性、离线及大字号；[日志](logs/shared-data.log)。
- 品种标识：两行布局、完整来源名、分类、原位添加、创建顶部和既有表单；[日志](logs/identity-r1.log)。该检查在第一轮后执行，后两轮未改共享搜索/创建标识。
- 自选 A07 主体：8 个主题/尺寸/字号几何组合通过，[日志](logs/watch-geometry.log)。后续增量仅限数据作用域与数据专用历史事实。
- 历史事实纯逻辑：范围、周期状态、维护及实时未知/缓存语义通过，[日志](logs/facts.log)。
- 实际 Ubuntu Docker：35 张只读截图，真实列表/详情/筛选/清除/空态/添加目录；页面无横向滚动、文本不溢出，主操作滚动可达；无后端写入、页面错误或 API 5xx，readyz 200。[结果](runtime-proof.json)、[日志](logs/runtime.log)。触摸扩展区域会超出行内宽度数像素但仍在页面边距内，不误判为文字或页面溢出。
- `git diff --check` 通过。检查本轮增量：不改变报价/采样、数据身份、维护保存/任务规则、实时配置、防重、并发控制或图表获取策略。

真实环境只读检查不代表重新认证所有行情源。实例中已有“实时认证异常”等状态继续按后台真实结果显示。本轮没有修改供应商凭据或启停来源。

## 验收入口

运行于 **Ubuntu 本机 Docker**，Compose project `mw-managed-live-rollover-20261113`。

访问 **https://192.168.7.232:18447/m/data**；App 连接同一验收实例，重新打开即可获取服务端资源，**无需安装新 APK**。

本轮只更新该 project 的 web 服务，固定镜像见 [deployment.json](deployment.json)。API、worker、数据库及其他任务实例保持原状，未操作 Unraid。更新前配置已在 task 私有目录分轮留档；最初镜像见 [deployment-r1.json](deployment-r1.json)。

启动/停止仅本任务：

```bash
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

如需回退：先保留当前配置，将该 task 的 `run.json` 和 `compose.json` 中 web image 恢复为 deployment-r1.json 的 `previous` 值，再对同一 project 执行 `up -d --no-build --no-deps web`；不回滚数据库、不删除 volume。

浏览器窄屏/触摸模拟已验收；Android 真机的系统字体、手势返回和系统键盘仍应由用户实际确认。本轮未更新 PR、未运行 CI、未合并或打正式 tag。
