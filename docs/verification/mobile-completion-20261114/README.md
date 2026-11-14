# 手机待实现清单收口 · 2026-11-14

分支 `feat/managed-live-rollover-20261113`，实施基线 `444c5cdd`。用户授权完成待实现清单，同时明确暂缓自选列表的自建实时视觉标识。已完成代码、本地回归、截图及 Ubuntu R1；Android 真机复核尚未完成。未进行 PR、远端 CI、合并、正式 tag 或 Unraid 部署。

## 交付行为

- 两页搜索继续复用纯搜索图标、搜索面板及三行 `SymbolInfo`。代码、可靠中文名称、供应商和类别支持大小写不敏感子串；空白分词 AND、每词跨字段 OR、匹配后分页。`黄金 oa` 不混入白银，“美股”需要市场证据，未知市场不凭 Yahoo 来源推断。
- 自选搜索排除所有分组中的稳定真实身份，MWH 换版本或切 MWC 不重新出现；OANDA 默认来源的旧别名一并防重，原生参数变体保持独立。原生与自建集合分开；添加成功即时移除结果，重新核对已加载页链防止偏移漏项。
- 添加自建排除同供应商、准确产品和账户的已有自建，包含归档及其他模式/日界配置。手机最终写端产品锁与409保护；重复请求仍按原请求精确返回，不覆盖维护配置。桌面默认行为保留。
- 分组抽屉标题栏新建/管理图标位于关闭左侧，逐组铅笔独立于 Radio；编辑退场后返回来源抽屉。显式移动品种保留；管理里的名称/操作与品种排序分行，修正按钮重叠。保留脏表单、离线、冲突、动效、系统返回约定。
- 添加自建只保留搜索和结果。来源/类别/目录操作迁出；目录更新、AKShare 市场和 Yahoo 准确代码补录在“任务与来源→更新目录与补录”。部分目录更新失败不会提示全部成功。
- 数据主页为三行身份、逐行 Switch、必要状态；总数收在标题旁，已有列表搜索默认折叠，正常完整日期和行尾箭头移除，归档恢复及详情保留。开关与详情是兄弟目标，直接启停、不弹确认；资格批量读取，未满足条件灰显原因，已开启但异常仍可关。每行独立提交锁、错误与响应丢失读回；命令响应只保护到提交后的首次服务端读取，不被旧快照覆盖，也不阻挡“准备中→运行中”或其他端关闭。大字号轨道与滑块按比例缩放。
- sparkline 参考线统一为实际展示交易日的前一交易日收盘。仅使用同来源/账户/口径/窗口/固定版本或接续修订的可靠收盘证据；缺失有界补取，不用开盘、较晚首分钟或当前报价代替。保留现有图高、列宽、M5显示采样、直线、渐变与闭市蓝色。旧日参考不套今天的昨收。
- 六源在本任务实例启用并有真实日线样本：OANDA、Dukascopy、Binance、Yahoo、AKShare、FXCM。沿用既有 OANDA `stream` 模式，未改为新采集策略；没有批量开启自建实时或历史任务。FXCM 使用本任务私有配置及只读 SDK，凭据未入仓库。

## 检查与截图

风险 F0：兼容 API/UI/摘要扩展，无 schema 迁移；本次数据写入仅限测试夹具、任务私有配置、供应商目录与既有原生缓存。真实分组、自建维护和实时启停未用于试写。

- 后端：**95 passed**。覆盖创建预检及最终防重、归档/跨日界、旧请求重放、全局稳定身份、字面通配符、类别/中文组合、分页、资格、sparkline 昨收/跨日/来源边界与只读查询。
- PostgreSQL 独立测试库：**5 passed**。包含并发创建不同日界仅保留一个产品、原请求重放、批量列表资格与真实启停命令一致，以及单可用连接下 sparkline 正常返回曲线和昨收。真实实例曾出现连接池超时，已复现并修复：原生元数据在曲线快照事务之前读取，消除占着一个连接再等第二个连接的相互等待。每项测试使用唯一临时 schema；未对验收业务库运行破坏性测试。
- `npm --prefix web run build`、本次改动 Python 的 `ruff check`、`git diff --check` 通过。
- 浏览器：`mobile-symbol-search.browser.cjs`、`mobile-watch.browser.cjs`、`mobile-data.browser.cjs`、`mobile-data-workflow.browser.cjs`、`mobile-watch-a07.browser.cjs`、`mobile-sparkline-session.browser.cjs`、`mobile-alerts.browser.cjs`、`mobile-app.browser.cjs`、`mobile-sparklines.cjs` 通过。图表使用既有实际许可控件，测试数据为明确夹具。
- 数据流程 56 张截图；几何/控件脚本覆盖8种布局、窄屏/150%字号、深浅主题、分组编辑、抽屉生命周期、下拉回收、离线与缓存。已人工查看搜索、分组、管理/重命名、数据行及真实自选截图；修正了多余行底框、总数换行、开关滑块溢出、分组按钮重叠。
- [截图目录](screenshots/)、[数据全流程证据](workflow-proof.json)、[真实浏览器 smoke](real-browser-smoke.json)、[部署及版本](deployment.json)、[后端文件 hash](backend-hashes.json)、[真实搜索响应](search-real-responses.json)。浏览器夹具验证不冒充真机操作。

