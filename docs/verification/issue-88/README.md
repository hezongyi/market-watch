# Issue #88：告警编辑与 Yahoo 解析恢复

## 范围与候选

- 基线：`762067a83fa2fca20c9158ea67cafae838861c19`（v1.26.2）。
- 分支：`fix/issue88-alert-editing-recovery-20261021`。
- 风险分类：**F0**。兼容扩展 API/RPC/UI；不改变 schema、持久格式或告警判定语义；不包含 #89。
- 最小检查：真实组件和确定性请求竞态、真实 HTTP 路由错误映射、Web build、PR CI、自审、长期验收实例。
- 本轮更新长期验收实例；生产发布和通知发送未执行。

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
| PR #91 CI `39525469540` | 分类、PostgreSQL 14.24 后端全量测试、Web 和 Compose 全部通过；后端 16m29s |

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

## 长期实例验收与 CI

2026-10-21 UTC，候选 `5f67b16b98057efde3a2b0394e7ab5562eade587` 已更新至登记的长期实例 `mw-issue75-v2-20261018`。入口为 `https://192.168.7.232:18280`，图表 origin 为 `https://192.168.7.232:18281`。应用服务运行于候选镜像：API `sha256:b74b4541bd3742c03b18fb0efdfcd2520e754203546657f756ce78b298416b30`、Web `sha256:ca0ced42ff77eb4c3d0928725a01ee7a1f227daa389a406ee2fe622ae6dd6a93`、Chart `sha256:26d903c0e74f0d913b0dcede9ab49a4d74135e87653e74160220dccaf88bfbd6`。API、PostgreSQL healthy；13 个应用容器运行，gateway 与 PostgreSQL 容器未替换，两个入口 HTTP 200。更新沿用原 Compose project 和配置；未运行 seed/migrate，未清理既有容器或数据。

使用独立、临时 Playwright context 登录真实实例，没有连接或改动受保护的浏览器 profile。原生告警列表、条件关系切换（区间与标量互切）、同一草稿连续编辑和历史事件搜索通过；草稿以取消结束。告警写请求被拦截，没有创建、编辑、暂停或归档任何告警。Yahoo 实测将 AAPL resolve 请求拦截为三次结构化 503，主页面显示显式重试；点击后实际 resolve 返回 200，图表重新进入 `dataReady`，无残留 resolve 错误。测试后恢复原 `MWP:EURUSD` 图表；服务端工作区仍为 EURUSD / 60，revision 7。工作区保存请求在恢复测试期间拦截，未保存临时 Yahoo 状态。无浏览器 page error。

数据源与投递开关保持原配置：Yahoo 和 OANDA stream 已启用，通知投递保持关闭；没有发送真实通知。PostgreSQL 持久卷、认证、端口、TLS、gateway、图表 origin、私有配置及受保护浏览器现场保留。精确回退 overlay：`/home/quant/repos/.mw-issue88-longterm-20261021/rollback-override.json`。

PR #91 第二轮 CI 全部通过：分类、Backend、Web、Compose 均为 pass；Backend 全量测试耗时 16m28s。Issue 仍开放，PR 保持 Draft；未合并、未发布生产。
