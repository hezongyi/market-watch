# Issue #88：告警编辑与 Yahoo 解析恢复

## 范围与候选

- 基线：`762067a83fa2fca20c9158ea67cafae838861c19`（v1.26.2）。
- 分支：`fix/issue88-alert-editing-recovery-20261021`。
- 风险分类：**F0**。兼容扩展 API/RPC/UI；不改变 schema、持久格式或告警判定语义；不包含 #89。
- 最小检查：真实组件和确定性请求竞态、真实 HTTP 路由错误映射、Web build、PR CI、自审、Ubuntu R1。
- 不操作长期验收规则、生产实例或外部通知。

## 改动与自审

1. 条件在关系切换、恢复和提交时规范化互斥字段，保留零值与价格精度；后端严格校验保持有效。
2. 保存和生命周期操作立即提交完整服务端 row；列表/事件独立刷新，mutation fence、合并刷新和归档屏障阻止旧结果覆盖。工作区/面板重新打开拥有独立请求生命周期。
3. 历史事件展示与搜索共用冻结配置中的名称、条件摘要、品种和正文。
4. HTTP/RPC 传递结构化字段错误；中文提示定位字段并提供 aria 关联。409 显式重新读取、保留草稿，不自动覆盖另一窗口修改。
5. Yahoo 临时失败返回结构化 503，未知品种仍为 404。最多三次自动读取，尊重冷却和非重试错误；每图格反馈、明确重试、阻止未解析身份创建告警；诊断日志仅记录 attempt_id、阶段、异常类和上游状态。

自审重点：检查完整 row 的控制修订与运行观测、StrictMode/卸载隔离、归档不复活、错误体不展示 input/ctx、限流剩余时间向上取整、原生失败缓存和切图格后的回调隔离。未修改许可库或纳入凭据。

### 原生恢复适配边界

实际许可 v31 在同品种 `setSymbol`、`resetData`、仅重启 series 时仍复用失败的 resolve Promise。本补丁针对固定 v31，检查私有适配形状，仅移除目标品种及 currency/unit/session 变体的 rejected Promise，再重启请求图格的 series。成功缓存、其他品种保持有效；每次 await 后检查 chart/epoch/generation，适配不可用时显示重新打开工作区的反馈。

这是固定许可版本的兼容适配；升级许可库必须重新运行以下原生集成测试。自动 CI 不包含私有库，不能代替该验证。

## 本地验证（Ubuntu quant-server，2026-10-21 UTC）

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过（类型检查与生产构建） |
| changed Python Ruff、`git diff --check` | 通过 |
| `test_chart_alert_api.py`、`test_resolve_failures.py`、`test_chart_alert_domain.py` | 30 passed |
| `api-read-recovery.cjs` | 有限重试、认证/配置、冷却、取消、脱敏及旧 RPC 通过 |
| `resolve-recovery.cjs` | 失败/成功缓存隔离、晚到拒绝、并发消费者、冷却和生命周期通过 |
| `chart-alerts-bridge.test.cjs` | 8 passed |
| `alert-editing.browser.cjs` | 9 组真实 React/Chromium 回归通过 |
| `native-alert-ui.integration.cjs` | 13 组真实许可图表/原生窗口回归通过 |
| `native-alert-workspace.integration.cjs` | 6 组真实 AdvancedWorkspace + 许可图表回归通过；无浏览器异常或意外请求 |

原生工作区回归验证：三次失败后显示图格反馈并禁用创建；显式重试同品种仅增加一次 resolve；原生 dataReady 且 stream subscribe 的 history_accepted 为 true；D1 加载；H4 切 Yahoo 后迁移 H1 并接受历史数据。API 为浏览器受控替身，**不是部署 R1 或真实 Yahoo 网络验收**。

此前完整本地后端运行：2058 passed、563 skipped、38 setup errors；38 项因缺少 `TEST_POSTGRES_URL`，不能宣称本地全绿。PR CI 使用独立 PostgreSQL 14.24 补齐。

可复现命令（工作区根目录；Node 命令在 `web/`）：

```sh
PYTHONPATH=backend .venv/bin/python -m pytest backend/tests/test_chart_alert_api.py backend/tests/test_resolve_failures.py backend/tests/test_chart_alert_domain.py -q
```

```sh
npm run build
node tests/api-read-recovery.cjs
node tests/resolve-recovery.cjs
node --test tests/chart-alerts-bridge.test.cjs
node tests/alert-editing.browser.cjs
MW_PROBE_LIBRARY=/private/path/charting_library node tests/native-alert-ui.integration.cjs
MW_PROBE_LIBRARY=/private/path/charting_library node tests/native-alert-workspace.integration.cjs
```

## Ubuntu R1 与 CI 状态

R1 **待完成**。此前 `preview up` 因主机高负载被工具拒绝；已请求用户协调并发，不绕过保护或停止其他任务。01:04 UTC 只读复查：已有 `mw-issue75-v2-20261018`（15 容器）与 `mw-issue89-20261021`（5 容器），可用内存约 7.6 GiB、磁盘约 28 GiB。本任务预计常驻约 1.2 GiB，使用独立 PG/API/Web/Chart/网关及 project/network/volume/凭据；等待协调回复后再启动。

- 任务/project：`mw-issue88-20261021`。
- 计划地址（尚未运行）：`https://localhost:18488`，Chart `https://localhost:17488`。
- D1 数据集：`d1-v1-ef528135a493`；通知与 Yahoo 默认禁用。
- 旧 c1 候选已过时，需同任务重建；最终实际镜像 ID 应以 `run.json` 为准。
- 私有状态：`~/.local/share/market-watch-docker/previews/mw-issue88-20261021/`；不提交凭据或完整浏览器状态。

```sh
.venv/bin/python deploy/ubuntu/mw_docker.py preview up --task mw-issue88-20261021 --project mw-issue88-20261021
.venv/bin/python deploy/ubuntu/mw_docker.py preview status --task mw-issue88-20261021 --project mw-issue88-20261021
.venv/bin/python deploy/ubuntu/mw_docker.py preview stop --task mw-issue88-20261021 --project mw-issue88-20261021
```

PR CI 待创建 Draft PR 后运行。R1 与 CI 证据补齐前不关闭 issue、不合并；生产发布另行授权。
