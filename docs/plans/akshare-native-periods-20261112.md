# 新浪、腾讯原生周期接入实施方案

日期：2026-11-12。状态：基于 v2.0.8 的实现及本地检查已完成；经用户授权，已部署到既有开发实例并完成真实 API/UI、PG 兼容及空闲验收。旧新浪港股基线问题和完整结果见[验收记录](../verification/akshare-native-periods-20261112/README.md)。PR #135 未合并，未打 tag、未发布生产。

执行更新：用户后续明确要求“在开发实例上验收”。因此本轮使用 Ubuntu 本机既有 `mw-dev`（`https://192.168.7.232:18443`），允许更新应用镜像并进行真实 API/UI/空闲观察，不另起 preview；23 GiB 的新 preview 启动门槛不再作为本轮阻塞条件。现有数据、私有配置和其他任务保留，兼容/并发自动测试使用同一 PostgreSQL 服务内本任务独立测试数据库和逐测试 schema，不连接应用数据库执行破坏性测试。不合并、不打 tag、不发布生产的边界继续有效。

## 1. 目标与已确定范围

将以下行情接入 Market Watch 平台行情，按所选周期直接请求供应商返回的 OHLC：

| 来源 | 市场 | 新入口周期 | 本期价格口径 |
|---|---|---|---|
| 新浪 | 沪深 A 股 | M1、M5、M15、M30、H1、D1、W1、MN | 不复权（raw） |
| 腾讯 | 沪深 A 股 | M1、M5、M15、M30、H1、D1、W1、MN | 不复权（raw） |
| 腾讯 | 港股 | D1、W1、MN | 不复权（raw） |

无需阻塞性澄清。价格口径采用兼容默认值：新增明确标注“不复权”的原生周期入口，原有新浪、腾讯前复权日线入口、历史数据和已保存图表保持原义。切换新入口内的周期不能改变价格口径。

范围边界：

- 每个周期的上游 HTTP 响应必须直接包含该周期 OHLC。允许解析、缓存、去重和保存；禁止在 API、worker、浏览器、代理或本地执行的官方 JS 内聚合补齐。
- A 股限定现有 SSE/SZSE 目录，不扩展北交所、指数或新资产类别。
- 保留现有新浪港股 D1、国内期货六周期；本期不新增其周月线。
- 腾讯港股只新增日周月，不新增分钟。
- 不扩展托管历史任务、组合行情和告警支持范围，不新增实时流、常驻服务或八周期定时轮询。
- 本期不新增前复权周月或前复权分钟。腾讯日周月前复权已有接口证据，但深历史存在非正价格，需要独立处理；本期不修改全局正价约束。

## 2. 仓库基线与交付位置

- 项目：Market Watch。
- 方案与研究工作树：`/home/quant/repos/market-watch-akshare-periods-20261112`。
- 文档分支：`docs/akshare-full-periods-20261112`。
- 研究基线：`ac62a5ae735c4467f236fc01dd0e23e826900fac`。
- 实际实施基线：`v2.0.8`（`e9b9a78722961c5f8b58895a187410349def6c94`），包含已合并的 PR #134。原方案业务候选为 `c711132f`。
- 实现使用新工作树 `/home/quant/repos/market-watch-native-implementation-20261112`，新分支 `feat/akshare-native-periods-20261112`。
- 如上述路径或分支已被占用，先核实归属，再使用新后缀；不能覆盖已有任务。

先读当前 `AGENTS.md`，核对分支、工作树和基线。如果执行时业务基线已经更新，检查相关差异后选择最新兼容基线，记录准确 SHA；不得把当前研究分支直接合入其他业务分支。

依据与已保存证据：

- [原生周期核验报告](../research/akshare-native-periods-20261112.md)。
- [探测脚本与响应证据](../research/evidence/akshare-native-periods-20261112/)。
- [腾讯深历史复权样本](../research/evidence/akshare-native-periods-20261112/deep-qfq-month-observations.json)。

分类：本文为 P0 文档。实现按 F1 保守验收，原因是新增可保存的行情身份并复用持久行情缓存，需要兼容验证；默认不新增数据库表或迁移。按仓库规则，执行阶段安排独立 Standards/Spec review。

## 3. 已验证接口与字段映射

### 新浪 A 股

固定路由：

