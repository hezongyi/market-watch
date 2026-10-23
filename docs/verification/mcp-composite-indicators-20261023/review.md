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

待补证据：PostgreSQL 本机隔离检查、真实 Ubuntu R1 和最终证据提交。
这些未完成项不会用现有 SQLite/TestClient 通过或镜像构建代替。
