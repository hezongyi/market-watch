# 配置实时来源：原生控件实现与验收

## 需求 / Issue 草案

按用户确认的交互预览实现“数据中心 → 组合行情 → 配置实时来源”。来源对照、一个准确品种选择入口、可展开的匹配说明、人工确认及固定底部“仅保存 / 保存并打开图表”。按钮、文本域、输入、选择和复选框均接入当前图表库真实原生组件，保留既有窗口、主题和宿主通道。

基线：`v1.26.5` / `6f74951`。独立 worktree `market-watch-composite-mapping-20261021`，分支 `feat/composite-mapping-native-20261021`。预览来源：`prototype/mwa-composite-mapping-20261021` 的 `09d99fe`，正式实现不合入演示入口。

风险 **F0**：兼容 UI 与既有 API 串联，未修改后端、schema、固定历史、拼接点或产品匹配合同。最小验证：Web 构建、匹配推导/校验回归、真实原生 UI + 隔离 R1 保存/打开、分阶段失败与页面离开保护、深浅主题和窄视口、CI 与自审。

## 验收环境

Ubuntu `quant-server` 本机 Docker；独立 project/task `mw-composite-mapping-20261021`，独立 PG14.24 volume、internal 网络和随机登录凭据。入口仅绑定回环：`https://localhost:18481`，图表 `https://localhost:18482`。使用 D1 合成行情，并运行本目录 `seed.py` 创建三个独立固定历史和合成账户目录。API 使用不可联网的演示账户，通知、Yahoo、OANDA stream 均关闭，无供源 worker。此环境不代表真实供应商可用性。

启动前检查可用内存 8.6 GiB、磁盘 37 GiB，无端口冲突。mwa 与原交互预览未替换。

构建使用 `mw-docker build`；Web 使用仓库 `python3 deploy/ubuntu/mw_docker.py build`，以携带与真实构建参数一致的 chart-origin 标签；未覆盖主机现有工具。私有状态 `~/.local/share/market-watch-docker/previews/mw-composite-mapping-20261021/`。`fixture-env.json` 仅覆盖本实例 API 的合成账户配置，不含真实凭据。

```bash
# 在本任务 worktree 中。首次已通过 mw-docker preview prepare/up 初始化。
# 复用固定 run.json 与本任务合成账户 overlay；不要重新 seed 其他实例。
sg docker -c 'docker compose -p mw-composite-mapping-20261021 -f /home/quant/.local/share/market-watch-docker/previews/mw-composite-mapping-20261021/run.json -f /home/quant/.local/share/market-watch-docker/previews/mw-composite-mapping-20261021/fixture-env.json up -d --no-build'
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

实际 Playwright 已通过十组原生页面检查：三品种推导、真实仅保存、真实保存并打开（组合图表 dataReady，另一图格不变）、空目录及刷新失败重试、丢失保存响应核查及打开失败重试、多映射明确选择、旧账户配置隔离、目录失效重新选择、离开后的迟到响应、深浅主题及 390px 视口。真实保存与首次使用使用隔离 API/PG；异常分支为精确路径注入。开发期覆盖本地 native bundle；最终固定制品复验和 CI 结果待补充。

本人自审：仅前端和原生适配层变更；无数据库或供源规则修改；原生依赖沿用固定图表版本；产品关系不自动确认、依据不自动生成；保存请求不自动重发；未知结果须核查；已保存映射复用于打开重试；上下文切换及卸载阻止迟到应用。单独记录的“系统消息图标对齐”不在本次范围。

浏览器原始报告及截图位于本任务忽略目录 `artifacts/composite-mapping-native/`。
