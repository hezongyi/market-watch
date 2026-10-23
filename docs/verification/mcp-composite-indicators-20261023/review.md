# 自审与完成审计

分类 F0。对照方案逐项审查默认/显式组合修订、输入选择时机、旧工具边界、错误/进度、展示模式和副作用。
没有新增 schema、持久格式、公式、固定任务状态、调度器或 MCP 工具。没有修改协议服务器。

已检查的实现不变量：

- `IndicatorsQuery` 单独扩大 series_kind；QuoteQuery/BarsQuery 仍只有 managed/provider。
- MWC 前缀要求显式 composite；修订字段在其他类型中拒绝；不开放快照/run 输入。
- handler 在共享读取前一次性预校验全部固定指标；取消、deadline、计算槽仍走 query_chart。
- `chart_data` 先检查组合权限，选择组合修订及确认输入，再读取该修订元数据。
  此后的价格查询传入明确 revision_id/input_revision，指标读取 page 的固定凭据。
- 临时模式用现有 display snapshot 选择输入，保留网页 live observation 强引用与锁顺序。
- 输出模型保留扩展字段；价格历史 checksum 来自已有 manifest；质量点不会被 Pydantic 丢弃。
- 组合不使用全 null 即报历史不足的旧逻辑；冷启动、重试、部分可读、预热 null 和稀疏信号均保留。
- 无网页 client/消费者租约，不创建组合/MarketDemand，不执行 supplier IO。
- 最新 main 的 observed_display_v1 逻辑保留；MCP 本次不开放输入策略字段，继续默认严格确认路径。

自审发现并修正：

1. 验证脚本的只读 scope 可见 24 个工具；完整权限集合仍是 31。增加运行真实协议的脚本集成测试，避免仅检查 JSON 形状。
2. 临时模式保留原网页强引用与 legacy handover 顺序；确认模式使用不可变输入过滤，不依赖 mutable live-state 锁。
3. 空价格准备状态、历史回收与容量错误明确区分，并测试坏的第二指标不会登记第一个任务。

4. 完整回归发现公共元数据入口的时钟推进契约被绕过，已让该入口接受固定选择并继续复用；原有实时报价到达用例与组合专项 21 项通过，未修改原断言。

源码 `9770d5d` 的完整远端 CI 39933990391 已通过：后端 2846 passed、18 skipped，
额外 PostgreSQL 映射迁移 1 passed、observed 策略兼容 8 passed，Web 与 Compose 检查通过。
完整本地运行未配置 PG 的 38 项设置错误按实际结果保留在 `results.md`，不写成通过。

2026-10-23 用户明确选择 `$mw-acceptance`。只读核对发现当前 API `2a943ee` 直接继承本任务 `9770d5d`；
运行文件 SHA256 与提交一致，因此无需重新换版。当前版本额外包含另一任务的 history 输入，不回退到旧候选。

真实 HTTP MCP 已证明新参数 EMA3/RSI3 pending→complete、7 根价格/14 个有效指标与网页同源，
默认/固定输入、MWC、UTC 分页、临时快照和 8 组错误均通过。数据集/版本/产物/工作区/偏好及组合/活动修订不变，
市场需求身份与目标不变，供应商取数和历史任务未增加。没有 seed/migrate/换版/重启或触碰保护浏览器。

本机 PG 验证在既有 PG 服务的任务专用数据库内执行，测试进程的所有数据库 URL 在应用导入前切换；
真实业务库不用于造样/迁移/修订切换。每项 fixture 又使用独立 schema，执行文件与本任务分支相同。

本机 PostgreSQL 四个文件最终 **70 passed、0 skipped、0 failed**，611.06 秒；临时 schema 清理后 public 无业务表。
15 服务的身份/镜像/重启次数、环境哈希、挂载、端口和网络保持。真实 HTTP 与 PG 证据见 results.md、mwa-acceptance.json、postgres-checks.txt。
无剩余实现或本机验收阻断；提交最后证据后核对对应 PR CI，不进行合并或生产操作。