```text
https://quotes.sina.cn/cn/api/jsonp_v2.php/=/CN_MarketDataService.getKLineData
symbol=sh600519 或 sz000001
scale=<下表>
ma=no
datalen=<经过边界验证的条数>
```

| 项目周期 | scale |
|---|---:|
| M1 | 1 |
| M5 | 5 |
| M15 | 15 |
| M30 | 30 |
| H1 | 60 |
| D1 | 240 |
| W1 | 1200 |
| MN | 7200 |

解析 `day/open/high/low/close/volume`。JSONP 只剥离固定包装后解析 JSON，禁止 eval。`day` 必须进入时间解析，不套用现有只识别 `date` 的分支。

### 腾讯 A 股

分钟固定路由：

```text
https://ifzq.gtimg.cn/appstock/app/kline/mkline
param=sz000001,m15,,80
```

分钟枚举为 `m1/m5/m15/m30/m60`。只能使用显式枚举判断分钟，禁止 `startswith('m')`，避免将 `month` 路由至分钟接口。

日周月固定路由：

```text
https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get
param=sz000001,month,,,80,
```

使用 `day/week/month` 和对应 raw 响应键；不能读取 `qfqday/qfqweek/qfqmonth` 后标为 raw。

### 腾讯港股

```text
https://web.ifzq.gtimg.cn/appstock/app/kline/kline
param=hk00700,month,,,80,
```

使用 `day/week/month`。raw 走 `kline/kline`，不走 `hkfqkline/get`。

腾讯数组统一按“日期、开、收、高、低、量”解析。分钟标签为 `YYYYMMDDHHmm`，高周期为 `YYYY-MM-DD`。必须检查业务码、目标股票及对应周期数组；HTTP 200 本身不代表成功，不得静默改读其他股票或周期。

以上 `80` 是成功样本条数，不是供应商上限。实施时有限验证各路由 count、日期参数及历史边界；不承诺无限分钟历史。

## 4. 实现决策

### 4.1 接口适配与请求生命周期

新增薄模块 `backend/alerts/akshare_native.py`，维护固定路由、明确的市场/周期/价格枚举、响应解析和来源元数据。不接受用户指定 URL，不引入通用抓取框架。

在 `akshare_worker.py` 增加静态原生操作枚举，例如 `native_sina_a`、`native_tencent_a`、`native_tencent_hk`。原生操作在导入 AKShare SDK 前分派，避免仅执行轻量 HTTP 请求却加载完整 SDK。旧 SDK 操作和调用语义不变。

复用 `provider_akshare.invoke` 的 enable gate、请求资源通道、子进程隔离、私有代理、deadline、输出上限和进程组回收。HTTP 超时不得超过剩余 deadline；不新增无限重试、长期驻留 worker 或新的后台队列。

### 4.2 新身份与兼容性

采用含义固定为 raw 的平台虚拟 ID：

```text
SINA-NATIVE:SSE:600519
SINA-NATIVE:SZSE:000001
TENCENT-NATIVE:SSE:600519
TENCENT-NATIVE:SZSE:000001
TENCENT-NATIVE:HKEX:00700
```

图表 ticker 继续使用现有包装，例如 `MWP:TENCENT-NATIVE:HKEX:00700`。这些 ID 符合当前字符集和长度限制，仍需覆盖 encode/decode、搜索、解析、收藏和布局恢复的实际链路。

新 ID 根据底层 canonical symbol 解析现有物理目录项，不复制全部股票目录。来源族分别为 `sina-a`、`tencent-a`、新增 `tencent-hk`，另以原生操作/规则版本和 `adjustment=none` 区分旧接口。新来源缓存身份包含真实 endpoint、周期、价格口径和规则版本，不能命中旧前复权缓存。

原有 `AKSHARE:<hash>`、`TENCENT:<symbol>`、裸托管 ticker、`MWH:` 和 `MWC:` 原义不变。原有托管选择器不自动出现新平台别名。

### 4.3 目录、展示与能力

