# 添加自选／添加自建搜索性能优化

状态：2026-11-14 已实施并更新 Ubuntu 本任务隔离验收实例；本地回归、真实接口及截图检查已完成，Android 真机复核待用户进行。详见 [本轮验收记录](../../verification/mobile-pending-polish-20261114/README.md)。

基线：分支 `feat/managed-live-rollover-20261113`，提交 `17af8e25`。实施前重新核查 AGENTS.md、工作树和实际部署。与 [既有共享搜索规则](mobile-shared-symbol-search-20261114.md) 共同使用；优化不能减少已认可功能。

## 只读诊断依据

Ubuntu 本任务隔离实例（18447）目录约22033条。`xau oa`、`黄金 oa`、`美股 yahoo` 的自选原生和创建目录 HTTP 搜索约1.6～1.8秒，自选自建摘要约30毫秒。移除已添加排除条件后，原生搜索仍约1.6秒，防重并非主要瓶颈。

真实 PostgreSQL EXPLAIN ANALYZE：现有搜索 GIN 索引存在；原查询 `xau` 能用文本索引，手机多字段条件却对主目录顺序扫描，并在三个 AKShare 展示变体分支各重复匹配约8032条记录。手机 `xau` 查询约1.5秒。显式指定 OANDA 后的 `xau oa` 对照约0.096秒，但这只是诊断对照，不授权把任意 `oa` 强制解释为来源筛选。创建目录 count 和取页各约0.8秒；关闭事务内 JIT 对照未明显改善。

诊断命令已实际运行：`python /tmp/mw-search-perf-20261114.py`（1秒阈值失败，复现慢查询）；`docker exec -i mw-managed-live-rollover-20261113-api-1 python < /tmp/mw-search-profile-20261114.py`；同方式运行 `/tmp/mw-search-plan-20261114.py`。这些是本机临时脚本，非持久验收入口；实施时将最小计时/执行计划采集方式沉淀到仓库，不依赖临时文件长期存在。以上为当前环境样本，不是完成优化后的指标。

## 实施顺序

1. **修正匹配条件与索引利用。** 核查 `backend/alerts/instrument_directory.py`、`mobile_symbol_search.py`、`market_names.py`；尽量利用既有索引，减少逐行重复的字符串规范化、类别/供应商 CASE 和宽 OR。先以不会遗漏结果的条件定位候选，再做必要精确核验；不能靠 LIMIT 提前截断候选。来源别名简化须与原跨字段语义等价，不能把来源子串猜测改成独占筛选。
2. **同一真实目录匹配一次，再展开展示变体。** 保留变体真实身份、账户作用域和可见资格；最终身份排除、去重、排序都在分页前完成。不把各变体合并为同一品种，不自动调整用户已有引用。
3. **创建目录手机入口使用25＋1判断后续页。** 核查 `history_creation_check.py`、`history_api.py` 和 `web/src/mobile/DataCatalogSheet.tsx`：增加显式无总数读取路径/has_more，手机上滑加载不再等待精确 count。其他调用方默认响应语义保持；自选原生已使用 include_total=false，不能把它误报为新增优化。小而快的自建摘要先不重构。
4. **按实测决定缓存和额外搜索字段。** 优先完成前三项并计时；仍有必要时才增加规范化搜索字段/匹配索引或有界短期缓存。不引入独立搜索服务。涉及持久字段/迁移时按 AGENTS.md 重新判断风险和适用验证。
5. 前端保持约250毫秒防抖与旧请求取消；相同关键词缓存限定服务器/账号/会话/查询语义和目录修订，加入/移除/创建成功后及时失效。不得因缓存让已加入品种重新可添加；最终写入继续核验重复。双目录失败重试、独立页链和返回滚动保持。

## 不变的产品语义

- 代码、中文简明名/可靠别名、供应商、可靠类别/市场均可搜索；大小写不敏感，短词/子串仍支持。
- 空白分词 AND，每词跨字段 OR，词序不限制；保留 `oa`、`xau oa`、`oa xau`、`黄金 oa`、`美股 yahoo`、多空格/全角空格、代码分隔别名、字面通配符。
- 服务端匹配及已添加排除先于分页；不下载全目录到手机、不静默漏页、不放宽最终防重、不改变行情维护/实时策略或网页默认搜索语义。

## 验收与收口

- 固定同一批真实目录和关键词，记录冷/热请求及SQL耗时、查询计划、首屏端到端耗时；包含空查询、常见查询、短词、零结果、后续页。常见搜索接口目标为多数300～500毫秒内，分别报告实际分布，不能用单次最佳值冒充保证。
- 与原语义逐身份比较完整结果及分页链，验证变体、同码多源、归档排除、全分组排除、并发/响应丢失防重。性能测试必须走真实 PostgreSQL 数据规模，不只用小夹具证明快。
- 运行受影响的后端测试，如 `PYTHONPATH=backend pytest -q backend/tests/test_mobile_symbol_search.py backend/tests/test_platform_catalog.py backend/tests/test_history_catalog.py backend/tests/test_history_creation_check.py backend/tests/test_series_search_pagination.py`；在 `web` 构建并运行 `node tests/mobile-symbol-search.browser.cjs`，适用时补数据工作流回归。
- 前端验证快速改词、关闭取消、首屏/后续页失败、连续添加后结果失效和返回位置；Ubuntu 本任务 R1只读真实验证，写行为使用夹具。实现与检查通过再更新状态；本轮未进行生产发布或 PR/CI。
