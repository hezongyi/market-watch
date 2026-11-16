# 手机端统一行情标识与来源展示验收

日期：2026-11-15。分类：F0（兼容只读字段、手机展示与分页搜索，无 schema 或行情身份变更）。

已实施认可的[方案](../../plans/pending/mobile-market-identification-20261115.md)，基于冻结预览 `20261115T060532-bc588afe2f`。工作区 `market-watch-managed-live-rollover-20261113`，分支 `feat/managed-live-rollover-20261113`，基线 HEAD `17af8e2533eb8ffd4b152135223f51aaa164ecef`；包含本轮增量与此前已授权未提交工作，没有重置工作区。

## 完成范围

- 添加自选、添加自建使用共享两行信息：代码/中文名在左，完整上游名/必要口径在右；单个低饱和分类标签，不堆叠供应商标签。
- 分类按实际元数据区分股票市场、外汇、贵金属、指数/股指、期货、加密、ETF/基金、债券/期权；合约形式为次要文字。未知不猜测，样本夹具不代表新增真实供源。
- 创建设置仅改顶部品种信息；数据列表采用简洁两行，保留实时开关。添加后的自选维持三行、固定列宽、报价与 sparkline。
- 已知 AKShare 上游显示新浪财经、腾讯财经、东方财富；来源/采集通道分开，相关详情、告警摘要及日志使用统一名称。AKShare 启停/刷新保持单个真实通道操作。
- 来源、价格系列在分页前筛选；泛化文字匹配按物理目录复用索引结果，防止四个来源/价格变体反复解码目录文本。数据列表分类元数据批量读取，不逐行请求。
- 网页端共享 `source_display` 文案与现有行情身份/路由不改。真实创建目录保持现有能力；本实例新浪支持创建而腾讯没有独立创建项，不能把原生报价变体当成可创建历史。

## 验证结果

| 检查 | 结果与证据 |
| --- | --- |
| 后端展示、目录、搜索、分页及身份 | **94 passed**，[日志](logs/backend.log) |
| 逐源、逐类别真实目录/UI 抽查 | 6 源 / 26 类型组合 / 38 样本，76 张截图；[完整矩阵、修复与边界](source-sampling/README.md) |
| PostgreSQL 实际分页、来源和价格系列 | **7 passed**，独立临时 schema；[日志](logs/postgres.log) |
| TypeScript/生产构建 | 通过；手机壳 `4ce82908a1c34684`，[日志](logs/build.log) |
| 本轮两行信息浏览器测试 | 通过；375/412、深浅主题、150%字号、长代码、分类、来源/价格区别、原位添加、创建顶部和原表单，[结果](browser-proof.json) |
| 共享搜索与数据全流程 | 通过；分页、重复排除/成功留勾、返回、请求取消、表单/冲突/离线/实时操作均用夹具；[搜索](logs/symbol-search.log)、[数据流程](logs/data-workflow.log) |
| 自选/图形回归与关联展示 | 通过；[自选](logs/watch.log)、[A07 几何](logs/geometry.log)、[告警](logs/alerts.log)、[日志存储](logs/logs.log) |
| 实际实例只读验收 | 登录、来源搜索、数据列表、添加自建目录、readyz200、更新清单200、既有 APK 大小/SHA256、缺失包404；[结果](runtime-proof.json) |
| 人工截图检查 | 已查看冻结预览、夹具及真实界面；来源/价格差异可见，常规两层信息，放大字号允许必要换行，未见横向溢出。见下方截图 |
| 格式/增量自审 | `git diff --check` 通过；核查保存身份优先、源/通道边界、分页前筛选、未知分类降级 |

真实数据验证：`300750 新浪财经` 返回新浪前复权/不复权；`300750 腾讯财经` 返回腾讯前复权/不复权；`300750 AKShare` 覆盖四条。`宁德 腾讯财经` 在 UI 不混入新浪。这里只验证读取，未修改用户真实自选或自建配置。

最终查询耗时和首屏身份摘要见 [search-comparison.json](search-comparison.json)，原始三轮记录见 [search-deployed.jsonl](search-deployed.jsonl)。这组数据为任务实例的进程内服务查询耗时，不包含手机网络。优化前后测试关键词首屏身份摘要一致；全分页正确性另由 PostgreSQL 测试验证。只输入供应商名会匹配整个目录，仍比代码/名称组合搜索慢，不宣称所有搜索都能瞬时完成。

## 截图

- [真实添加自选：腾讯两种口径](screenshots/runtime-search-tencent.png)
- [真实数据列表](screenshots/runtime-data.png)、[真实添加自建](screenshots/runtime-catalog.png)
- [375 浅色](screenshots/fixture-search-375-light-14.png)、[412 深色](screenshots/fixture-search-412-dark-14.png)、[375 大字号](screenshots/fixture-search-375-light-21.png)
- [合约区别](screenshots/fixture-crypto-375-light-14.png)、[创建设置顶部](screenshots/fixture-create.png)
- [自选基线](screenshots/runtime-before-watch.png)、[更新后自选](screenshots/runtime-after-watch.png)；行情实时变化不作为像素回归证据，几何回归使用固定夹具。

## 运行入口与回退

实际运行于 **Ubuntu 本机 Docker**，Compose project `mw-managed-live-rollover-20261113`。

访问：**https://192.168.7.232:18447/m/watch** 。API/web 固定镜像及更新前镜像见 [deployment.json](deployment.json)，没有数据库迁移，数据库/worker 沿用本任务隔离资源。本次没有操作 Unraid 生产环境。

启动/停止（仅本任务）：

```bash
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

私有配置位于该 task 目录；初次更新前留档 `run.json.before-mobile-identity-20261115T064130Z`、`compose.json.before-mobile-identity-20261115T064130Z`。如需回退，保留当前配置副本后，按 deployment.json 的旧镜像恢复两份配置中的 api/web image，执行该 project 的 `up -d --no-build --no-deps api web`；不回滚数据库、不删除 volume。后续索引优化也各自保留配置留档。

## 手机端待验收

本轮为服务端 WebView 资源更新，**无需新 APK**；原 Android 下载包仍为 `0.1.3`，已校验下载完整性。连接上述验收地址，重新打开 App 获取当前页面；没有把浏览器窄屏当作 Android 真机验收。

用户真机重点：添加自选区分同名来源/复权、添加自建与创建顶部一致、数据列表简洁、自选主列表未走样；再看实际系统大字号和输入法下的可读/可达性。真实行情的运行状态不在本次来源显示任务中重新认证或改配。
