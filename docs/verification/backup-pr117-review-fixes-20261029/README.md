# PR #117 修复与复核

分类：F1。新增完成标记属于兼容的持久化产物；轮转涉及恢复点删除边界。无 schema 迁移。

基线：初次审查 head c77cefa5337de90a5b8fb37673a3b64985126c7b。
最小检查：真实 shell 回归、备份单测、旧产物兼容、Ubuntu 独立 PG14 导出/恢复、两条独立复核与 PR CI。

## 四项修复

| Finding | 修复 | 检查 |
|---|---|---|
| R1 负数保留值删光备份 | 删除前同时验证两项 keep；拒绝负数、空串、非数字、前导零、超长值 | 每种非法值均不得删除任何系列 |
| R2 发布配置被轮转 | 新日常配置使用 config-daily-*；所有旧配置归档保留 | 实际发布文件名 config-20261028T150906Z-XgDEue.tar.gz 及校验文件保留 |
| R3 不完整文件挤掉有效恢复点 | 写完清单/校验后才生成 .complete，只统计已完成普通文件 | partial、缺标记旧 dump 不占保留名额、不删除 |
| R4 restore 非零退出丢失阶段 | pg_tool 非零异常附带 stage | CLI 失败输出、临时库清理、脱敏 |

独立复核另发现空 dry-run 输入被当作 0：已改用“仅未设置时默认 0”，空串和非法值均拒绝删除。
轮转回归分别由 dash/BusyBox 执行；真实配置归档测试使用宿主 sh/GNU tar，明确不验证 BusyBox tar 对 GNU 参数的支持。

## 本机验证

- 主机：Ubuntu 本机 Docker。
- project：mw-pr117-fix-20261029；独立网络、独立凭据、tmpfs 数据目录，无共享数据库。
- 地址：127.0.0.1:25417，仅本机 PostgreSQL，无网页服务。
- PostgreSQL：14.24，server_version_num=140024；客户端14.24。
- 完整 test_backup.py：**13 passed，无 skip**，包含真实导出/恢复及业务载荷核对。
- shell 回归：dash / BusyBox 各 **112 passed, 0 failed**。
- Ruff、git diff --check：通过。
- CLI 实测：完成审计、完成标记0600、102表计数一致、旧无标记备份可恢复。
- 损坏归档真实 pg_restore：verified=false,error_type=RuntimeError,stage=pg_restore，临时库剩余0。
- CI已加入两种shell轮转回归，最终远端结果以本次head的Actions为准。

隔离实例定义与测试凭据只保存在 /tmp/mw-pr117-fix-20261029/，不提交。
启动：docker compose -p mw-pr117-fix-20261029 -f /tmp/mw-pr117-fix-20261029/compose.yaml up -d --wait。
停止：docker compose -p mw-pr117-fix-20261029 -f /tmp/mw-pr117-fix-20261029/compose.yaml down。
tmpfs仅含测试生成数据；已实际dump并恢复验证，结束后按精确project停止容器/网络，保留本证据。

## Standards

独立复核通过：没有新增明确规范违反或有实际维护成本的 smell。
负数与空 dry-run 参数均在任何删除前拒绝；旧归档、完成边界和工具依赖明确。
独立执行 dash、BusyBox 均112通过。

## Spec

独立复核通过，无新增发现。
原四项及复核追加的两项均闭合；旧清单恢复兼容，GNU tar覆盖边界如实记录。

Standards 0项；Spec 0项；生产脚本安装、合并和发布尚未执行。
