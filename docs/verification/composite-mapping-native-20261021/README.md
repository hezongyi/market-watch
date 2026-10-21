# 配置实时来源：原生控件实现与验收

## 需求 / Issue 草案

按用户确认的交互预览实现“数据中心 → 组合行情 → 配置实时来源”。来源对照、一个准确品种选择入口、可展开的匹配说明、人工确认及固定底部“仅保存 / 保存并打开图表”。按钮、文本域、输入、选择和复选框均接入当前图表库真实原生组件，保留既有窗口、主题和宿主通道。

基线：`v1.26.5` / `6f74951`。独立 worktree `market-watch-composite-mapping-20261021`，分支 `feat/composite-mapping-native-20261021`。预览来源：`prototype/mwa-composite-mapping-20261021` 的 `09d99fe`，正式实现不合入演示入口。

风险 **F0**：兼容 UI 与既有 API 串联，未修改后端、schema、固定历史、拼接点或产品匹配合同。最小验证：Web 构建、匹配推导/校验回归、真实原生 UI + 隔离 R1 保存/打开、分阶段失败与页面离开保护、深浅主题和窄视口、CI 与自审。

## 验收环境

Ubuntu `quant-server` 本机 Docker；独立 project/task `mw-composite-mapping-20261021`，独立 PG14.24 volume、internal 网络和随机登录凭据。入口仅绑定回环：`https://localhost:18481`，图表 `https://localhost:18482`。使用 D1 合成行情，并运行本目录 `seed.py` 创建三个独立固定历史和合成账户目录。API 使用不可联网的演示账户，通知、Yahoo、OANDA stream 均关闭，无供源 worker。此环境不代表真实供应商可用性。

启动前检查可用内存 8.6 GiB、磁盘 37 GiB，无端口冲突。R1 初始化时保留 mwa 与原交互预览；后续用户授权的 mwa 更新见下节。

构建使用 `mw-docker build`；Web 使用仓库 `python3 deploy/ubuntu/mw_docker.py build`，以携带与真实构建参数一致的 chart-origin 标签；未覆盖主机现有工具。私有状态 `~/.local/share/market-watch-docker/previews/mw-composite-mapping-20261021/`。`fixture-env.json` 仅覆盖本实例 API 的合成账户配置，不含真实凭据。

```bash
# 在本任务 worktree 中。首次已通过 mw-docker preview prepare/up 初始化。
# 复用最终固定 candidate-run.json 与本任务合成账户 overlay；不要重新 seed 其他实例。
sg docker -c 'docker compose -p mw-composite-mapping-20261021 -f /home/quant/.local/share/market-watch-docker/previews/mw-composite-mapping-20261021/candidate-run.json -f /home/quant/.local/share/market-watch-docker/previews/mw-composite-mapping-20261021/fixture-env.json up -d --no-build'
# 停止并保留数据
sg docker -c 'python3 deploy/ubuntu/mw_docker.py preview stop --task mw-composite-mapping-20261021 --project mw-composite-mapping-20261021'

cd web
npm run build
node tests/composite-mapping.cjs
node tests/composite-mapping-native.browser.cjs
```

Playwright 从私有 credentials.json 本地读取登录信息；不得提交完整浏览器状态或凭据。浏览器测试先执行真实保存和首次使用，再在精确路径注入失败响应；注入结果与真实 API 验收分别标记。`MW_LOCAL_ASSETS=1` 仅用于开发期覆盖本地 native bundle，最终候选验证应不设置它。

## 证据

开发期检查已通过：Web/TypeScript 构建；匹配推导、关系/依据验证与 URL 规范化回归；原生 chunk 恢复、单应用路由、原生重启生命周期和凭据恢复回归。

实际 Playwright 已通过十组原生页面检查：三品种推导、真实仅保存、真实保存并打开（组合图表 dataReady，另一图格不变）、空目录及刷新失败重试、丢失保存响应核查及打开失败重试、多映射明确选择、旧账户配置隔离、目录失效重新选择、离开后的迟到响应、深浅主题及 390px 视口。真实保存与首次使用使用隔离 API/PG；异常分支为精确路径注入。

最终 Docker 制品来自干净提交 `c2b7e23855f5a01a57f52feb9de5e99b5bd90127`，三个应用镜像均核对 `dirty=false`，实际容器镜像与[固定清单](candidate.json)一致；API、PG、TLS 健康，Web/图表服务运行，网络与 PG volume 归属本任务。最终浏览器复验未设置 `MW_LOCAL_ASSETS`，直接加载镜像内资源，结果见[报告](report.json)。深色检查显式切换到 Dark 并断言主题，再切换 Light；截图前清除故障注入通知，避免通知自动消失与点击产生测试竞态。后续提交仅补验收脚本与证据，不修改应用制品。

