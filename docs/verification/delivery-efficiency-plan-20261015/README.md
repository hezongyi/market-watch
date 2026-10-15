# Ubuntu 轻量验收与任务 PG 复用验证

关联 [Issue #68](https://github.com/hezongyi/market-watch/issues/68)。变更级别 F0：Ubuntu 运维入口，没有应用/生产 schema 变更。采用工具回归、Compose 展开和两套真实 Ubuntu R1 smoke；未使用生产备份或 Unraid 验收实例。

## 范围与状态

- [resource-baseline.json](resource-baseline.json) 是 09:32–09:38 UTC 的历史只读盘点，保留原始时间和范围，不代表实施后的实时状态。
- [preview-smoke.json](preview-smoke.json) 是后续获授权实施的脱敏证据，包含 project、实际镜像 ID、PG/schema、fixture 行数、资源余量和逐项断言。
- 已实现 `preview prepare/up/status/stop/reset`；不实现槽位、队列、租约或心跳。
- 不修改生产，不删除既有资源，不覆盖主机安装版 `mw-docker`。安装版 SHA 仍为 `29ae5bb0c449edd294e501dab26b234b9ec4859a5bbd01928943e93bc6c4bdad`，保留其 OCI 缓存优化。

## 检查结果

```bash
python3 -m ruff check deploy/ubuntu/mw_docker.py deploy/ubuntu/mw_preview.py \
  deploy/ubuntu/d1_seed.py tests/ops/test_preview.py
PYTHONPATH=backend /tmp/mw-jit-test-venv/bin/python -m pytest -q tests/ops
bash -n deploy/ubuntu/install.sh
git diff --check
```

工具回归：**83 passed，47 subtests passed**；Ruff、shell 语法和差异空白检查通过。临时解释器是本机已有测试环境；CI 使用 `requirements.lock` 安装依赖，并已加入 ops 回归步骤。

自审修正了两项真实部署问题：internal 网络上的 published port 无法从主机访问，改由 64 MiB 网关连接 internal/edge 网络；停止网关后短暂的 TCP TIME_WAIT 被误报为占用，端口探测增加 SO_REUSEADDR，同时用真实 socket 回归证明仍拒绝活动监听者。补充共享卷、共享网络、后端误接 edge、固定 Nginx 实际 ID/digest、迁移及 seed 失败路径检查。

实际 Docker 验证通过：

1. 两套 project/PG 容器、volume、网络、端口和凭据不同；各自测试 Preference 不串库，主机 `/readyz` 和真实登录均成功。
2. A stop/up 后 PG 容器、volume、凭据和测试写入不变；seed 复用而不覆盖数据。
3. reset 默认预览不改私有文件；显式 apply 新建数据库，新库无旧测试写入、旧库仍有原写入，PG 容器、volume 和凭据保持。
4. A stop/up/reset 不改变 B 的容器、PG、凭据和测试写入；B 保持可访问。
5. PG 实际 `140024`，JIT provider 可用；连接策略 inherit；每个库含 5760 candles 和 5760 published bars，全部 instruments 禁用外部采集。
6. API/PG 只接 internal 网络，API 无默认出网路由；网关只将入口绑定 `127.0.0.1`。逐服务 Docker 配置有 CPU/内存限制和 `10m × 3` 日志轮转；API 容器内实际 `memory.max=536870912`、`cpu.max=30000 100000`。
7. 在 A 自己的 PG 中另建恢复库，实际 `pg_dump -Fc`/`pg_restore --exit-on-error`；对所有非系统表比较精确行数和按 C 顺序排序的行 JSON SHA256，全部一致。dump 与恢复库保留，不删除。导出及比较期间只停 A 的 API，B 继续服务；完成后 A 重新启动并通过登录。

首次恢复比对在 A API 运行时发现 `preferences` 内容变化。修正验证步骤为先停本任务写入者，再导出与比较；未把动态源库差异当作恢复通过，也未因此修改应用代码。备份和完整检查只能证明对应恢复点，不能拿运行后变化的数据强行与旧 dump 比较。

## 实际运行地址与操作

运行主机：Ubuntu `quant-server` 的本地 Docker socket；不是 Unraid 或远端 SSH 转发的服务。

| project/task | 地址 | profile |
| --- | --- | --- |
| `mw-delivery-r1-20261015` | `http://localhost:18861` | API-only R1 |
| `mw-delivery-r1b-20261015` | `http://localhost:18862` | API-only R1 |

入口仅绑定 Ubuntu 回环，不是完整 UI。私有登录信息在各 task 的 `credentials.json`，没有提交密码、cookie、env、完整 inspect、私钥、dump 或生产数据。两个镜像均为本任务 acceptance 构建，来源 `dfa0568` 工作树、dirty=true；不作为正式发布候选。

从本工作树运行（将 `TASK` 替换为上表的精确 project/task）：

```bash
python3 deploy/ubuntu/mw_docker.py preview status --task TASK --project TASK
python3 deploy/ubuntu/mw_docker.py preview stop --task TASK --project TASK
python3 deploy/ubuntu/mw_docker.py preview up --task TASK --project TASK
```

stop 不删除数据。旧库、恢复库和私有 dump 保留到合并审查/任务退役；retire 默认只预览，实际删除仍须遵守仓库数据授权和归档恢复规则。本轮没有执行 `retire --apply`。

## 已知限制与后续

此次只交付 S1 的 API-only 最小路径，不宣称整体方案或 S1 全部目标完成。UI/worker 只做 Compose 展开；没有完整业务链、30 分钟双实例稳定性、十次启动 p95、生产规模 R3、删除闭环或性能提升结论。固定 D1 生成器是小型 smoke 数据，不是完整交易日历/实时健康或不可变 dump 基线库。

reset 保留所有旧库，重复操作会增长磁盘；没有一键切回旧库。现有 ops.lock 仅串行执行工具资源变更命令，两个已启动实例可以同时验收；不自动预留或调度资源。主机安装版与主线的 OCI 缓存优化对齐、release 镜像消费保护、图表运行时地址和生产发布计时，属于后续 S0/S2/S3。