最小复验命令：

```sh
PYTHONPATH=backend pytest -q backend/tests/test_history_creation_check.py backend/tests/test_mobile_symbol_search.py backend/tests/test_platform_catalog.py backend/tests/test_dataset_summaries.py backend/tests/test_managed_continuation.py backend/tests/test_sparkline_rollover.py backend/tests/test_sparklines.py backend/tests/test_sparkline_sessions.py backend/tests/test_sparkline_backfill.py backend/tests/test_history_mode_creation.py
npm --prefix web run build
cd web
node tests/mobile-symbol-search.browser.cjs
node tests/mobile-watch.browser.cjs
node tests/mobile-data.browser.cjs
node tests/mobile-data-workflow.browser.cjs
MOBILE_VISUAL_OUTPUT=/tmp/mw-mobile-completion-geometry-final-20261114 node tests/mobile-watch-a07.browser.cjs
```

PostgreSQL 命令为 `PYTHONPATH=backend pytest -q backend/tests/test_history_creation_check_postgres.py backend/tests/test_sparklines_postgres.py`，使用本任务私有 `test-env.json` 传入 TEST_POSTGRES_URL，不把地址凭据打印或提交。

## 逐源与昨收证据

[真实样本](source-samples.json) 均直接调用各自原生 reader，无跨源代替、无旧缓存冒充：OANDA XAU_USD/XAG_USD、Dukascopy USD/CAD、Binance BTCUSDT、Yahoo AAPL、AKShare SSE:600000、FXCM EUR/USD。各源返回非空，具体结束时间及完成标识保留在证据中；Yahoo 原生 API 的额外返回条数按原结果披露。

[目录同步](source-refresh.json)：OANDA 127（初次502，重试成功）、Dukascopy1504、Binance3742、FXCM517、AKShare A股5223、Yahoo crypto-usd8094。Yahoo equity-us 返回“供应商分区总数变化或超过10000条分页上限”；保留旧快照，准确代码补录仍可用，**不能宣称全美股目录已完整同步**。这属于已有目录能力限制，本轮未改其全量同步算法。

[真实 sparkline 响应](sparkline-real-responses.json)：OANDA 与 Dukascopy 的黄金/白银、Dukascopy USDCAD 均有展示日昨收和对应时间，`preparation=ready`、无补取错误。USDCAD 原 TLS EOF 本轮未复现；不能保证供应商网络以后不会波动。

验收实例原有两项自建实时仍显示 `unauthorized`；列表如实显示“实时认证异常”，Switch 保持可关。启用六源不等于修复既有账户实时认证，也不代表全部品种/全部周期可读。历史样本与目录读取已独立验证；本轮未替换账户凭据或改动原有自建开关。

## 运行与真机复核

实际主机：`quant-server`，Ubuntu 本机 Docker project `mw-managed-live-rollover-20261113`，独立 PostgreSQL、网络、volume和私有配置。更新 api/data-worker/market-runtime/web，未重建数据库。部署前核查约43GiB可用磁盘、4.9GiB可用内存，未停其他任务。准确镜像与 shell 版本见 deployment.json，前后端文件已核对。

- 自选：<https://192.168.7.232:18447/m/watch>
- 数据：<https://192.168.7.232:18447/m/data>
- 启动：`/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh`
- 停止：`/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh`

登录沿用验收实例私有凭据。当前 APK 是否指向该服务器需按手机实际连接确认；本轮是 WebView 前端/后端更新，没有生成新 APK。生产地址不代表本轮验收版本。

请真机复核：两页中文/组合输入及连续添加；分组铅笔、新建、移动、Android返回及未保存退出；数据页实时开关触摸/错误反馈；黄金白银和USDCAD参考线及收盘/开市切换。额外自选实时标识继续暂缓。
