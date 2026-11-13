# 手机数据页：实施与验证记录

日期：2026-11-13。状态：**本地实现与夹具验证通过；真实供应商、Ubuntu Docker 与 Android 真机验收待完成**。

## 范围与基线

- 分支：`feat/mobile-data-workflow-20261113`。
- 基线：`v2.0.11` / `e1d3cd8de3c76d6eba20b1ffeb820cd39f932d71`。
- 工作树：`/home/quant/repos/market-watch-mobile-data-workflow-20261113`。
- 原始要求与接口依据：[全流程方案](../../mobile-data-workflow-plan-20261113.md)。该文保留初始规划语态，本记录说明实际进度。
- 风险分类 **F0**：手机端增加现有写接口的操作入口，后端兼容增加摘要任务状态；不改 schema、行情身份、后台采集规则或持久协议。最小验证选择本地构建、相关后端用例、浏览器交互/截图和待执行 Ubuntu R1 smoke。

## 已实现的常用流程

1. 数据主页仅显示自建行情。原生行情收进右上角“搜索并添加行情”，列表保留轻量筛选。
2. 搜索并选择原生品种后，在同一个抽屉确认历史起点、维护周期和自动更新；其他设置展开后修改。点击“创建并准备历史”，返回并定位新行情。
3. 历史在后台准备，详情可查看进度、立即更新和调整维护设置。任务暂停/恢复/重试/取消、区间补数/复查、固定版本和归档放在次级入口。
4. 满足条件后，在详情开启实时。第一次核对 OANDA 来源、保存匹配并开启；已有有效配置直接复用。黄金跨来源差异保留明确确认。
5. 准备完成后打开图表或加入自选。实时已开启但尚未准备好时，禁止使用，不静默改用固定历史身份。

维护计划、当前任务和实时开关分别控制。服务端保存实时开启选择，不依赖手机页面持续打开；新历史发布也不自动替换已有接续的固定基线。

## 实现与控件清单

| 文件 | 实现范围 |
| --- | --- |
| `DataPage.tsx` / `DataManagedPage.tsx` | 独立自建主页、分页/定位、详情、筛选、任务与来源、归档、图表/自选衔接；共用自选搜索继续使用原 `DataContent` |
| `DataCatalogSheet.tsx` | 创建专用原生目录、来源/分类筛选、分页、目录刷新、Yahoo 精确代码补录；同层转创建确认 |
| `DataCreateSheet.tsx` | 来源能力探测、创建前检查、默认值、更多设置、重复检测、固定请求标识及响应丢失核查 |
| `DataMaintenanceSheet.tsx` | 计划、周期、时间、任务控制、区间补数/复查、版本；版本冲突保留输入并显式重载 |
| `DataContinuationSheet.tsx` | 已有配置选择、首次来源核对、黄金差异确认、保存与开启、部分成功与响应丢失核查 |
| `DataFormParts.tsx` / `dataOperations.ts` | 现有 Field/Input/Select/ToggleGroup/Collapsible/Alert 组合；有界管理请求、会话隔离快照、可见性轮询与同步提交锁 |
| `data-controls.css` | 页面作用域布局、深浅主题、小视口和大字号适配 |
| `dataset_summaries.py` / `history_maintenance.py` | 摘要增加 `maintenance.task_status`；两次批量读取复用详情状态规则，避免每行请求 |

抽屉、按钮、选择器、确认框沿用现有手机 shadcn/Base UI 封装，保留返回键、退出动画、未保存确认及减少动态效果约定。没有重新初始化组件库，没有修改自选 sparkline 或桌面图表加载策略。桌面维护表单仅导出现有纯函数 `tradingDate`，行为不变。

## 本地检查结果

以下记录来自本工作树最终应用代码。浏览器使用**实际构建产物 + 明确 HTTP 夹具**，不代表真实供应商或真机验收。

