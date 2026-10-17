# Issue #82 · 单应用完整验收

候选基线为 `v1.26.0` / `51e5d1e2cc6dd241b4aa276a4c02aef6500f5dc3`，分支 `feat/issue82-single-app-20261017`。范围是 [Issue #82](https://github.com/hezongyi/market-watch/issues/82) 的完整应用收敛方案：正式登录、入口和导航、工作区地址、兼容功能、通知/演练/设置、离页保护、浏览器标题和七色收藏。

## 风险与数据边界

分类 **F1**：引入独立、带版本的账户偏好 `mw.symbol-flags.v1`，以及跨页/会话失效的本地草稿恢复。未增加数据库表或迁移，沿用现有 `AdvancedPreference`、revision 和工作区文档格式。最小检查包含 CI、自审、独立 Standards/Spec review、Ubuntu R1、旧偏好/工作区兼容、收藏保存恢复及双窗口并发。

验收使用独立 D0 合成行情和固定历史；真实管理员认证、CSRF、API、PostgreSQL、偏好保存、图表 SDK、行情计算 worker、历史加载和告警事件生成均实际执行。供应商接口由隔离 fixture 提供确定数据，外部供源和投递关闭。本记录不证明真实供应商连通性或生产通知投递。

失败检查明确拦截 503、原生数据中心资源加载失败；标题缺值/频率检查在真实图表的报价消费边界注入数据。空态检查只替换工作区列表的 GET 响应，不删除数据库内容。401 检查实际撤销服务器会话后放行保存请求，验证真实 401 和本地布局草稿保留。

## 验收矩阵

| Issue 验收项 | 检查与证据 |
| --- | --- |
| 1. 统一入口与安全 next | 根入口、登录后图表、search/hash 保留、外站/递归/内部端点回退；`login` 浏览器检查和路由纯测试 |
| 2. 工作区地址与手机 | 指定 ID、刷新、前进后退、无效 ID、上次有效工作区、手机只读；手机 platform 无写请求；桌面/手机空态 |
| 3. 原生菜单与数据中心 | 菜单、待确认数量、告警面板返回；原生数据中心保留图表与 URL；资源失败后真实内部 iframe 加载并关闭 |
| 4. 旧功能承接 | 旧 Watch 取消、旧编辑器 URL/ID/格式保留，旧工作区不会出现在专业工作区列表 |
| 5. 通知/演练/设置 | 真实旧 Watch 和图表事件精确定位、不自动确认、失败重试/确认；固定历史创建演练后同 runId 刷新恢复；通知/声音/系统/账户分组 |
| 6. 脏状态与会话 | 设置及图表的取消/放弃/保存、503 留在原页；原生工作区切换；退出取消；真实 401 后登录页无残留 dialog，图表草稿保留 |
| 7. 正式登录 | 深浅/桌面/手机；真实认证与错误；SVG pattern、≤64 动画点、7–12 秒、focus/busy/hidden/reduced-motion 暂停、输入节点/光标保持 |
| 8. 标签与 favicon | 双图焦点、比较线、非激活图修改、十字线、主图不在列表、快速切换、缺价格/日基准、历史/迟延、1 Hz、非图表标题恢复 |
| 9. 七色收藏 | 七色/清除、键盘焦点、同名不同源、刷新/重新登录、跨列表/工作区、503 重试、真实 409 后逐品种合并、移除成员不清色；虚拟行复用/dispose 独立 DOM 回归 |
| 10. 协议与边界 | API/device/action/MCP/health/SSE 维持协议；Nginx 与 Python fallback；旧偏好兼容、未知版本拒绝、SDK/凭据未提交 |

最终全量 Playwright **20 组全部通过，未捕获异常 0**；401 后还实际复制恢复为独立工作区，核对原工作区文档不变并移除已恢复草稿。机器结果见 `browser/results.json`，浏览器输出见 `browser.log`，后端 21 项见 `backend.log`，纯逻辑及 DOM 回归见 `frontend.log`，Python fallback 见 `python-fallback.log`。`browser/` 截图仅含合成数据，不包含真实密码、cookie 或完整浏览器状态。

## SDK 与兼容/恢复

SDK 能力核对与实施依据见 Issue 引用的[标签/收藏分析](https://github.com/hezongyi/market-watch/blob/8170dc58bfb83f7711254d2558673dd17785e0ef/docs/research/native-chart-tab-colored-favorites-20261017.md)。当前版本 `TT v31.1.0`，hash `6b804c486857f27920cf761aa7eb6e29d9bb6362`；原生旗标功能为空实现。增强代码独立放在 `advanced-host/symbol-flags.js`，绑定完整 ticker 与固定版本 DOM，失配时报告并保留原生列表；没有修改或提交许可 SDK。

收藏使用 `{value:{version:1,flags:{[canonicalTicker]:color}}}`，最多 5000 项，严格校验版本/颜色/ticker，拒绝指标 ticker。列表成员、旧主题/绘图模板和工作区内容独立保存。写入串行，409 重新读取后只合并本次 ticker，最多尝试 3 次；其他失败保留服务器已确认状态并提供重试。旧账户没有此偏好时按空集合处理；未知版本保留原数据并报错。

恢复证据包括真实 PostgreSQL 保存后刷新、跨工作区、重新登录，双窗口版本冲突，旧 `mw.watchlists.v1` 内容不变，旧工作区与 Watch 保留，以及本地草稿含实际 `state.charts`。没有 schema 迁移；候选回退使用基线三镜像与匹配配置，保留新增偏好行和草稿即可，基线忽略独立偏好。旧程序不能继续提供本 Issue 新路由和七色界面；不可通过删偏好或删卷执行回退。本次没有执行生产回退或生产切换。

## 独立审查

- Standards：初审发现布局捕获作用域、会话过期残留离页对话框、收藏 dispose 后异步回调问题；已修复，复审无剩余实质性发现。
- Spec：初审及复审覆盖入口、协议、通知、标题、旧功能和完整范围；最后发现手机 platform 会创建工作区，已改为只读匹配，并为桌面入口创建去重。最终复核无剩余确定缺陷。
- 审查均为只读源代码审查；浏览器和 Docker 验收由主执行者完成。
- 完整浏览器验收新增真实 Compare 后，发现原生 `chart.priceFormatter()` 会跟随百分比刻度，导致标题报价带 `%`。现复用既有价格精度规则格式化原始 `lp`，独立于图表刻度；纯测试与真实比较线场景均覆盖该问题，Spec 再审通过。

## Ubuntu 实例与复现

实际主机 `quant-server` / Ubuntu 22.04.5 LTS，独立 Compose project `mw-issue82-20261017`。

- 应用：<https://192.168.7.232:18282>
- 隔离图表来源：<https://192.168.7.232:18283>
- TLS 为本次验收的自签证书。私有凭据/env/TLS 材料在 `/tmp/mw-issue82-private/`，不入库。
- 常驻 PostgreSQL 512 MiB、API 1 GiB、Web 64 MiB、Chart 128 MiB、TLS 64 MiB；迁移瞬态 1 GiB。独立网络、volume、DB 和端口见 `runtime.json`，其中记录实际 image ID；`source-sha256.json` 记录变更的运行时代码校验和。
- 其他 `mw-issue75-20261017` 和 `mw-v1257-restore` 实例保留。

构建由 `mw-docker build`、builder `market-watch-ubuntu` 执行。当前 sandbox 使用 `/tmp/mw-issue82-private/tools/mw-docker` 作为 task launcher，仍调用已安装工具的实现和共享操作锁，只把不可写工具状态目录改到 task 私有目录。构建用途均为 acceptance，没有改主机工具或 Docker 权限。

在本 worktree 启动/停止（保留数据库）：

```bash
docker compose --env-file /tmp/mw-issue82-private/acceptance.env \
  -p mw-issue82-20261017 -f deploy/ubuntu/single-app.acceptance.yaml up -d --no-build
docker compose --env-file /tmp/mw-issue82-private/acceptance.env \
  -p mw-issue82-20261017 -f deploy/ubuntu/single-app.acceptance.yaml stop
```

镜像替换后重启本任务 TLS，使 Nginx 重新解析 upstream。fixture 文件替换后重新创建本任务 API，避免 bind mount 保留旧 inode。

完整浏览器重跑前，显式复位本任务 D0 的 Watch 和通知交互（只改固定 synthetic 记录，保留事件、工作区与数据库卷）：

```bash
docker compose --env-file /tmp/mw-issue82-private/acceptance.env \
  -p mw-issue82-20261017 -f deploy/ubuntu/single-app.acceptance.yaml \
  exec -T api python /fixtures/single_app_fixture.py --reset-interactions
MW_ACCEPTANCE_SUITE=all MW_ACCEPTANCE_OUTPUT=/tmp/mw82-browser-final \
  MARKET_WATCH_TEST_CREDENTIALS=/tmp/mw-issue82-private/credentials.json \
  LD_LIBRARY_PATH=/tmp/mw-chromium-libs/usr/lib/x86_64-linux-gnu \
  node web/tests/issue82-single-app.browser.cjs
```

当前 Chromium 为本机 Playwright 安装版本；临时动态库只用于解决本机缺失依赖。CI 安装官方 Chromium 依赖，运行纯逻辑和独立 DOM 回归；完整 SDK 集成验收在上述 Ubuntu 隔离实例执行。

实例保留用于候选复核。合并、正式 tag 和生产发布均待用户决定。
