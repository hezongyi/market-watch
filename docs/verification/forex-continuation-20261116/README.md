# 普通外汇实时接续修复

2026-11-16，`feat/managed-live-rollover-20261113`。F1：扩展自建行情的价格产品准入规则，涉及实时接续后台链路；不改 schema、数据集身份、映射格式或历史/实时数据。保留工作树此前的手机端与实时流恢复修改。

## 原因与修复

18447 的 Dukascopy USD/JPY 自建历史已发布，当前 OANDA 账户目录有可用的 USD_JPY、CURRENCY、3 位精度，但服务端仅允许 EUR/USD、USD/CAD 和特例黄金。只读 API 探针对 `continuation.supported` 的断言失败，映射检查返回 `needs_information`。原列表未核对产品资格，仍显示“待配置”。

修复前新增回归：16 failed、6 passed、22 skipped，捕获普通外汇被拒和列表原因失真。实际 worker 已动态订阅启用的自建目标，常驻品种列表不是上限，无须修改采集策略。

普通外汇现在按 Dukascopy 固定 SDK 的实际外汇分类、OANDA 当前账户 CURRENCY 目录和准确货币对顺序核对；同源 OANDA 保留 v20 / practice / 当前账户边界。SDK 把金银命名为 FX_METALS，额外用现有资产分类排除，不能仅凭名称前缀放行。未核实品种继续阻断。M1/Bid、精度冲突、账户变化、黄金产品差异确认与保存幂等检查保留。

明细与批量列表共用资格判断；未配来源、目录无品种、规则未支持分别说明，不再一律显示“待配置”。没有逐行查询目录。保存映射本身不启动采集。

## 验证

- [SQLite 回归](sqlite.log)：49 passed、22 skipped；另补 [来源边界](source-boundaries.log) 6 passed。错误 channel / environment / account 被拒。
- [隔离 PostgreSQL 及相关回归](postgres.log)：179 passed、1 skipped，覆盖普通外汇、金属排除、准确配对、精度、保存/启停、动态 worker demand、既有映射、基线轮换和前次流恢复。使用任务测试 PG 25476 的随机 schema，不写验收实例数据。
- PostgreSQL 中跳过的是使用独立环境变量的旧映射迁移兼容测试，随后显式指向同一隔离测试 PG 补验，见 [兼容性日志](mapping-compatibility.log)。本补丁部署不执行迁移。
- Standards / Spec 独立审阅均无阻断项；Spec 按最终测试快照独立重跑 55 passed、22 skipped。确认 SDK 有 68 个普通外汇，金银已排除。Ruff 与 `git diff --check` 通过。
- [Docker 构建](docker-build.log) 使用 `mw-docker` 和本任务标签，继承现有流恢复镜像、安装当前后端；无依赖变更。
- 原始只读 API 复现已转绿：USDJPY supported=true，未保存映射、未自动开启。
- [浏览器验收](browser.json)：375/412px 自动匹配 USD_JPY，“来源核对通过”和“确认并开启”可用；无页面异常、无保存/启用写请求。截图 [375px](usdjpy-375.png) / [412px](usdjpy-412.png) 已目视核对。这是浏览器验证，未替代 Android 真机。
- [运行检查](runtime.json)：readyz、容器镜像及原有 EURUSD/USDCAD/XAUUSD 配置保留；USDJPY 未被自动开启。上游流的重连观测另存 [stream-observation.json](stream-observation.json)。

实际限制：部署后重连遇到之前已有的 OANDA 间歇性 401，自动重试仍返回 unauthorized，本轮观察未确认实时流恢复。没有清除认证暂停、修改凭据或伪造报价；新旧镜像的采集、流、worker 和实时开关代码 [哈希一致](stream-code-comparison.json)。因此本次确认的是 USDJPY 可正确配置和开启入口可用，不能把产品匹配通过表述为当前已收到实时价格。

## 部署与回退

实际运行于 **Ubuntu 本机 Docker**，复用本任务独立 project `mw-managed-live-rollover-20261113`，地址 **https://192.168.7.232:18447/m/data**。仅替换 api / market-runtime / data-worker 镜像，web、APK、私有配置其余项与数据卷保留；无需重装 APK。候选和旧镜像见 [deployment.json](deployment.json)。未操作其他实例、Unraid、PR、CI、commit 或正式 tag。

启动/停止：

```sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

私有配置备份为任务目录 `forex-continuation-20261116-backup/`。需要回退时，仅将 run.json/compose.json 中上述三个服务 image 恢复为 deployment.json 的 previous，再执行：

```sh
docker compose -p mw-managed-live-rollover-20261113 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/run.json \
  up -d --no-build --no-deps api market-runtime data-worker
```

没有数据库结构变更，不回退或删除数据卷。配置/身份信息与凭据只保留于本机私有目录。
