# OANDA 认证短重试验收

日期：2026-11-16。分支 `fix/oanda-auth-retry-20261116`，基线 `2c984298261898fef40867ea01dad79cbdc2770a`（main/v2.0.12）。分类 F1：调整重要后台数据链路；没有 schema、持久状态或规则生命周期改动。

## 实现与边界

OANDA 只读 GET 遇到 401 时最多三次总尝试，间隔约 1s、2s（±10% 抖动）；403 和空凭据不短重试。所有尝试共用原 deadline，支持取消，每次重新取得现有额度，等待期间不占额度。持续失败保留原 unauthorized/认证暂停语义。流只重试握手，已建立流不重放。覆盖 catalog、REST 最新/补拉/每日确认、历史和原生图表。

日志仅输出 operation、进程内盐化匿名标识、次数、状态、恢复结果、安全 RequestID 和允许列表错误原因。未更换 token、代理或来源。

## 自动验证

- [基础回归](unit-tests.txt)：249 passed、13 skipped；运行于最后两项凭据边界测试、数据库恢复测试增加之前，运行时代码相同。
- [最新重试专项](retry-tests.txt)：28 passed，包含 401→200、连续 401、403、空凭据、取消/deadline、额度释放、流不重放、真实代理 transport 选择。
- [图表及历史回归](history-tests.txt)：168 passed、1 skipped；包括 401 保留相同时间窗口，不触发 future-to 回退。
- [PostgreSQL 回归](postgres-tests.txt)：65 passed（108.59s）；覆盖实际 adapter 401→200 后提交、确认前沿、无认证暂停、持续失败的暂停及恢复、告警输入、价格确认。
- 所有变更 Python 文件 Ruff、`git diff --check` 通过。

新增恢复测试将正常报价先发布，再验证确认 K 线 ready；这保留了正式链路需要活跃连接的条件。旧 401 请求次数断言按三次尝试更新；429 仍单次。数据库测试只让 401 admission 时钟正常推进，429 固定时钟继续验证精确 cooldown 边界。

## Ubuntu Docker R1

主机：当前 Ubuntu；task/project 均为 `mw-oanda-auth-retry-20261116`。API-only 隔离实例地址 `http://127.0.0.1:18448`，独立 PostgreSQL、网络、volume、凭据。无真实告警规则和通知发送。

通过 `mw-docker build` 构建并部署，运行镜像 `sha256:84b16024a855b0e4988f4ce6b7d83769cbf3baf7a2cf3b340b0a0a2755342f23`。逐字节核对七个变更 runtime 文件与容器一致。[/readyz、登录、认证 health](docker-smoke.json) 均 200；PostgreSQL 14.24、迁移 head `bd57_notice_source_poll_index`，和基线相同。启动时的临时 PG 暴露实验已撤回，最终使用原受管 compose 和内部网络，无额外 PG 端口。

```bash
python3 deploy/ubuntu/mw_docker.py preview up --task mw-oanda-auth-retry-20261116 --project mw-oanda-auth-retry-20261116
python3 deploy/ubuntu/mw_docker.py preview stop --task mw-oanda-auth-retry-20261116 --project mw-oanda-auth-retry-20261116
```

真实上游验证在同一 Ubuntu、同 task PostgreSQL 的独立 `auth_probe` 库运行当前 worktree 的实际 `oanda_worker`，没有操作其他实例数据库。复用既有配置中的只读 OANDA 凭据及代理，未输出秘密。API 容器本身未启用此 worker。

[真实采样](live-observation.json)：2026-11-16 14:09:23—14:11:53 UTC，每 25 秒采样，共 7 次、worker 观察 175 秒。EURUSD、USDJPY、XAUUSD、USDCAD 每次均 quote_ready/candle_ready；各自序号与确认 M1 前沿推进，confirmation_error 始终为空。worker 正常停止。

本次真实观察未出现 401，不能据此证明真实 401 已根治。短重试恢复由故障注入证明；完整交易日、开收盘边界及自然 401 恢复尚待长期观察。未启用或复活真实规则，未验证手机通知实收。

## 独立审查

按 AGENTS.md F1 要求完成独立 Standards 和 Spec review。两项最初发现并已复审修复的问题：显式 client proxy 绕过自定义 deadline transport；历史读取覆盖外层 deadline。最终两份审查均无阻断项（专项分别 26/25 项；此后仅补测试）。

## 部署范围

用户随后明确要求常规验收直接使用开发实例，已将 `f0ff440a` 部署到 Ubuntu `mw-dev` / https://192.168.7.232:18443/m/ 。仅替换四个后端服务，镜像 `sha256:774d763b56856e0de21260ced23e8d2d5f8c4c1bee586d3ebd0911964b73eceb`；Web/APK 0.1.4 无变更。启动/停止使用 `mw-dev up` / `mw-dev stop`，launcher 和 backup helper 已核对指向当前配置和 `dev_mobile_20261116`。

[开发部署证据](development-deployment.json)：严格 TLS、ready/login、四个服务的七份源码逐字节一致；148 个品种配置、13 个维护配置、两条规则及版本/生命周期、图表偏好、241 个稳定 preference key 与部署前一致。更新前保存约 1.1GB 一致性 pg_dump，未恢复/重建库、未改 schema；旧镜像及 run.json、launcher 保留于私有更新目录。

2026-11-16 14:23:15—14:24:55 UTC 五次采样：启动后先处于连接恢复，随后四品种 quote/candle ready，序号与确认 M1 推进。跨连接 epoch 序号会重置，推进判断只比较本次已连接阶段。告警后台心跳推进；两条既有规则生命周期未改变，不宣称活动规则或通知实收。

本次捕获真实握手 401：14:23:13 首次 401，14:23:15 第二次 200；随后正常更新。较早一次 401 后重试遇到总预算内超时，后台按原机制再连。证明观察到了自然 401 的短重试恢复，不能证明全天或永久消除上游认证故障。

开发实例当前数据/凭据/供源/通知策略保留，Unraid 未触碰。未合并、未打正式 tag、未发布生产。私人日志、数据库口令及 token 均留在仓库外。
