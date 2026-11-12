# PR #134 优化收口与开发部署（2026-11-12）

## 范围与分类

用户接受现有 CPU 优化，要求先查看一次 CI、修复发现的问题、统一更新 PR，部署当前候选到 Ubuntu 开发实例；更新后不追踪 CI。本轮只改测试、CI 诊断参数和文档，分类 P0，选择本人自审、针对失败的本地复现及分段后端回归。原优化的重要持久化/worker 改动仍属 F1，既有独立 Standards/Spec review、隔离 PostgreSQL 并发/兼容性和固定输入回放证据见 [pricing 验收](pricing-optimization-evidence-20261112.md)。本轮未新增运行时代码、schema 或持久格式变更。

## 初次 CI 快照与修复

2026-11-12 10:56:18 UTC，PR head `a704ccdb`，run `43203215512`：Classify、Web、Compose 成功，Backend 尚在执行。上一轮 `43192599810` 的后端在已有测试失败后耗尽 30 分钟而取消，原 `-q` 输出未及时显示 traceback；不把取消当成通过。

- Python 测试采用 `-q -x --tb=short -o faulthandler_timeout=60`，尽早显示首个失败及长测试线程栈，保留原必需检查及超时门槛。
- 兼容性测试显式启用其需要的旧独立品种，不改变退役后的生产默认值；私有 SQLite/MCP 和 PostgreSQL fixture 都按实际前提建库。
- history worker 测试改用实际 `Event.wait` 停止点，避免拦截已移除的 `time.sleep` 后跑成无限循环；聚合空闲等待断言同步到 30 秒。
- retention 健康测试检查 16/60 秒内无误报、90 秒后仍能识别停止工作的线程。
- 暂停规则不应取消用户显式开启的实时组合：SQLite/PG 合约同时验证保留当前头、释放旧修订，以及去掉独立订阅后两条暂停规则不再保留需求。

所有实质失败均先在本地复现再调整测试。没有为通过测试恢复旧独立采集，也没有放宽行情持久化或告警断言。

## 本地验证

后端当前共收集 **3,924** 个用例。按首个失败逐段修复并从相应文件续跑，以 verbose node ID 去重核对当前集合：**3,923 个通过，1 个跳过，无遗漏、无未解决失败**。这是多次分段回归覆盖，不是一次完整干净运行，重叠次数不相加。

唯一跳过是 `test_postgres_dump_restore_of_signal_and_outbox`，本地未设置 `TEST_POSTGRES_BIN_DIR`；CI 同样未设置该可选变量。本轮开发备份只做可读目录验证，不宣称完整恢复。

- Ops：**111 passed / 93 subtests passed**。
- Ruff：PR 全部变更 Python 文件通过；`git diff --check` 通过。
- 本人自审：本轮差异仅测试/CI/文档；PG fixture 与 SQLite fixture 的开启前提一致，停止点覆盖实际调用路径，健康和订阅测试同时覆盖正常与过期/释放情形。没有降低必需 CI gate。
- 任务测试 PostgreSQL `mw-idle-v2-20261112-postgres-1` 已停止，保留 volume；其他项目未操作。

私有证据目录：`~/.local/share/market-watch-dev/updates/closeout-20261112/`。`local-coverage.json` 为去重汇总，原始分段日志在相邻 `pricing-v5-20261112/ci-closeout-*.log`。

## 开发候选与部署

实际主机为 Ubuntu 本机 Docker，Compose project `mw-dev`，地址 https://192.168.7.232:18443。启动 `mw-dev up`，停止 `mw-dev stop`，状态 `mw-dev status`。

- 镜像：`market-watch-api:dev-idle-closeout-20261112`，ID `sha256:2c2e121d25e92deebe5a77153d04f39370c70b7f2587de71ae0ec5464b6ae61a`。
- 构建提交：`b803f05d63c4f52f5de9e166ee05e0237cda5b9b`，`dirty=false`；通过 `mw-docker build` 标注 task/project/purpose。之后的 PR 提交仅添加本验收文档。
- 四个后端均已核对为同一镜像；无后端源代码挂载；迁移退出 0；Web 静态镜像保持现有已验收版本。
- 切换前保留旧镜像/配置，完成 `dev-20261112T110955339114Z.dump`，**1,560,891,823 字节**，`pg_restore --list` 可读；未执行全量恢复。
- 切换初期 OANDA 流曾返回 HTTP 401，三条流自动进入鉴权保护；同一配置的 accounts/summary/stream 有界直接探测均 HTTP 200。未更改凭据、未清库、未跳过保护；正常 300 秒鉴权探针成功后自动恢复连接并补齐确认数据。
- 最终 `/readyz` ready，**38 个 runtime role 健康，3 条实时流 connected+ready**，接收年龄约 1 秒；六个供源各读取 40 根 K 线，**27 项组合/周期读取**均有数据，**42 个 MCP 工具**、SSE、通知流、ntfy 和静态资源通过。
- Chromium 登录后 **5 张图表显示数值、数据中心 50 行、零 page error/失败资源**，浏览器检查后关闭。旧 `frontend` 容器为已停用的源码开发模式遗留，当前由正常运行的 `web` 提供网页，未启动额外前端服务。

本轮不重新开启 CPU 优化或性能采样；用户已接受的 CPU 数据、相同输入回放效果及 28% 报价数量差异的解释保留在 pricing 证据文档。更新后不查询/追踪 CI，也不宣称最终 CI 通过。不合并、不打正式 tag、不操作生产。
