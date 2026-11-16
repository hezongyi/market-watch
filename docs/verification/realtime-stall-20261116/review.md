# 修复审阅与验证范围

分类：F1，共享实时采集、恢复和分钟确认重要后台链路。没有 schema、迁移或价格持久格式变更。

## 本次改动

- `live_pricing.registered_stream_identities` 只复用同账号、环境、bid、日历和完整 key 的已登记身份。
- stream 启动不再依赖可用性有问题的 REST 目录；新账号/日历仍须先完成真实目录登记。
- stream 认证暂停使用有限流探针恢复：所请求品种必须全部出现真实 PRICE，心跳、EOF、缺品种和其他身份均不能解除暂停；探针报价不发布，finally 关闭流。
- REST 401/维护仅影响 stream 模式的确认健康与确认重试，不阻断报价。真正 stream 401 仍使用既有账号暂停、租约和五分钟退避。
- rest_batch 模式保留账号级暂停。旧测试明确区分了 REST 采样与独立 stream 采样。

## 自动验证

- 首轮新增回归在旧代码上 6 failed / 4 passed，实际捕获 REST 故障阻断报价、无法恢复、重启依赖目录。
- 修复后 SQLite/接口/生命周期/确认健康：132 passed，12 skipped（对应 PG 参数，另行运行）。
- PostgreSQL：33 passed，包括新测试的12项PG参数、竞争所有者与被替换探针隔离、401→503→真实流恢复、闭市无请求风暴。
- REST batch/价格告警/组合报价消费回归：180 passed，36 skipped（既有条件型测试）。
- Ruff 和 git diff --check 通过。

PostgreSQL URL 从当前任务私有 test-env 注入，仅在 `rollover_test` 的随机 schema 运行；未使用手机验收数据库运行测试。

## 独立评审

依 AGENTS.md 对 F1 做 Standards / Spec 两项只读独立评审。
Standards 未发现阻断问题。Spec 初审指出首次登记分支可能只凭 REST 成功解除暂停，及缺少持续心跳的期限测试；两项均已修复/补测，增量复核通过。

## 部署与回退

仅替换 Ubuntu 当前任务 api / market-runtime / data-worker，镜像固定为 deployment.json 中 digest；web、APK、DB、volume 保留。不操作其他端口或 Unraid。
私有旧镜像引用及配置保存在本任务 `stream-recovery-20261116-backup/`；回退时恢复两个 JSON 并只 recreate 三个后端服务。无 schema 变化，现有数据格式不变。

实际恢复与持续观察结果见 recovery-observation.json；进程存活或单次探针成功不等同于验收通过。

最终只读浏览器复核：三个自建品种的屏幕价格均在五次采样间发生更新，订阅全部 HTTP200，无页面异常。第一次浏览器脚本误拦截只读 resolve 已修正；最终证据不包含该误判。
