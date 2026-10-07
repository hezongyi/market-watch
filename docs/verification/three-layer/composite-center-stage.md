# 组合读取、数据中心与只读 MCP 阶段验收

日期：2026-10-07（Asia/Singapore）。分支 `feat/market-data-integration`，前置提交 `c572af6`。
本报告只证明本批公开读取和桌面管理流程，不证明完整 C/D/E 或长期质量通过。

## 实现行为

- 组合列表、候选、映射、详情、补数记录、固定输入图表共用领域模块，浏览读取不创建需求。
  候选核对固定 M1 基线及日界 T 前历史，历史不足显示原因，不开放错误的“可建立”操作。
- 明确保存映射校验当前 Practice 账户目录、准确代码、产品关系和 Bid 口径，保存本身无采集需求。
  `POST /api/market-data/composites/use` 才幂等首次使用并续订图表需求。
  重复打开旧组合为原固定基线补齐九周期任务，不移动基线或接续点。
- 图表先读取固定输入 M1 接续再聚合；接缝桶前复用固定周期产物。单页最多四个、每个最多
  32 天的 M1 分区，稀疏尾部用索引跳过无观测区间；月线每分区一桶。
  尾部空档不能漏掉仅有历史观测的接缝周/月桶。
- 固定组合修订和确认输入版本可显式指定；`before` 为 UTC 排他游标，结果正序。
  待派生历史周期明确返回 pending，不换基线、不扫描整段 M1，也不把空响应当历史边界。
  来源确认、时间结束、覆盖和跨源量分别返回，临时柱不混入明确指定的固定确认输入。
- 六个 `market:read` 工具：`composite_list`、`composite_list_candidates`、
  `composite_get_mappings`、`composite_get`、`composite_get_requests`、`composite_get_bars`。
  共享 HTTP 读取模块，工具不存在供应商采集或创建副作用。
- 数据中心已有候选/组合列表、独立映射页及组合概览/图表/接续与修订/使用与健康页。
  图表页每 60 秒续租，离开停止续租；同浏览器页复用 client，避免打开跳转重复需求。
  无策略时明确显示“暂无策略”，不会用流连接或图表可读冒充策略就绪。

## 实际运行环境及启停

Ubuntu 本机独立 Compose project `market-watch-three-layer`，独立 PostgreSQL 14、网络和 volume，
数据库迁移 `af33_composite_inputs`。API、history-worker、web 和 PostgreSQL 实际运行；
API readiness 健康。pricing-worker 在之前采集生命周期验证后停止，本批浏览器测试没有启动它。
访问：[数据中心](http://127.0.0.1:16629/market-data?tab=composite)。
旧观察项目 `market-watch-data-integration`、16589 端口和生产未变更。
凭据、env、登录、短期 token 和浏览器截图均在 ignored artifacts，不提交仓库。

从任务工作树启动默认管理服务：

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml up -d postgres migrate api history-worker web'
```

启动/停止需求采集（默认管理实例不自动启动）：

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime up -d pricing-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop pricing-worker'
```

停止本项目并保留数据库：

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop'
```

## 验证证据

- 实际 HTTP/MCP 六工具对照通过；固定 H4 输入和排他分页一致，不存在数据返回明确错误，
  组合定义与需求计数未改变。报价年龄按实际读取时间计算，因此只排除 `quote_age_ms` 做相等比较，
  来源时间、就绪状态及输入身份必须相等。测试凭据为一小时 `market:read`，完成后已撤销并删除。
  证据：`artifacts/data-integration/composite-center-mcp-real.json`；
  可复用脚本 `scripts/verify_composite_center_mcp.py`。
- 实际 Chromium 登录、纯列表与候选、当前目录准确映射保存、显式首次使用、真实 M1/H4 图表、
  接续记录和无策略健康通过，pageerrors 为空。映射页和四个详情页的 1024/1440/1920 宽度、
  200% 内容缩放、周期控件键盘焦点及下一操作验证通过。
  发现并修复周期控件可访问名称和画布撑宽网格问题，修复后重新构建并验收。
  证据：`artifacts/data-integration/composite-center-browser-real.json`。
  浏览器使用实际 OANDA→OANDA 固定组合，不冒称跨供应商验收。
- 定向验证含旧基线重新打开补派生、稀疏长尾、历史侧接缝桶、固定旧输入、待派生产物、
  权限、候选不足及无读取副作用。本地 13 passed / 11.65s；实际 PostgreSQL 13 passed / 40.93s。
- 前端最终构建、改动代码 Ruff 和 diff 检查通过。Vite 仍提示既有大 bundle；没有构建失败。
  后端最终全量 876 passed / 126 skipped / 213.42s；跳过项不视为通过，所需 PostgreSQL 用例
  已单独运行。日志：`artifacts/data-integration/composite-center-backend-regression.log`。

## 剩余交付

当前是有界分页，尚无持久长尾聚合物化；普通主图表、统一业务搜索和高级图表 bridge 尚未接入。
组合策略/预警、完整递归指标初始化与检查点、显式修订准备/激活、维护写 MCP、
Dukascopy 原生 adapter、统一固定周期回测输入、真实跨来源组合及 3–10 品种并发仍需完成。
实现验收和质量观察保持分开；本报告不启动或宣称完成新三层的 48 小时质量观察。
不推送、不提 PR、不部署生产、不下单；MT4 延后。