实现提交的 [CI](https://github.com/hezongyi/market-watch/actions/runs/39689947017) 以及证据提交 `1274f42` 的 [CI](https://github.com/hezongyi/market-watch/actions/runs/39690821905) 全部通过，包含 Backend、Web、Compose。交付为 [Draft PR #93](https://github.com/hezongyi/market-watch/pull/93)，未合并或创建正式 tag。未运行四个旧端到端完整场景（仅更新相关选择器并检查语法）；本次以专门的十组真实浏览器检查覆盖映射链路。合成目录与行情不验证供应商联网、凭据或真实产品合约。

截图：[深色](mapping-dark.png)、[展开匹配说明](mapping-proof-dark.png)、[浅色](mapping-light.png)、[390px 窄屏](mapping-mobile.png)。

本人自审：仅前端和原生适配层变更；无数据库或供源规则修改；原生依赖沿用固定图表版本；产品关系不自动确认、依据不自动生成；保存请求不自动重发；未知结果须核查；已保存映射复用于打开重试；上下文切换及卸载阻止迟到应用。单独记录的“系统消息图标对齐”不在本次范围。

浏览器原始报告及截图位于本任务忽略目录 `artifacts/composite-mapping-native/`；本目录仅保留无凭据、无浏览器存储的报告、制品清单与页面截图。

## mwa 更新与真实页面验收

用户明确要求“做好了就先在 mwa 上验收，不先等 CI”。Ubuntu `quant-server`，原 project `mw-issue75-v2-20261018`，入口 `https://192.168.7.232:18280`、图表 origin `https://192.168.7.232:18281`。只更新 Web/Chart：均由干净提交 `1274f42c96409fad33735faf5ee4386cb89e7227` 经 `mw-docker build` 构建，Web 显式指定本实例 chart origin；[固定制品](mwa-images.json)。未因等待 CI 延迟此更新。

[运行审计](mwa-audit.json)：15 服务全部 running、API/PG healthy。所有服务的环境、挂载（按目标路径规范化比较）、网络归属和端口不变；除 Web/Chart 外的容器 ID 全部不变。未 seed、migrate 或重置数据库；未操作保护浏览器。更新前可用内存 8.3 GiB、磁盘 37 GiB。

真实 Playwright UI 登录原五图工作区，连续两次刷新，XAUUSD 的 60/5/1W/1D/240 全部 dataReady、有原生 canvas、无未捕获异常，完整工作区前后相等，revision 42：[报告](mwa-restore.json)。

另一个临时浏览器 context 从“组合行情 → 可建立候选 → 配置实时来源”实际点击进入 XAUUSD；读取真实账户目录并在原生选择器选择 XAU_USD，确认不会自动勾选人工复核；校验按钮/说明文本域的真实原生组件、Dark/Light 与 390px 固定操作区；最后放弃草稿，完整映射列表与工作区前后相等，无映射写请求或浏览器异常：[六项报告](mwa-mapping.json)。[浅色页面](mwa-mapping.png)、[深色说明](mwa-proof-dark.png)、[窄屏](mwa-mobile.png)。mwa 未执行试验性映射保存或创建组合；真实保存/使用及异常恢复由上述独立 R1 覆盖。

初次 mwa 检查脚本误把 POST resolve/quotes 读取接口拦截为写入，随后使用了不受支持的列表路径；已分别修正为放行读取接口及实际点击原生导航，并完整重跑通过。两次失败属于测试脚本问题；最终报告来自直接访问真实部署、无制品替换路由的通过运行。

复验命令（仓库根目录）：`node docs/verification/composite-mapping-native-20261021/mwa-smoke.cjs`。脚本读取本机私有登录文件，临时 context 保护工作区、告警及映射写入；不使用受保护的持久 profile。

现有持久运维入口仍为 `python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`，其 `candidate-override.json` 已更新到本轮固定 Web/Chart，保留其余服务的既有镜像/私有环境。**本轮回退**使用 `/home/quant/repos/.mwa-composite-mapping-20261021/rollback-override.json` 配合原 `integrated-compose.json`，仅对 `web chart` 执行 `up -d --no-deps --no-build --pull never`；同时把该私有目录的 `previous-candidate-override.json` 恢复到运维入口的 `candidate-override.json`，避免下次 start 再升级。不要使用旧 manager 的 `rollback`（它回退到更早版本）。此处仅记录回退方式，未执行回退。
