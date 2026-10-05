# 原生图表有限窗口同步：实现与隔离验收

2026-10-04。修复分支 `fix/native-chart-window-sync`，独立 worktree `/home/quant/repos/market-watch-chart-sync`，基线 `62488c6035dbea9533699d569a6605f82c684303`。本次交付为可审查的实现，未合并、未部署生产；主仓库的 MT4 工作未修改。

## 修复行为

远历史点击、日期范围及布局恢复通过有限历史窗口定位，原生读取以该窗口右边界为锚，不再补齐目标到当前时间之间的多年历史。窗口内部身份进入原生线程、储备、订阅及 Python 指标路径，后端商品身份保持一致。同周期最新图与不相接历史图可独立加载。

同步光标保留时间语义，在导航、数据及视区完成后重新投影。鼠标静止时即可对齐；测试在再次移动鼠标之前检查实际光标及日期标签，再与移动后的结果比较。

历史窗口较新边界预备相接窗口，换源期间保留继续拖动的位移。取消、503、繁忙和超时结束所属请求，保留有效视图，允许后续操作恢复。回退对象清除旧拖动标记，避免失败候选覆盖原视区。普通拖动的储备阈值、批次和并发策略维持 v1.7.0。

许可库安装继续校验原始 SHA、唯一锚点及完整安装，拒绝部分安装和陌生字节。构建生成 `charting_library_<patched SHA前16位>/`；版本路径为 immutable，旧未版本路径为 no-store。Git 不包含许可分发包或凭据。

## 隔离环境

本地 Docker socket 无权限，验收使用 SSH 主机 `unraid` 的独立 Compose 项目 `mw-chart-sync-acceptance-20261004`，目录 `/mnt/user/appdata/mw-chart-sync-acceptance-20261004`。

- 独立 PostgreSQL 14 数据库 `chart_sync`、volume `mw-chart-sync-acceptance-20261004_sync-pg`、network `mw-chart-sync-acceptance-20261004_default`。
- API/迁移使用 `trading-alerts-api:v1.7.0-e40eaac`，web/chart 使用本修复候选；无 worker，通知投递关闭。Yahoo 仅在此隔离 API 启用。
- TLS 只绑定远端 loopback `15843/15844`，经 SSH 隧道访问。关闭挂钩镜像另建实例，只绑定 loopback `15944`。
- chart 镜像：`sha256:1665598fed9d95e5929a71a1a03b99f4cc4953178b2b77c880a8f0748108f0e3`；web：`sha256:535b2d2b45a22f1a42e9b9855c85b82f3f321a6d5a04db8787a3d72a32c7be63`。

## 验收记录

[归档证据目录](verification/chart-sync-acceptance/)保存去除 client/listener 标识的 JSON、关键截图和源码 SHA 清单。实际行情与合成机制测试分开记录。

| 检查 | 结果与证据范围 |
| --- | --- |
| 真实产品 2/4/8 图 | React→postMessage→API→独立 PG→实际 OANDA OHLC→许可库完整链路通过，0 JavaScript 错误。[product.json](verification/chart-sync-acceptance/product.json) |
| 静止光标 | 周线点击后分钟/高周期图完成导航；不再 hover 的光标时间与下一次鼠标移动一致，实际日期标签可见 |
| 有限请求 | 两图/四图最大请求 2239 根，八图 1337 根，均未请求多年走廊；响应最大分别为2239/2239/1741根，响应可包含已有储备 |
| 同周期共享隔离 | 一图最新、另一图远历史；失败、刷新及重建均不移动最新 peer |
| 连续按住拖动 | 四图进行10次较新侧拖动，跨6个窗口身份；含延迟候选期间继续移动，换源后不回跳。柱宽、对数价格轴和画线保持；完成后仅3个活动窗口 |
| 指标与保存 | 原生 MA200 和 Python SMA200 使用真实历史请求/前缀；保存重开保留指标定义和历史视区。此项证明传输与生命周期，不是全部指标数值的独立正确性审计 |
| 错误恢复 | 注入503、409 HISTORY_BUSY、等待31秒触发实际30秒超时；保留有效视区，错误码正确，随后导航恢复。缓存内取消与第二次远跳取消均通过 |
| 原生正常入口取消 | 延迟远跳后改点最新未来留白/近侧历史，旧任务被取消，不建立过期窗口。[native-cancellation.json](verification/chart-sync-acceptance/native-cancellation.json) |
| 换源后失败回退 | 实际库、合成feed注入换源后503，回退中心不变；合法17000根范围通过，回最新及后续恢复通过。[lifecycle.json](verification/chart-sync-acceptance/lifecycle.json) |
| 冷首次503 | 不进入假商品无效状态，时间轴loading结束，reset后恢复。[cold-error.json](verification/chart-sync-acceptance/cold-error.json) |
| 九周期机制 | M1/M5/M15/M30/H1/H4/D1/W1/MN跨周期组合通过。[period-matrix.json](verification/chart-sync-acceptance/period-matrix.json)。合成24×7 feed的月线为30天近似，不能证明真实月历 |
| 实际交易日历 | OANDA九周期范围导航；2024-03-08～14的DST附近范围，M1取3小时，W/M取2020全年；Yahoo SPY D/W/M通过。[oanda-calendar.json](verification/chart-sync-acceptance/oanda-calendar.json)、[yahoo-calendar.json](verification/chart-sync-acceptance/yahoo-calendar.json)。这是实际供应商范围加载，不是逐根节假日标签审计 |
| Binance | BTCUSDT双图完整产品记录通过。[binance-product.json](verification/chart-sync-acceptance/binance-product.json)，该记录来自本轮较早候选 |
| 日期同步布局 | 开启时间/日期同步，双M5历史保存重开后范围和柱宽保持。[date-sync.json](verification/chart-sync-acceptance/date-sync.json) |
| 真实日期对话框 | 鼠标激活历史M5图，Alt+G打开原生对话框，输入2024-03-27并点击提交；目标交易日进入实际视区，后续四图完整回归通过。[native-dialog.json](verification/chart-sync-acceptance/native-dialog.json) |
| 历史更正入口 | 真实产品合法 provider reset 消息触发刷新，保留自身视区/画线且不移动最新peer；消息为测试注入，未修改PG历史行 |
| 旧缓存与关闭挂钩 | 使用实际Docker构建字节及真实浏览器HTTP缓存，先缓存原始未版本路径，再加载候选新目录；确认未复用旧URL。关闭挂钩独立镜像原SHA恢复、实际库正常加载。[cache.json](verification/chart-sync-acceptance/cache.json)，该加载smoke使用合成OHLC |
| 安装与模块检查 | 原始/旧v1.7.0迁移/幂等/部分安装拒绝/字节篡改拒绝/关闭及不同URL合同通过；13个适用前端模块检查通过。[unit-checks.json](verification/chart-sync-acceptance/unit-checks.json) |
| 构建和后端 | TypeScript/Vite构建通过，保留既有大chunk提示；隔离API中 `test_native_reserve.py`、`test_native_reserve_yahoo.py` 18 passed |