| 检查 | 结果 |
| --- | --- |
| `cd web && npm run build` | 通过 TypeScript、Vite 及许可图表 hooks/shell 检查；shell 指纹 `87b321e523535038` |
| 下列相关后端 pytest | **46 passed in 10.17s** |
| 三个改动 Python 文件 Ruff | 通过 |
| `git diff --check` | 通过 |
| `cd web && node tests/mobile-data-workflow.browser.cjs` | 通过；13 组场景、54 张截图；证据见 `workflow-proof.json` |
| `cd web && node tests/mobile-data.browser.cjs` | 通过共用自选搜索回归；证据见 `shared-search-proof.json` |
| `cd web && node tests/mobile-watch.browser.cjs` | 本轮通过；其后仅修正独立数据页细节，未改自选实现 |
| `cd web && node tests/composite-mapping.cjs` | 通过 |

后端命令（工作树根目录）：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_history_creation_check.py \
  backend/tests/test_history_maintenance.py \
  backend/tests/test_composite_matching.py \
  backend/tests/test_managed_continuation.py \
  backend/tests/test_dataset_summaries.py
```

浏览器覆盖：创建脏表单和返回确认；响应丢失后核查且不重复创建；计划冲突；任务暂停/恢复；实时匹配/开启响应丢失；黄金确认不可绕过；保存成功但开启失败后的重试；Yahoo 探测、创建及隐藏周期设置保留；重复创建和并发 409；探测失败/重试及原生周期顺序；多个映射默认值失效；归档恢复；缺少历史基线；实时准备中禁止使用；离线禁写和恢复；减少动态效果；开图后返回另一数据集时清理详情状态。

截图检查覆盖 375/412px、深浅主题、14/21px 字号的主页、详情、目录、创建和维护设置，并检查缩小视口、聚焦输入和底部按钮可达性。静态截图不作为 Android 系统键盘或真实拖动手感的证明。

### 代表截图

均为合成夹具数据，无真实账户和供应商凭据。完整 54 张截图由脚本产生，仓库只保留以下代表图：

| 画面 | 证据 |
| --- | --- |
| 主页 / 创建 | [主页](home-light.png) · [创建](create-light.png) |
| 详情 / 维护 | [详情](detail-light.png) · [维护](settings-light.png) |
| 深色大字号 | [主页](home-dark-large.png) · [创建](create-dark-large.png) |
| 实时核对 / 黄金确认 | [实时](live-confirm.png) · [黄金差异](gold-difference.png) |
| 小视口表单 | [聚焦与提交](form-small-viewport.png) |

## 未完成的真实验收与资源条件

本任务尚未创建 Docker project、网络、volume 或私有配置，未部署新服务，**没有本次改动的可访问预览地址**。既有旧版预览不能代表本次实现。没有构建新 APK、更新 PR/CI、合并、正式 tag 或生产部署。

Ubuntu 本机磁盘仍约剩 **13 GiB**。按照仓库 `AGENTS.md` 和 [Ubuntu 部署说明](../../../deploy/ubuntu/README.md)，API/UI R1 启动要求 ≥23 GiB，带 worker 要求 **≥26 GiB**，所以真实流程验收尚未启动。没有停止或删除其他任务资源；已向用户说明并请求协调空间。内存约 8.9 GiB 可用，当前首要限制是磁盘。

释放空间后，继续使用独立 task/project `mw-mobile-data-workflow-20261113`，独立端口、数据库、网络和私有配置，并通过 `mw-docker compose-build` 构建。记录实际 Ubuntu 主机、地址、启动/停止命令和检查结果后才能交付地址。

待执行的最小真实验收：

1. Dukascopy 普通 M1 Bid 自建：搜索、创建、实际发布、更新与任务状态一致。
2. OANDA Practice：核对当前账户、保存匹配、开启接续；离开数据页后仍收到服务端实时数据，明确关闭后停止对应需求。
3. XAUUSD：保留产品差异确认；检查真实价格精度和匹配结果。
4. Yahoo：目录/必要探测、历史创建、发布与计划保存；不支持实时时说明清楚。
5. 后续历史维护保持既有实时固定基线；桌面数据中心/维护/匹配基本回归。
6. Android APK：返回键、软键盘、安全区、抽屉拖动与实际网络恢复，再由用户协助真机验收。

实时能力仍受已有后端边界限制：需要已发布且非空 M1 Bid 和日界前历史基线，目前已核实 EURUSD、USDCAD、XAUUSD 到当前 OANDA Practice 的匹配。其他来源可创建维护历史，并不因此获得实时接续能力；同一历史 instrument 身份上的实时选择可能影响多个数据集。
