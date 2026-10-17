# v1.25.9 自选表源码交付与生产前流程

2026-10-17。PR [#78](https://github.com/hezongyi/market-watch/pull/78)、[#79](https://github.com/hezongyi/market-watch/pull/79) 已合并，main 整合提交为 `6c156c6cfb214e6f270da6fb6d5e1c9b2336a0e2`。最终运行实现为 `eab74f71bbcccb3e3f4127f85ec306208025f704`，后续 `342645c`、`0d545ed` 仅补充证据及验收脚本。完整受测 head `0d545ed27b50eed4b27a151030f83272c4f47a11` 与该 main 提交的 tree 相同。

用户授权创建并推送附注标签 `v1.25.9`，未授权生产部署。发布整理同步 Python/web 与锁文件根版本、README、CHANGELOG 和源码记录；不修改已受测运行代码、依赖、迁移或持久格式。按仓库流程，标签指向版本整理合并后的 main 提交，以 `git rev-parse 'v1.25.9^{commit}'` 解析；不得移动或覆盖既有标签。[源码清单](../deploy/releases/v1.25.9-source.json) 保留实际受测来源，不把旧验收镜像改称新标签构建。

## 验证结果及边界

原任务分类为 F1 / R2，版本整理为 P0。PR #79 最终 head 的 [CI](https://github.com/hezongyi/market-watch/actions/runs/38985845780) backend、web、compose 全部通过；web 包含 bridge、启动及 Chromium 原生 DOM 回归。独立 Standards、Spec 复审均无剩余阻塞发现。版本整理自身 CI 须按其最新 head 检查，不以旧 head 成功替代。

[真实补验](verification/pro-chart-watchlist-20261016/review-followup.md) 使用真实表单登录，不拦截或注入行情：Binance BTCUSDT 从 81,572.66 更新至 81,572.67；原生完整数值文本、上标、亮暗主题、悬停及移出通过，页面错误为空。组合真实已确认 M1 存量价为 1.12384，D1 完整基准缺失时涨跌省略。七张截图均逐张审阅；活动列表、当前五条品种、主题和主图恢复，临时列表删除后确认偏好落库。

休市重启后，四条 OANDA 平台行当前报价不可用，历史图仍能加载；该结果没有记为 OANDA 有价详情、持续更新或全部来源验收通过。隔离实例只读诊断见 `provider_chart.quote_page → cached_page → HistoryPending`：现有 REST batch 最新路径对活动订阅要求缓存新鲜，重启后内存报价回退为空。该路径未由 #79 修改；仍需查清缓存时效、休市和冷启动恢复的正确语义并补验，不能仅凭工作日恢复有价宣称冷启动问题已解决。

完整搜索／添加／持久化的统一品种模型仍是后续工作；物理触屏、生产规模和长期稳定性未由本次补验证明。验收实例继续保留在 Ubuntu `quant-server`（`192.168.7.232`），地址 <https://192.168.7.232:18483/advanced-charts>，Compose project 为 `mw-issue73-real-20261016`，不是 Unraid 转发实例。凭据不提交源码。

```bash
docker compose -p mw-issue73-real-20261016 -f /tmp/mw-issue73-real/compose.json up -d --no-build
docker compose -p mw-issue73-real-20261016 -f /tmp/mw-issue73-real/compose.json stop
```

## 后续生产部署顺序（尚未执行）

1. 处理 OANDA 冷启动／休市报价门槛，并在 Ubuntu 隔离实例用真实数据复验。若需要应用修复，走新 PR、适用验收及新版本标签；保留 `v1.25.9`，不移动标签。
2. 只读核对 Unraid 生产实际版本、固定镜像、schema、OANDA 采集模式、私有配置、磁盘和可用回滚点。历史文档不能替代当前状态；本次不改变 REST／stream 策略。
3. 确定最终待部署标签、固定镜像及备份／回退清单。用户后续授权正式镜像构建与生产发布后，在 Ubuntu 通过 `mw-docker`、`purpose=release` 从干净标签构建，逐服务记录提交和 image ID。使用根 `compose.production.yaml` 生成独立 `compose.release.yaml`，固定镜像引用，保留私有代理、数据库和账户配置；全部后端有效配置保持 `ALERTS_YAHOO_ENABLED=true`。
4. 按授权的备份方案准备发布。若用户选择“走轻量补丁流程”，先核实最近已实际恢复的备份仍适用，复用恢复证据，保留本次配置归档与旧镜像；出现 schema／持久格式变化、备份不适用或生产异常时按 AGENTS.md 检查点报告。历史 `alerts-20261016T000503483109Z.dump` 的恢复证据见 [v1.25.7 生产记录](oanda-rest-v1.25.7-production-delivery.md)，不据此假定覆盖此后的生产数据。
5. 在明确生产授权范围内传输并核验固定镜像，按计划暂停必要写入者、核对迁移（本版本无新增迁移）、仅切换 `market-watch` 生产 project。检查 API 健康、各 worker 和必要的 nginx 上游更新；记录实际维护时间，不承诺零停机。
6. 真实登录生产网页检查自选表首屏名称、平台／自建／组合详情、上标和主题、真实报价与历史图，检查 Yahoo 实际 Settings／读取及 worker；保持用户列表与偏好，记录观察窗口、异常及回退依据。出现异常先保留现场并按授权边界处理，生产删除和回滚不从源码 tag 授权推断。

当前仓库仅有 `ci.yml`，触发 PR 及 main push；推送 tag 不会自动构建或部署生产。本次没有正式 Docker tag、生产镜像传输、生产备份、停写、迁移或切换。