截图 `product-{2,4,8}-stationary.png` 在点击释放后、再次移动鼠标之前获取；`product-{2,4,8}-held.png` 和 `product-4-boundary-held.png` 均在 `mouse.down()` 之后、`mouse.up()` 之前获取。它们确实展示按住期间，截图本身不能证明持续帧率。

## 尚未覆盖的边界

未完成三个行情商全部支持周期、图数和方向的笛卡尔组合，Yahoo日内供应商窗口边界及逐根节假日审计；未完成真实PG历史行修订→SSE→原生重算的端到端验收，也未单独量化实时自然tick、长期内存和拖动帧率。真实日期对话框、原生 `loadDataTo(time-range)` 和公开范围入口均已通过。不能将上述记录称为全部规格矩阵或生产验收通过。

本轮早期失败保留在 `/tmp/mw-chart-sync-acceptance/`：包括旧取消遗漏、回退继承拖动标记、超时丢码及并发账号偏好冲突。合成静止检查曾用固定1秒等待，在多浏览器并发时于加载未完成采样；已改为等待实际导航/dataReady完成再测，不改变产品同步行为。产品浏览器同账号必须串行，避免工作区偏好revision相互干扰。

## 复现方式

cwd为 `web`。私有许可库需另行提供，原始SHA见 [source-manifest.json](verification/chart-sync-acceptance/source-manifest.json)。环境变量 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指向本机Chromium；本机另需 `LD_LIBRARY_PATH=/tmp/mw-v170-browser-deps/root/usr/lib/x86_64-linux-gnu`。

```bash
COUNTS=2,4,8 NATIVE_SYNC_ERRORS=1 node tests/advanced-native-navigation.product.browser.cjs
NATIVE_NAVIGATION_MATRIX=all node tests/advanced-native-navigation.browser.cjs
NATIVE_NAVIGATION_LIFECYCLE=1 node tests/advanced-native-navigation.browser.cjs
NATIVE_NAVIGATION_COLD=1 node tests/advanced-native-navigation.browser.cjs
NATIVE_NAVIGATION_CANCEL=1 node tests/advanced-native-navigation.browser.cjs
node tests/advanced-native-provider-calendar.browser.cjs
NATIVE_CALENDAR_SYMBOL=YAHOO:6493341e6b5636b2080fa9a1961f4fd3 NATIVE_CALENDAR_RESOLUTIONS=1D,1W,1M node tests/advanced-native-provider-calendar.browser.cjs
COUNTS=4 NATIVE_SYNC_DIALOG=1 node tests/advanced-native-navigation.product.browser.cjs
node tests/advanced-native-date-sync.browser.cjs
node tests/advanced-native-cache.browser.cjs
node tests/advanced-native-hook-contract.cjs
npm run build
```

产品测试默认访问 `https://localhost:15843/15844`，登录文件默认 `/tmp/mw-chart-sync-acceptance/login.json`；均支持环境变量覆盖。测试会创建隔离工作区、修改隔离账号偏好，不能直接指向生产。

## Standards

独立只读复审：0项书面标准违规。发现的替换取消清理、刷新误回最新、await后旧代次修改及回退临时标记继承问题已修复并回归，无剩余明确实现阻塞。

## Spec

独立只读复审：未发现剩余明确实现阻塞或无关范围扩展。验收范围仍有上文列出的供应商完整矩阵、PG修订端到端缺口。

两轴最终实现阻塞均为0；规格验收限制保持记录，不由实现审查通过替代。