- `instrument_directory.py` 扩展平台虚拟行及分组规则。当前按是否 `TENCENT:` 去重的二分类不足，改为能区分供应商和价格变体的键；分页总数必须对应真实可见变体。
- `akshare_catalog.chart_metadata` 解析新别名，并复用物理行的名称、精度、可用状态和描述。腾讯港股仅接受 HKEX 股票。
- `platform_catalog.py` 为新入口返回准确 `native_periods`，不再套用旧腾讯 D1 常量；新入口不宣传可创建托管任务。
- `market_presentation.py` 识别 `tencent-hk`，显示腾讯来源和“不复权”。接口实现属于本地薄适配器，不能声称是 AKShare SDK 已有全周期封装。
- 前端在列表和图表信息中显示来源及价格口径，能区分旧前复权入口与新不复权入口。优先复用现有展示字段，无需新增复权切换控件或重做界面。
- 不修改现有全局 `supported_frames` 导致托管任务误获新能力；能力由新入口实际操作和价格口径共同决定。

### 4.4 时间、完整性与成交量

分钟按来源本地时区解释，转换为项目现有时间约定；验证分钟端点是开盘标签还是收盘标签，并在适配层明确转换，避免整体错移一根。A 股使用 Asia/Shanghai，港股使用 Asia/Hong_Kong。

D1/W1/MN 复用项目来源日期桶规则，保留原始 `source_label` 和 `trading_date`。新浪周月标签是该周期最后已观测交易日，会随未结束周期推进；必须映射为稳定周期键，不能每天插入一条新周线/月线。

当前周/月不能因为今天收盘就标为完成。优先通过存在后一周期确认历史周期完成；缺少可靠交易日历时采用保守完成判定，不自行假定节假日正常交易。

逐路由核实成交量单位，对照上游响应、官方页面或 SDK 转换代码并记录证据。不能把旧 SDK 的“手/股”元数据直接套到原始 HTTP 响应。仅在单位已确认时做明确换算，否则保留真实来源单位和说明。

### 4.5 缓存、翻页和空闲负载

复用 `source_history_store.py` 的原生序列缓存与已有并发请求合并，不新增表。不同来源、周期、价格口径独立身份；同一身份的并发首次请求应共享抓取结果。

有限快照先缓存、再按图表游标切片。向左翻页不应对同一快照反复下载整段数据；支持服务端日期续取的路由按已验证参数续取。仅有有限窗口的路由如实报告可用边界，不伪造更早历史。

区分“本次窗口已用完”“暂时失败”“供应商确实无更早记录”。不能因空响应、限流或超时永久标记历史耗尽，也不能使用 `has_more=bool(bars)` 制造无限重复翻页。闭合历史段不重复刷新；当前周期复用已有按需刷新策略。

只加载当前实际请求的周期，关闭页面后不新增后台刷新。`stream=false` 的原生来源保留现有行为，本期不承诺新增实时流或更高刷新频率。

## 5. 按依赖顺序执行

1. 核对基线、工作树和 `AGENTS.md`，建立独立实现分支；在 Issue 草案和验收记录中写明 F1 理由及范围。
2. 编写固定接口适配模块及有限响应夹具测试。覆盖新浪 JSONP、腾讯字段顺序和 `month` 路由，先确认原始数据含义。
3. 接入 worker 操作与 provider 新入口，沿用 deadline、代理和回收。加入新缓存身份和高周期稳定键处理。
4. 接入平台虚拟 ID、目录 SQL、精确计数、元数据和能力。保持物理描述关联及旧 ID 行为。
5. 接通前端选择、周期切换、来源/价格展示及布局恢复。前端如有实际 UI 修改，遵循适用的本地 UI 技能和现有控件。
6. 运行相关本地回归，修复后准备 Ubuntu 独立 Docker UI smoke；真实上游验证与 mock 单测分别记录。
7. 完成兼容验证和独立 Standards/Spec review，修复有效问题，提交独立 PR，附脱敏证据和已知历史窗口限制。

拟修改文件：

