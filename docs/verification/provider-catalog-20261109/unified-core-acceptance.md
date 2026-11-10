# 商品目录旧调用收敛验收

本补丁将兼容入口转为统一核心的适配层，删除旧 OANDA 刷新写入、旧搜索全量合并与二次排序，以及历史导入 worker 的目录调度。保留兼容 URL 和返回格式，不将“共用核心”表述成“所有 URL 只剩一个”。

## 调用归属

| 入口或调用方 | 当前核心 | 适配职责 |
| --- | --- | --- |
| `/series/page`、平台管理目录 | `instrument_directory.search` | 系列字段、管理字段、分页格式 |
| `/series/search` | `search_series_page` | 返回 `items` 数组；沿用旧筛选约束 |
| `/catalog` | `instrument_directory.search` | 旧展示字段与维护状态，不再另行排序 |
| `/history-catalog/search` | `history_creation_check.search_catalog` → `instrument_directory.search` | 自建选择字段与来源状态 |
| `/history-catalog` | `history_creation_check.search_catalog` | 页码转 offset，保持旧响应字段 |
| `/history-catalog/refresh`、`/catalog/refresh` | `catalog_sync.refresh` → 来源适配器 → `publish` | 旧刷新保留 `{count}`；错误统一脱敏 |
| 定时目录刷新 | `catalog_runtime` → `catalog_sync.refresh` | 唯一定时调度；图表历史 worker 只处理历史任务 |

前端剩余的旧 search 操作改走 `/series/page` 并适配数组返回。来源选择组件和已存实时映射的目录回填改走 `/history-catalog/search`。实际应用前端不再调用 `/series/search` 或旧 `/history-catalog?...`。

## OANDA 兼容性

- 现有 `EURUSD`、`XAUUSD`、`OANDA:<供应商代码>` 目录身份作为兼容映射，由统一 `publish` 在同一事务中更新。不会为新供应商品种再生成一套旧目录记录。
- 供应商只请求一次；兼容映射不增加目录快照的品种计数。完整快照才标记缺失项，刷新失败保留原目录。
- 旧身份、人工中文和已有周期元信息保留；自建选择继续使用 `HC:` 账户隔离身份。
- 新品种的 `OANDA:` 原生身份从当前账户快照解析，旧账户的有范围目录不可作为当前账户品种使用。
- 本补丁范围是商品目录查询与刷新。行情历史下载、维护配置和发布不属于目录入口。

## 验证

风险分类 F0：兼容 API、前端调用及 worker 职责调整，无 schema 变更。完成本人自审、针对性回归和 Ubuntu R1。

- 后端 286 passed，覆盖目录、兼容 API、分页、来源选择、图表解析、实时开关与 worker 健康。
- 新旧刷新实际调用统一 OANDA 供源：均返回 127 个品种；统一目录状态成功。
- 兼容混合搜索与分页接口结果、顺序一致；旧自建目录与现用来源搜索结果、身份一致。
- 浏览器实际验证主搜索、自选添加和配置实时来源的目录列表；前两者每次 50 条免计数，实时来源走现用搜索入口，无旧来源目录请求，无 pageerror。
- 连续两页共 100 个真实 Binance 身份无重复。
- 前端完整 build、single-frontend unit、Ruff、`git diff --check` 通过。
- Ubuntu API 中 205 个后端 Python 文件与本补丁工作树逐一哈希相同。

## Ubuntu 候选

主机：Ubuntu 本机 Docker；地址：https://localhost:19653 。复用隔离 project `mw-catalog-20261109` 的数据库，只更新 API、data-worker、Web；保留 mw-dev。实际 Compose、启停命令沿用 [acceptance.md](acceptance.md)。

API/worker：`sha256:d201fc9b27de3dd7a992b183b4d39dbdf29b64cba2630c598f309648d21106b5`。

Web：`sha256:79ad6ce5ed932454e444112251f676deff26cf3747c2dda8fc1ddb2a4268fa8f`。

私有回退 Compose 保存在验收目录的 `acceptance-compose-before-unified-core.json`，未提交私有配置。结构化证据见 [unified-core-evidence.json](unified-core-evidence.json)。

先前性能报告固定对应提交 62f9df75，本补丁不将那些数据冒充改动后的重新测量。最终全量 CI 以本补丁提交对应的 PR 检查为准；不沿用旧提交的 CI 通过数。
