# 手机共享搜索与 sparkline 验收

2026-11-14，分支 `feat/managed-live-rollover-20261113`；实施基线 `008586fb`，共享搜索阶段提交 `113e0397`。范围为 [共享品种搜索](../../plans/pending/mobile-shared-symbol-search-20261114.md) 和 [sparkline 会话](../../plans/pending/mobile-sparkline-session-20261114.md)，包含数据页纯搜索图标要求。

代码、本地验证与 Ubuntu R1 已完成；**Android 真机输入法、系统返回键及实际手势仍待用户复核，整体目标保留未完成状态**。未更新 PR、跑远端 CI、合并、打正式 tag 或部署 Unraid。

风险 F0：手机 UI 与兼容的 sparkline API，无 schema、持久身份、历史发布规则或维护/实时开启策略变更。按仓库规则完成本人自审与本任务 Ubuntu R1；不额外增加跨任务评审或实例。

## 最终行为

- 自选和数据共用无底框搜索图标（44px 触摸目标）；自选直接添加，管理集中于左上分组入口，刷新仍用下拉。
- `SymbolInfo` 统一代码、简明名称、供应商及轻量自建标识；保持自选固定列宽、72px 行高、50px 曲线与既有 M5 显示采样、折线和渐变。维护配置放详情，必要运行状态及同名配置短标识另列。
- `SymbolSearchPanel/Row` 与 `useSymbolSearch` 共用输入、筛选、结果、自动追加与反馈；三条原有查询接口及两种业务动作独立适配。
- 查询取消、真实身份去重、末页停止、后续页失败保留列表并显式重试；关闭时停止请求与观察，退场保留画面；详情/创建返回保留结果及位置。
- 默认实际目标分组，按目标组判断重复；连续添加变勾。保留身份解析、未就绪禁用、偏好冲突、未知字段和原创建/维护/实时开启流程。
- 真实截图发现并修正了搜索框内部重复焦点框及浏览器自带清空入口；仅外层显示焦点提示，自定义清空按钮保持44px触摸面积。
- sparkline 优先当前实际窗口，无数据时回显同来源/固定版本/接续修订的最近实际窗口。当前较粗周期优先于旧 M1；首个本日点立即切换，历史时间轴和缺口不平移。
- 原生 Yahoo 股票按来源对应日期的 regular session 证据判断普通/提前收盘，收盘切蓝而不等午夜；缺证据为 unknown。prepare 仅补手机时段证据与既有历史缓存，batch 只读，不启动维护任务或第二套实时流。
- 当天闭市保留昨收参考；回显用真实该日开盘价，缺首根 open 不伪造。旧固定版本可显示版本内最后窗口并标出“历史 · 日期”，不自动换最新版。
- 空刷新保留有效且身份一致的曲线；明确不可用/损坏/回收不被旧图掩盖，包括带报价修订 fence 的 MWC。来源账户、接续修订/确认输入与 Yahoo 价格重验证代次隔离。
- 准备成功但空或旧窗口不会记为全天完成，60秒起退避至15分钟；unsupported/闭市准备结果不会因过去的收盘时间每分钟失效。完整价格但时段未知也可补证据。手动下拉清除准备记忆以重试。
- 沿用可见行、后台暂停/前台恢复和现有 SSE。新本日报价触发有节制的重查，不追加到昨日；prepare 新获收盘边界会重排现有检查定时器，无额外轮询器。

## 已执行的本地验证

完整构建使用本机固定许可图表资源；HTTP/SSE fixtures 和模拟浏览器时钟不代表真实供应商或 Android 系统。

```sh
PYTHONPATH=backend pytest -q backend/tests/test_sparkline_rollover.py \
  backend/tests/test_sparklines.py backend/tests/test_sparkline_sessions.py \
  backend/tests/test_sparkline_backfill.py
# 48 passed
cd web
npm run build
node tests/mobile-sparklines.cjs
node tests/mobile-sparkline-session.browser.cjs
node tests/mobile-symbol-search.browser.cjs
node tests/mobile-watch.browser.cjs
node tests/mobile-data.browser.cjs
MOBILE_DATA_OUTPUT=/tmp/mw-pending-final-workflow node tests/mobile-data-workflow.browser.cjs
MOBILE_VISUAL_SCOPE=identity MOBILE_VISUAL_OUTPUT=/tmp/mw-sparkline-session-regression \
  node tests/mobile-watch-a07.browser.cjs
```

以上均通过。数据全流程14组、55张截图；自选身份与几何8组。共享搜索覆盖375/412px、深浅主题、150%字号。新增 session 浏览器脚本覆盖时段证据由 prepare 后补、普通/提前收盘定时切蓝、无高频请求循环、空刷新/失败/不可用、真实本日首点切换、历史日期与缺开盘价；最后补验 MWC 不可用不会被报价修订 fence 忽略。

最终构建 mobile shell：`dd6b873e0cd41452`；JS `mobile-DLgE96Q8.js`，CSS `mobile-CkU5Y6FO.css`。`git diff --check` 通过。

## 逐项完成核对