| 文件 | 作用 |
|---|---|
| `backend/alerts/akshare_native.py`（新建） | 固定上游路由和解析 |
| `backend/alerts/akshare_worker.py` | 新操作分派，跳过不必要 SDK 导入 |
| `backend/alerts/provider_akshare.py` | 新原生入口、身份、日期和缓存分页 |
| `backend/alerts/akshare_catalog.py` | 虚拟 ID 元数据 |
| `backend/alerts/instrument_directory.py` | 平台变体、去重、分页计数 |
| `backend/alerts/platform_catalog.py` | 原生能力、价格口径、托管边界 |
| `backend/alerts/market_presentation.py` | 腾讯港股来源展示 |
| `backend/alerts/chart_series.py` | 只在实际路由验证需要时修改；已有格式可容纳新 ID |
| `web/src/market-data/PlatformMarket.tsx` | 仅补必要来源/价格说明和能力消费 |
| `backend/tests/test_akshare_native.py`（新建） | 解析、路由、日期和异常边界 |
| 既有 provider/catalog/directory/presentation 测试 | 兼容与用户可见能力回归 |
| `web/tests/akshare-native-periods.browser.cjs`（新建） | 当前架构的真实 UI 周期切换与恢复 |
| `docs/verification/akshare-native-periods-20261112/`（新建） | 脱敏响应摘要、请求计数、截图和验收结论 |

新脚本先创建，再运行；不得声称目前已经存在。仅在具体测试发现缺口时扩展上述文件范围。

## 6. 本地检查与真实验收

### 环境和命令

以下命令在实现工作树执行；先确认共享 Python 环境存在且版本符合锁定依赖。不把新工作树的环境安装到其他任务目录。

```bash
/home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_akshare_native.py \
  backend/tests/test_provider_akshare.py \
  backend/tests/test_platform_catalog.py \
  backend/tests/test_provider_directory.py \
  backend/tests/test_market_presentation.py \
  backend/tests/test_market_resources.py \
  backend/tests/test_market_contracts.py \
  backend/tests/test_history_mode_creation.py \
  backend/tests/test_history_modes.py
npm --prefix web ci
npm --prefix web run test:single-frontend -- --unit
npm --prefix web run build:ui
git diff --check
```

如果新增测试使用实际 PostgreSQL，则在本任务独立 PG 中执行，不连接开发或生产数据库。前端完整构建和浏览器验收需现有许可资产，通过私有配置提供，不复制提交。

启动前只读检查：

```bash
docker compose ls
docker ps --format '{{.Names}} {{.Ports}}'
ss -ltn
free -h
df -h
uptime
```

以下为原隔离 preview 方案，已由文首用户指令覆盖，本轮未执行。实际复用 `mw-dev` 的 PG、API、三个原有运行组、Web、TLS 与 ntfy；只更新应用镜像，不启动额外服务。实际构建、备份、固定镜像、启停命令见[验收记录](../verification/akshare-native-periods-20261112/README.md)。

原隔离方案只需 PG、API、Web、TLS，不启动 collector、通知或历史后台 worker；其门槛为可用磁盘至少 23 GiB、内存至少 3.25 GiB，端口暂定 19443。此门槛不适用于本轮用户授权的既有开发实例更新。

```bash
mw-docker build --repo . --component api \
  --tag market-watch-api:akshare-native-20261112 \
  --task mw-akshare-native-20261112 --project mw-akshare-native-20261112 --purpose acceptance
mw-docker build --repo . --component web \
  --tag market-watch-web:akshare-native-20261112 \
  --task mw-akshare-native-20261112 --project mw-akshare-native-20261112 --purpose acceptance
python3 deploy/ubuntu/mw_docker.py preview prepare \
  --task mw-akshare-native-20261112 --project mw-akshare-native-20261112 --repo . \
  --api-image market-watch-api:akshare-native-20261112 \
  --web-image market-watch-web:akshare-native-20261112 --port 19443
```

默认 preview 禁止出网且未启用 AKShare，不能直接据此验收真实行情。执行者须先阅读 `deploy/ubuntu/mw_preview.py` 的当前配置方式，为本任务配置 AKShare enable、独立出网网络及必要私有代理；只让需要出网的 API 接入任务网络，不共用其他实例网络、不开放 PG 端口。将准确配置生成方式和启动命令记入验收记录，禁止输出凭据。不能把只有合成 seed 的成功当作原生行情成功。

私有配置就绪后执行并记录：

```bash
python3 deploy/ubuntu/mw_docker.py preview up --task mw-akshare-native-20261112 --project mw-akshare-native-20261112
python3 deploy/ubuntu/mw_docker.py preview status --task mw-akshare-native-20261112 --project mw-akshare-native-20261112
# 新浏览器脚本创建时定义并记录 BASE_URL、私有凭据文件的读取契约。
# 按该契约执行 node web/tests/akshare-native-periods.browser.cjs。
python3 deploy/ubuntu/mw_docker.py preview stop --task mw-akshare-native-20261112 --project mw-akshare-native-20261112
```

