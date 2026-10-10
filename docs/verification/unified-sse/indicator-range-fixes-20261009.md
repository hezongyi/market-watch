# 指标与加载范围开发验证

Ubuntu worktree，本机 SQLite/Python/Node；不是 Docker 实例或真实浏览器验收。

## 已运行的失败信号

- `PYTHONPATH=backend .venv/bin/pytest -q --tb=short backend/tests/test_market_stream.py -k indicator_only`：指标最新值由 1.1 改为 1.2、OHLC 不变时，修复前 `bars=[]`，预期 `[120000]`。发布只比较价格，原生指标接口无法生成回调。增量比较包含指标系列各时间的值，并附带对应权威柱；修复后通过。
- `.../test_market_stream_worker.py -k previously_streamed`：首次 HTTP 尾部之后追加两柱，再修订第一根追加柱，修复前输出 `bars`，预期 `reset:history_changed`。消费范围停在首读边界导致修订被过滤；投递边界及其 next_revision 随实际追加推进，事件携带加载范围和输入凭据供重连。测试含同世代重新注册及新连接游标，修复后通过。
- `node tests/advanced-provider-subscriptions.cjs`：修复前重连 `loaded_before` 为 undefined，预期 12000。传输现在保留事件的 loaded_before/history_revision/initial_input_revision；修复后通过。
- `.../test_market_stream_worker.py -k historical_window`：推进实时前缀凭据的实现曾让固定历史窗口在多次尾部追加后错误 reset。历史窗口使用原固定边界的修订戳；新增测试验证四次尾部追加不 reset、窗口内修订仍 reset，修复后通过。

## 当前验证

完整统一订阅检查：120 passed、12 skipped，输出 `unit-tests.txt`。既有 provider_service/market_data/managed_dataset/fixed_indicators 回归：105 passed，输出 `regression-tests.txt`。12 个 PostgreSQL gates 因无 TEST_POSTGRES_URL 跳过，不算通过。

`advanced-fixed-indicators.cjs` 的 Python fixture 使用 Calculator、持久任务、indicator worker 完成固定历史 EMA，再生成真实 completion reset；Node bridge 使用该事件执行 reset/getBars/接受新历史，验证缺失值不伪造成价格，准备完成值进入原生数据回调。跨两个客户端初始化只创建一个指标 run 的后端测试通过。

Node SSE、订阅重连、固定身份、指标初始化、Python 指标适配、managed 首读及显式轮询回退测试通过。web TypeScript/Vite 构建通过（保留已有 chunk size 提示）；Ruff、bridge syntax、diff check 通过。

日历证据失效检查确认绑定数据集的 profile 不允许原地修改，仓库现有 immutable identity 约束要求新版本；未为了缓存测试绕过该约束修改业务代码。

Ubuntu Docker 仍返回 socket permission denied，sudo 非交互不可用。真实 PostgreSQL、多进程、供应商、许可浏览器以及 P95/SQL/CPU/内存验收继续等待本机权限；任务未完成。