| 要求 | 当前证据与结论 |
| --- | --- |
| 两页共用纯搜索入口、三行信息、自动追加 | `mobile-symbol-search.browser.cjs`，两页真实目录截图；通过 |
| 三接口适配、默认目标组、重复/连续添加、身份去重 | 共享搜索与 data 浏览器 fixtures；通过，不合并不同目录能力 |
| 取消旧查询、关闭停读、失败重试、返回位置 | 共享搜索及 Watch 控件回归；通过 |
| 保留创建、维护、实时开启、冲突和脏表单 | `mobile-data-workflow.browser.cjs` 的14组流程；通过 |
| 外汇/黄金/crypto、managed、MWH、MWC 跨日 | `test_sparkline_rollover.py`、既有 session/sparklines 测试；通过 |
| NY17、UTC0、source_date/DST | 后端窗口及不可变 manifest 日界线测试；通过 |
| 普通收盘、提前收盘、缺证据、午夜和下一开盘 | 日期证据解析、时段/跨日单测及浏览器定时；通过（来源夹具） |
| 只有一个本日点、稀疏缺口、当前粗周期优先 | 后端选择与前端曲线测试；通过 |
| 缺真实开盘价、蓝线不接报价、旧固定版本日期 | 单测及 session 截图；通过 |
| 空成功、失败/恢复、prepare 并发/去重/退避、迟到响应 | Node loader、session/Watch 浏览器回归；通过 |
| 修订轮换 fence、来源账户隔离、回收/损坏错误 | 后端 active revision 切换、来源/回收/校验和及前端 MWC unavailable 用例；通过 |
| batch 只读与有界读取 | 无表写入/任务增长断言；20原生≤120 SELECT，MWH+MWC≤30 SELECT；通过 |
| 375/412、深浅、150%字号、已认可主体几何 | 搜索及 session 字体矩阵、自选8组布局；已实际看图，通过 |
| Ubuntu 本任务服务/源码一致、真实旧数据回显 | 下节运行镜像、源码哈希、实际响应与截图；通过 |
| Android 系统键盘、返回键、实机手势 | **待用户真机复核，未以浏览器测试代替** |

## Ubuntu R1 与真实环境

主机：Ubuntu `quant-server` 本机 Docker；project/task `mw-managed-live-rollover-20261113`。复用现有数据库、网络、卷、端口和凭据，仅更新本任务 API/web；未重启其他任务或新建 worker。磁盘约47GiB、可用内存约4.6GiB；构建完成后结束构建负载，更新既有服务未增加常驻配额。

- 自选：<https://192.168.7.232:18447/m/watch>
- 数据：<https://192.168.7.232:18447/m/data>
- 受管 BuildKit：`mw-docker build`，显式 repo/context/file/task/project/purpose。主机已安装工具的 web 默认 context 与当前 Dockerfile 不符，首次尝试失败后改为仓库根 context；最终完整构建通过，未用直接 docker build。
- API：`market-watch-api:mobile-pending-20261114`；实际 image ID `sha256:a35ffd70b195b13df0b285f764a4e3fcec29d4e5c9d9f52f9028090b61807923`。
- web：`market-watch-web:mobile-pending-20261114`；最终实际 image ID 记录于 `runtime-proof.json`。
- 镜像标签基线 `113e0397`、dirty=true；运行代码以文件SHA256及资源指纹核对，非声称镜像来自后续文档提交。
- `/readyz` 200；在线 JS/CSS SHA256 与本地最终 dist 一致；容器中实际导入的三个后端模块 SHA256 与工作树一致。
- 真实固定 EURUSD `MWH:fd00e425-53a2-4de2-bad3-4c8239b092ef` 回显1439点，原生 OANDA GBPUSD最终核对回显1435点（先前初次回显308点，prepare 后补齐）；两者显示窗口早于当前目标窗口，均 `previous=true`，页面可见蓝色曲线。修复前两者存在旧数据但为空。
- 两页打开搜索、读取真实目录、关闭返回及深浅截图通过，无页面异常；未执行加入/创建/排序/删除。登录秘密仅从私有文件读入内存，不存储浏览器认证状态。
- 本任务 Yahoo 保持原有禁用配置，本轮**未连接真实 Yahoo 验收提前收盘**；该分支由真实传输包装的单测、来源元数据 fixture 和浏览器边界测试验证。缺时段证据如实 unknown，不宣称完整节假日日历。

启停使用现有私有脚本：

```sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

`run.json` 固定实际镜像ID，`compose.json` 保留任务tag。原配置私有备份为同目录 `run.json.before-mobile-pending-20261114` / `compose.json.before-mobile-pending-20261114`，旧API/web镜像保留；需要回退时先按仓库异常规则核对，再恢复两配置、仅重建本任务API/web。不涉及数据库迁移或数据回滚。本轮未执行回退或资源退役，等待真机验收期间实例保留。

## 截图证据

- `before/`：旧操作入口和搜索截图。
- `search/`：本次共享搜索375/412、主题和字号样本。
- `geometry/`：已认可自选主体的布局回归样本。
- `fixture/`：普通/提前闭市、首个本日点、古老固定版本及大字号。数据为明确 fixture。
- `ubuntu/`：本任务真实数据，自选深浅、两页搜索和数据主页。
- `runtime-proof.json`：资源、模块及镜像指纹与脱敏实时响应摘要，不含凭据。

用户已收到验收地址及真机复核请求；未收到设备结果前，不标记整项目标完成。
