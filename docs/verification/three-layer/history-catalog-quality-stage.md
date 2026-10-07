# 第二层目录、覆盖事实与请求记录阶段验证

日期：2026-10-06。Ubuntu 独立 Compose project `market-watch-three-layer`，
工作树 `market-watch-data-integration`，分支 `feat/market-data-integration`。
本记录覆盖第二层新增能力；没有宣称组合源、策略或三层整体验收完成。

## 行为

- 来源目录读取无注册或实时需求副作用。Dukascopy 使用锁定 SDK 的准确代码和类别；
  SDK 未提供精度时要求明确填写，不把手工精度称为已核实。OANDA 显式刷新当前 Practice
  账户目录，继承来源精度；账户范围隔离，搜索无结果不误提示目录未刷新。
- 自建账户目录与旧平台 ID 隔离，旧目录刷新不覆盖自建目录；旧平台路由拒绝自建目录 ID。
  重复创建先按固定请求取回任务，不依赖后来变化的目录；兼容旧清单缺少可选 catalogue 字段。
- 覆盖按所选固定版本的有限来源会话依据区分观测、未知、已证实闭市及证据冲突。
  NY17 相位和空响应都不能证明闭市；观测与闭市依据冲突时保留价格并报告冲突。
- `ad31_history_read_attempts` 持久记录版本的有界 M1 读取：来源请求、共享缓存、父版本复用，
  以及失败、结果未接纳、等待共享读取和进程中断。重试成功不抹去早先失败。
  请求失败区间与最终缺口是两条事实轴，不能相加作为未知分钟分母。
- 读取前记录开始事实；崩溃恢复的旧读取结果标为未知，不虚构超时或成功。
  完成记录不可原位修改或删除；新发布清单固定证据摘要与校验和。
  旧发布版本不补造日志，不把无日志认定为无失败。回收价格保留请求记录。
  公开审计 ID 不暴露活跃 worker 的 fencing token；异常仅保存安全类型，不存响应或异常文本。
- 8 个只读 `history_*` MCP 工具复用网页业务函数，要求 `market:read`；
  不下载、修改维护、建立订阅或删除。只读工具不是完整三层 MCP 集成的替代。

## 实际环境与启停

访问：<http://127.0.0.1:16629/market-data>。API `/readyz` 实际健康，独立 PG14 已升级 ad31。
旧 port16589 观察项目未更新。新项目 stream、居民品种和通知投递关闭。
启停在工作树根执行；环境文件是 ignored 本地文件，不提交凭据。

```sh
sg docker -c 'docker build -t market-watch-three-layer:dev -f docs/verification/three-layer/Dockerfile .'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml run --rm migrate'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml up -d api history-worker web'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml stop api history-worker web'
```

启用 MCP 时旧基础镜像缺依赖，API 退出；新任务镜像按 requirements.lock 补齐依赖后恢复健康。
没有在运行容器手工安装或修改旧观察镜像。浏览器初次缺 Ubuntu 动态库，使用既有本地
`LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu` 后实际启动通过。

## 证据

- 目录、创建重试及日界 22 项；原平台兼容 78 项；MCP/目录/覆盖/图表组合定向 94 项通过。
- 请求证据、不可变性和回收定向 21 项通过。首次两项断言捕获方式错误已修复后重测。
- 实际 PostgreSQL 请求证据/迁移/目录重试/维护/周期/回收 30 项通过，包含崩溃恢复与竞态。
- 本批全量 831 passed / 97 skipped / 33 warnings，244.87s；审计 ID 脱离租约 token 的最后变更
  另有请求证据/导入本地 10 项、实际 PG 6 项定向通过，不将之前全量称为覆盖最后变更。
- 真实 OANDA EURUSD 最后 20 分钟复查产生新固定版本，2 条记录分别为来源请求、父版本复用。
  原发布清单逐项相等；实际复查不注入假供应商错误。失败/恢复的证明来自独立 PG 故障测试。
- 原有真实 Dukascopy 黄金、OANDA 欧元/黄金创建提交 ID 重试保持原固定任务，M1/H4/D1读取通过。
- 真实 HTTP/MCP 8 工具输出与网页 API 逐项相等；固定版本分页与不可用错误通过。
  测试前后实时需求均为 0，验收凭据已撤销。
- 实际 Chromium 精度必填、账户显式刷新及空搜索、覆盖固定版本、请求记录、
  1024/1440/1920 桌面宽度通过；pageerror 为空，只有登录和目录刷新写请求。
- TypeScript/Vite、改动代码 Ruff、diff 空白检查通过，已有主 bundle 体积提示仍在。

脚本：[`verify_history_request_evidence.py`](../../../scripts/verify_history_request_evidence.py)、
[`verify_history_center_mcp.py`](../../../scripts/verify_history_center_mcp.py)、
[`data-center-catalog-real.browser.cjs`](../../../web/tests/data-center-catalog-real.browser.cjs)。
原始 JSON、截图和日志位于 ignored `artifacts/data-integration`，包括
`history-center-full-regression.log`、`history-center-postgres-final.log`、
`history-request-real-supplier.json`、`history-center-mcp-real.json`、`history-center-catalog-real.json`。

## 剩余范围

第二层业务搜索接入、回测统一周期输入清单及维护写入 MCP 仍需与整体入口一起完成。
第三层映射、幂等首次使用、固定历史和接缝、尾部修订、共享需求、图表、策略依赖与预警
仍未交付；第一层 Dukascopy 原生适配与完整缓存语义、整体桌面/负载及质量观察继续推进。
本批阶段通过不代替完整 A–E 验收。未推送、未 PR、未生产部署、未下单；MT4 继续延期。