实际验收主机必须为 Ubuntu 本机 Docker。地址预期为 `https://127.0.0.1:19443`，以实际配置为准；交付记录含访问地址、镜像 ID、SHA、启动/停止命令。停止保留本任务 PG 数据，不删除 volume。

### 必须通过的验收项

1. **真实原生响应**：沪深样本 `SSE:600519`、`SZSE:000001`，新浪和腾讯各八周期；港股 `HKEX:00700`、`HKEX:02318`，腾讯各三周期。共 38 个目标组合取得真实 OHLC，保留路由、周期、条数、首末标签、口径及脱敏响应摘要。
2. **数据含义**：时间有序、周期键唯一、OHLC 字段正确；对照上游抽样值；确认分钟标签与单位。周月当前值更新稳定，不新增重复周期、不提前标完整。
3. **价格兼容**：新入口每个周期均显示不复权；旧新浪/腾讯前复权 D1 同一 ID、同一口径、同一缓存身份。旧布局、自选、历史和托管任务仍可解析。
4. **目录行为**：分页总数、翻页、搜索、来源、价格标签正确；不把同一股票不同来源/口径误去重；描述仍关联物理目录。
5. **图表行为**：从平台目录打开两类 A 股和腾讯港股，切换全部目标周期，实际出现相应 K 线；刷新及恢复布局后入口和周期不变；无浏览器报错。数据层 38 个组合全部验证，UI 可用每个来源至少一只代表股覆盖周期切换。
6. **有限历史和失败恢复**：向左翻页不循环返回相同窗口；一次超时/限流/空响应不永久封死历史；日期续取和 count 上限只按真实验证能力声明。
7. **资源与空闲行为**：相同周期并发请求合并；缓存命中不重复拉取；选择一个周期不抓其他七个。退出全部新图表、无相关任务后观察至少 5 分钟，记录上游调用数、子进程及容器 CPU；不应出现本功能新增的定时请求或遗留抓取进程。CPU 记录作为增量对照，不能把整实例其他服务开销归于新接口。
8. **既有服务回归**：新浪港股 D1、国内期货现有六周期和原有平台入口不受影响；启用开关、代理、超时和进程回收仍有效。

## 7. 完成、交付与停止边界

完成条件：实现与相关本地检查通过，Ubuntu 真实上游和 UI 验收通过，兼容证据和独立 review 收口，提交独立 PR。PR 说明本期 raw 入口、直接来源、历史窗口限制和实际验证结果。

遵循用户“不盯 CI”的偏好：可在交付时记录一次 CI 当前状态；不循环等待 CI，不把未完成的 CI 写成通过。实际失败若属于本改动应修复，并明确本地检查与 CI 状态区别。

不能将 HTTP 200、mock 测试、只返回元数据或本地聚合图表当作验收完成。若某个已验证路由实施时失效，保留请求证据，先修复参数或明确报告能力下降，不换来源冒充成功。

若实际实现需要改写旧持久身份、破坏性迁移、全局负价支持，或资源无法满足，先报告新增事实和最小处理建议。常规字段映射、缓存参数、测试修复由执行者自行处理。

本计划经用户更新后的授权边界止于独立 PR 和既有开发实例验收。不合并 main，不打正式 tag，不发布生产。开发实例验收后保留运行；回退恢复旧镜像/配置，旧身份与数据不重写。永久资源清理另按仓库规则执行。

## 8. 可直接交给执行 Agent 的启动指令

```text
按 docs/plans/akshare-native-periods-20261112.md 和仓库 AGENTS.md 执行。使用独立实现工作树，按用户后续指令在 Ubuntu Docker 既有开发实例 mw-dev 验收，接通新浪、腾讯沪深 A 股八周期和腾讯港股日周月的原生不复权入口，保留现有前复权入口，不做本地聚合。自动完成实现、相关测试、真实上游及 UI 验收、独立 review 和独立 PR，不逐步询问；不追踪 CI。保留开发实例数据、私有配置和其他任务，验收后保留运行。不合并、不打正式 tag、不发布生产。
```
