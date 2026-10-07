# 组合定义与固定首次使用基础验证

日期：2026-10-06。此为 C 阶段内部基础模块，尚无可使用的组合图表或策略。
本地分支 `feat/market-data-integration`，Ubuntu 独立 project `market-watch-three-layer`。

## 已实现的约束

- `composite_definitions.save_mapping` 保存明确产品匹配：标的、报价币种、历史/实时产品类型、
  同产品或相同标的不同产品的关系、两侧依据、复核说明、Bid 口径与精确来源身份。
  从当前账户目录选择目标，不通过删符号自动推断经济等价。首版目标为 OANDA Practice。
  已知外汇/金属类别和准确代码与声明逐项核对；依据 URL 不接受凭据。
- 映射是不可变版本，读取/保存映射不创建组合或行情需求。登记的实时身份禁用，保留已有实时状态。
- `first_use` 在自建数据集锁内按权限范围、数据集、映射版本和规则生成唯一组合身份。
  首次原子选择可用且未回收的固定 M1 版本、最后观测截止前的最近日界 T，并创建一条持久准备任务。
  如果 T 前没有历史，不自动降级为非日界。已有同配置组合复用原定义及修订，新日更不移动基线/T。
- 保存分段规则、聚合版本、父修订字段与尾部修订政策。修订的基线、T、规则不可原位修改。
  映射、组合及修订成为价格回收引用，新增修订写入使用既有引用锁；不改变旧 ticker 或历史清单。
- `ae32_composite_definitions` 是新增表迁移，已有映射时拒绝丢失数据的降级。

## 证据与环境

- 本地组合/回收初次定向 17 项通过；最终类别/账户校验后组合/回收/数据中心 20 项通过。
- Ubuntu 独立 PostgreSQL 初次定义/并发/迁移与回收 13 项通过。
  8 个并发首次使用请求只产生一个组合、一条修订、一个准备任务。
  最终校验变更后实际 PG 组合定义 5 项重测通过。
- 全链旧 MCP/预警迁移 7 项通过；新 head 为 ae32，旧身份和固定版本保留。
- 此前第二层全量 831/97 是 `1b98806` 阶段证据，不能算这批组合基础模块的全量验收。
- 实际 PG 已完成 ae32 升级，现有 API `/readyz` 健康。
  环境与启停方式沿用[第二层阶段报告](history-catalog-quality-stage.md)，port16629。

证据文件：ignored `composite-definition-postgres.log`、`composite-definition-final-postgres.log`、
`composite-definition-final-local.log`、`composite-definition-migration-tests.log`、
`composite-definition-runtime-migration.log`。
没有使用合成来源结果宣称实际供应商组合验证，也未改动旧观察或生产实例。

## 必须接续

上述接口尚未接到公开组合使用入口；准备任务尚未有实际执行链路。
继续实现确认 M1 尾部与可审计修订、恢复/fencing、需求解析和零需求退出，固定分段读取后统一聚合，
原生/自建/组合搜索、映射表单、组合图表/MCP、策略接缝政策/预热/事件防重与桌面健康。
随后完成原生 Dukascopy 与完整缓存身份、统一回测输入、整体真实 Ubuntu/负载/质量验收。
此阶段不证明 C/D/E 完成；完整线程目标保持 active。未推送、未 PR、未发布或下单。
