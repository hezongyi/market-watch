# PR #38 修复与合并复核

2026-10-11。结论：前轮发现的两个 P2 和一个 P3 已修复，Standards / Spec 独立复核均无剩余合并阻断项。未实际合并或发布生产。

审查基线为 main `6a928ce035739faa7c8b501f6a42165d30253cd7`，原 PR head 为 `b9609b9`。修复提交 `3208779`、`c77f67c`；最终应用源码为 `c77f67cde53fd1b95d4147b50ee4e6ecb3074a69`。本目录之后的证据提交不修改应用源码，摘要见 [source-hashes.json](source-hashes.json)。

## Standards

前轮 P2：chart Dockerfile 改用仓库根 context，但 `mw-docker build --component chart` 仍默认使用 advanced-host，导致 COPY 缺失。

已将默认 context 改为仓库根，并明确使用 `advanced-host/Dockerfile`，保留显式参数行为。默认构建参数的回归检查通过；Ubuntu 已安装入口与仓库脚本逐字节一致，实际默认 chart 构建成功，使用专用 `market-watch-ubuntu` BuildKit 和本任务标签。独立 Standards 复核无剩余发现。

## Spec

前轮 P2：画线告警 H1 改 H4 后保留旧 bar-index，保存虽返回 201，worker 随后 blocked。

保存前通过限定 RPC 调用既有 geometry API，按目标来源/周期重新映射端点；映射失败保留草稿且不发保存请求。缓存映射结果，保存 503 后重试使用相同 request_id 和完整配置。真实部署验证 H1 端点 0/4 改为 H4 0/1，保存 201，独立 worker 达到 ready。provider / composite 参数透传和重试内容一致另有模拟 API 探针，见 [geometry-retry-probe.json](geometry-retry-probe.json)。

前轮 P3：消息/通知子页返回时恢复入口焦点被 effect 覆盖。现在统一由 page effect 恢复入口焦点，覆盖原生窗口及 standalone 表单，并清理延迟 timer。独立 Spec 复核无剩余发现。

## 验证结果

| 检查 | 结果 | 范围与证据 |
| --- | --- | --- |
| Docker lifecycle 单元检查 | 53/53 | [日志](ops-tests.log)，包含默认 chart context/file |
| JS RPC/bridge、行情流、工具栏、报价、范围 | 15/15 | [日志](js-tests.log) |
| 告警 domain/API/service/geometry/worker | 51 passed | [日志](backend-tests.log)，包括真实 API/worker 周期回归 |
| 前端 TypeScript/Vite 构建 | 通过 | [日志](web-build.log) |
| 原生 UI 集成 | 13 组通过 | [结果](ui-integration.json)，Ubuntu Chromium + 真实许可库 + 模拟 API |
| 完整工作区集成 | 4 组通过 | [结果](workspace-integration.json)，Save As/load、旧响应、409 |
| standalone 表单 | 4 组通过 | [结果](standalone-ui.json)，包含键盘焦点 |
| 最终 Docker 修复验收 | 2 组通过 | [结果](runtime-fixes.json)，真实 UI/API/PG/自主 worker，任务内合成 K 线 |
| 最终 v1.19 共存验收 | 4 组通过 | [结果](runtime-v119-coexistence.json)，真实 Binance SSE、数据中心/指标/草稿/主题 |
| 升级前 PG 备份实际恢复 | 通过 | [结果](postgres-backup-restore.json)，所有 public 表行数、告警及工作区完整内容一致 |

浏览器检查均无页面异常及传入图表域凭据。v1.19 共存检查验证六个数据中心入口，包括交易日历，以及来源状态真实读取；未覆盖交易日历页面查询与交互。本轮未重跑历史目录的全部故障/通知投递场景，相关历史证据保持原时间与版本范围。

最终 API/web/chart 及 workers 均运行 clean `c77f67c` 构建镜像；从容器实际 Image ID 核验标签，而非只读取可变 tag。API 安装版本为 1.19.0，迁移头 `ar45_market_stream`，API/PG healthy，两个 HTTPS 入口均 HTTP 200，见 [runtime-environment.json](runtime-environment.json)。GitHub 未报告外部 CI checks；上述检查为本机验证。结果汇总见 [validation.json](validation.json)。

## Ubuntu 验收访问与启停

实际主机：Ubuntu `quant-server`（192.168.7.232）。本机 Docker task/project 均为 `mw-native-alert-ui-runtime`，独立网络、PG volume 和数据库；实例继续保留供用户验收。

主站：`https://localhost:19643/`；图表域：`https://127.0.0.1:19644/`。两个端口只绑定 Ubuntu loopback，其他电脑先转发：

```bash
ssh -N -L 19643:127.0.0.1:19643 -L 19644:127.0.0.1:19644 quant@192.168.7.232
```

管理员密码沿用私密 `/tmp/mw-native-alert-ui-runtime/login.json`，未提交。env、TLS 私钥、数据库 dump、回滚清单和许可库也均留在仓库之外或 ignored 目录。

从 `/home/quant/repos/market-watch-native-alert-ui-v118-20261011` 启动或停止此实例：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-native-alert-ui-runtime/compose.env \
-p mw-native-alert-ui-runtime -f compose.native-alert-ui.yaml --profile notification-test \
up -d --no-build'

sg docker -c 'docker compose --env-file /tmp/mw-native-alert-ui-runtime/compose.env \
-p mw-native-alert-ui-runtime -f compose.native-alert-ui.yaml --profile notification-test stop'
```

如需重建，使用 `mw-docker build` 或 `compose-build` 并指定本任务/project、用途 acceptance。验收尚在进行，不 finish/retire，不删除数据卷。

最终 runtime 复跑按顺序执行，避免两个浏览器会话同时改写工作区：

```bash
LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu \
MW_REVIEW_OUTPUT=/tmp/mw-pr38-final-runtime \
node web/tests/native-alert-review.runtime.cjs

LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu \
MW_ALIGNMENT_VERSION=1.19.0 MW_ALIGNMENT_OUTPUT=/tmp/mw-pr38-final-runtime-compat \
node web/tests/native-alert-v118.runtime.cjs
```

Standards：0 项剩余发现；Spec：0 项剩余发现。支持合并，固定版本私有组件在许可库升级时仍需验证。
